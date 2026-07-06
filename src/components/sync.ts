// One-way directory sync (mirror), rclone-style: make the destination tree match
// the source tree — upload new/changed files (by size or newer mtime) and delete
// destination entries that don't exist in the source. Built on the existing
// list/mkdir/upload/remove IPC, so it works for local -> remote (SFTP) mirroring.
import type { FileEntry } from '../ipc/ssh';
import { joinPath } from './pathUtils';
import { pauseGate } from './transfer';

export interface SyncOps {
  srcList: (dir: string) => Promise<FileEntry[]>;
  srcSep: string;
  dstList: (dir: string) => Promise<FileEntry[]>;
  dstSep: string;
  dstMkdir: (dir: string) => Promise<void>;
  dstRemove: (path: string, isDir: boolean) => Promise<void>;
  doTransfer: (src: string, dst: string) => Promise<void>;
}

export interface SyncPlan {
  /** Relative paths of files to upload/overwrite (source newer or size differs). */
  uploads: string[];
  /** Relative paths of directories missing on the destination (depth-sorted). */
  mkdirs: string[];
  /** Top-level destination extras to delete (recursive covers their children). */
  deleteRoots: Array<{ rel: string; isDir: boolean }>;
  /** Total count of destination entries that will be removed (incl. children). */
  extrasCount: number;
  /** Files identical on both sides (skipped). */
  unchanged: number;
}

export interface SyncSummary {
  uploaded: number;
  deleted: number;
  unchanged: number;
  failed: number;
  cancelled: boolean;
}

export interface SyncHooks {
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
  shouldPause?: () => boolean;
}

const depth = (rel: string) => (rel.match(/\//g)?.length ?? 0);
const relParent = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** Recursively map a tree to relPath -> entry (relPaths always use '/'). */
async function walk(
  listFn: (dir: string) => Promise<FileEntry[]>,
  sep: string,
  root: string
): Promise<Map<string, FileEntry>> {
  const out = new Map<string, FileEntry>();
  const rec = async (dir: string, rel: string): Promise<void> => {
    let items: FileEntry[] = [];
    try {
      items = await listFn(dir);
    } catch {
      return; // unreadable dir
    }
    for (const it of items) {
      const childRel = rel ? `${rel}/${it.name}` : it.name;
      out.set(childRel, it);
      if (it.isDir) await rec(joinPath(dir, it.name, sep), childRel);
    }
  };
  await rec(root, '');
  return out;
}

/** Diff the two trees into an actionable plan (no side effects). */
export async function planSync(srcRoot: string, dstRoot: string, ops: SyncOps): Promise<SyncPlan> {
  const [src, dst] = await Promise.all([
    walk(ops.srcList, ops.srcSep, srcRoot),
    walk(ops.dstList, ops.dstSep, dstRoot),
  ]);

  const uploads: string[] = [];
  const mkdirs: string[] = [];
  let unchanged = 0;

  for (const [rel, e] of src) {
    if (e.isDir) {
      if (!dst.has(rel)) mkdirs.push(rel);
      continue;
    }
    const r = dst.get(rel);
    // Upload when missing, replaced by a dir, size differs, or source is newer
    // (2s slack absorbs filesystem mtime granularity differences).
    if (!r || r.isDir || r.size !== e.size || e.modified > r.modified + 2) uploads.push(rel);
    else unchanged++;
  }

  // Destination entries absent from the source are extras to remove.
  const extras: Array<{ rel: string; isDir: boolean }> = [];
  for (const [rel, e] of dst) if (!src.has(rel)) extras.push({ rel, isDir: e.isDir });
  const extraSet = new Set(extras.map((x) => x.rel));
  // Only delete top-level extras; a recursive remove handles their descendants.
  const deleteRoots = extras.filter((x) => !extraSet.has(relParent(x.rel)));

  mkdirs.sort((a, b) => depth(a) - depth(b)); // parents first

  return { uploads, mkdirs, deleteRoots, extrasCount: extras.length, unchanged };
}

/** Execute a plan: mkdirs, uploads (with progress), then deletions. */
export async function runSync(
  srcRoot: string,
  dstRoot: string,
  plan: SyncPlan,
  ops: SyncOps,
  hooks: SyncHooks
): Promise<SyncSummary> {
  let uploaded = 0;
  let deleted = 0;
  let failed = 0;
  let cancelled = false;
  const total = plan.uploads.length;
  let done = 0;

  for (const rel of plan.mkdirs) {
    if (hooks.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    try {
      await ops.dstMkdir(joinPath(dstRoot, rel.replace(/\//g, ops.dstSep), ops.dstSep));
    } catch {
      /* already exists */
    }
  }

  if (!cancelled) {
    for (const rel of plan.uploads) {
      await pauseGate(hooks);
      if (hooks.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const src = joinPath(srcRoot, rel.replace(/\//g, ops.srcSep), ops.srcSep);
      const dst = joinPath(dstRoot, rel.replace(/\//g, ops.dstSep), ops.dstSep);
      try {
        await ops.doTransfer(src, dst);
        uploaded++;
      } catch (e) {
        failed++;
        console.error('sync upload failed', dst, e);
      }
      done++;
      hooks.onProgress?.(done, total);
    }
  }

  // Deletions run last so a mistimed cancel can't remove before uploading.
  if (!cancelled) {
    for (const { rel, isDir } of plan.deleteRoots) {
      try {
        await ops.dstRemove(joinPath(dstRoot, rel.replace(/\//g, ops.dstSep), ops.dstSep), isDir);
        deleted++;
      } catch (e) {
        console.error('sync delete failed', rel, e);
      }
    }
  }

  return {
    uploaded,
    deleted: cancelled ? 0 : plan.extrasCount,
    unchanged: plan.unchanged,
    failed,
    cancelled,
  };
}

// ---------- Two-way (bidirectional) sync — C5 ----------
// Safe merge: newer-wins per file, NO deletions. Files only on one side are
// copied to the other; files on both are copied newer→older; ties are unchanged.

export interface BiSyncOps {
  localList: (dir: string) => Promise<FileEntry[]>;
  remoteList: (dir: string) => Promise<FileEntry[]>;
  localMkdir: (dir: string) => Promise<void>;
  remoteMkdir: (dir: string) => Promise<void>;
  upload: (local: string, remote: string) => Promise<void>;
  download: (remote: string, local: string) => Promise<void>;
  localSep: string;
  remoteSep: string;
}

export interface BiSyncPlan {
  uploads: string[];
  downloads: string[];
  mkRemote: string[];
  mkLocal: string[];
  unchanged: number;
}

export interface BiSyncSummary {
  uploaded: number;
  downloaded: number;
  unchanged: number;
  failed: number;
  cancelled: boolean;
}

export async function planBiSync(
  localRoot: string,
  remoteRoot: string,
  ops: BiSyncOps
): Promise<BiSyncPlan> {
  const [local, remote] = await Promise.all([
    walk(ops.localList, ops.localSep, localRoot),
    walk(ops.remoteList, ops.remoteSep, remoteRoot),
  ]);
  const uploads: string[] = [];
  const downloads: string[] = [];
  const mkRemote: string[] = [];
  const mkLocal: string[] = [];
  let unchanged = 0;

  const keys = new Set<string>([...local.keys(), ...remote.keys()]);
  for (const rel of keys) {
    const l = local.get(rel);
    const r = remote.get(rel);
    const lDir = l?.isDir ?? false;
    const rDir = r?.isDir ?? false;
    if (lDir || rDir) {
      if (l && !r) mkRemote.push(rel);
      if (r && !l) mkLocal.push(rel);
      continue;
    }
    if (l && !r) uploads.push(rel);
    else if (r && !l) downloads.push(rel);
    else if (l && r) {
      if (l.modified > r.modified + 2) uploads.push(rel);
      else if (r.modified > l.modified + 2) downloads.push(rel);
      else if (l.size !== r.size) uploads.push(rel); // tie on time, differ → local wins
      else unchanged++;
    }
  }
  mkRemote.sort((a, b) => depth(a) - depth(b));
  mkLocal.sort((a, b) => depth(a) - depth(b));
  return { uploads, downloads, mkRemote, mkLocal, unchanged };
}

export async function runBiSync(
  localRoot: string,
  remoteRoot: string,
  plan: BiSyncPlan,
  ops: BiSyncOps,
  hooks: SyncHooks
): Promise<BiSyncSummary> {
  let uploaded = 0;
  let downloaded = 0;
  let failed = 0;
  let cancelled = false;
  const total = plan.uploads.length + plan.downloads.length;
  let done = 0;
  const lp = (rel: string) => joinPath(localRoot, rel.replace(/\//g, ops.localSep), ops.localSep);
  const rp = (rel: string) => joinPath(remoteRoot, rel.replace(/\//g, ops.remoteSep), ops.remoteSep);

  for (const rel of plan.mkRemote) {
    try {
      await ops.remoteMkdir(rp(rel));
    } catch {
      /* exists */
    }
  }
  for (const rel of plan.mkLocal) {
    try {
      await ops.localMkdir(lp(rel));
    } catch {
      /* exists */
    }
  }

  const step = async (rel: string, dir: 'up' | 'down') => {
    await pauseGate(hooks);
    if (cancelled || hooks.shouldCancel?.()) {
      cancelled = true;
      return;
    }
    try {
      if (dir === 'up') {
        await ops.upload(lp(rel), rp(rel));
        uploaded++;
      } else {
        await ops.download(rp(rel), lp(rel));
        downloaded++;
      }
    } catch (e) {
      failed++;
      console.error('bi-sync failed', rel, e);
    }
    done++;
    hooks.onProgress?.(done, total);
  };

  for (const rel of plan.uploads) {
    if (cancelled) break;
    await step(rel, 'up');
  }
  for (const rel of plan.downloads) {
    if (cancelled) break;
    await step(rel, 'down');
  }
  return { uploaded, downloaded, unchanged: plan.unchanged, failed, cancelled };
}
