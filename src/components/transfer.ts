// Recursive transfer engine shared by upload/download. Enumerates a selection
// (files + directory trees) into a flat job list, then runs the jobs serially
// with per-file conflict resolution and a final summary.
import type { FileEntry } from '../ipc/ssh';
import { joinPath } from './pathUtils';

export type ConflictAction = 'overwrite' | 'overwrite-all' | 'skip' | 'skip-all' | 'cancel';

export type Job =
  | { type: 'mkdir'; dst: string }
  | { type: 'file'; src: string; dst: string; name: string };

export interface TransferOps {
  /** List a source directory (to walk the tree). */
  srcList: (dir: string) => Promise<FileEntry[]>;
  srcSep: string;
  /** List a destination directory (to detect name conflicts). */
  dstList: (dir: string) => Promise<FileEntry[]>;
  dstSep: string;
  /** Create a destination directory (errors — e.g. "already exists" — are ignored). */
  dstMkdir: (dir: string) => Promise<void>;
  /** Transfer one file src -> dst (overwrites). */
  doTransfer: (src: string, dst: string) => Promise<void>;
}

export interface TransferSummary {
  files: number;
  transferred: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
}

export interface TransferHooks {
  /** Prompt for a name conflict; return the user's choice. */
  onConflict: (name: string) => Promise<ConflictAction>;
  /** Progress callback after each file (done = transferred+skipped+failed). */
  onProgress?: (done: number, total: number) => void;
  /** Polled before each file; return true to stop the batch (user hit cancel). */
  shouldCancel?: () => boolean;
}

function splitPath(p: string, sep: string): { dir: string; name: string } {
  const idx = p.lastIndexOf(sep);
  if (idx < 0) return { dir: '', name: p };
  return { dir: p.slice(0, idx) || sep, name: p.slice(idx + 1) };
}

/** Walk one top-level entry into mkdir + file jobs mirrored under `dstDir`. */
async function buildJobs(
  entry: FileEntry,
  srcDir: string,
  dstDir: string,
  ops: TransferOps
): Promise<Job[]> {
  const src = joinPath(srcDir, entry.name, ops.srcSep);
  const dst = joinPath(dstDir, entry.name, ops.dstSep);
  if (!entry.isDir) return [{ type: 'file', src, dst, name: entry.name }];
  const jobs: Job[] = [{ type: 'mkdir', dst }];
  let children: FileEntry[] = [];
  try {
    children = await ops.srcList(src);
  } catch {
    /* unreadable dir — treat as empty */
  }
  for (const c of children) jobs.push(...(await buildJobs(c, src, dst, ops)));
  return jobs;
}

/**
 * Enumerate `entries` (from `fromDir`) into `toDir` and run every job. Directory
 * trees are recreated; each file that would overwrite an existing destination
 * triggers `onConflict`. Returns counts for the summary line.
 */
export async function runTransfer(
  entries: FileEntry[],
  fromDir: string,
  toDir: string,
  ops: TransferOps,
  hooks: TransferHooks
): Promise<TransferSummary> {
  const jobs: Job[] = [];
  for (const e of entries) jobs.push(...(await buildJobs(e, fromDir, toDir, ops)));

  const total = jobs.filter((j) => j.type === 'file').length;
  let transferred = 0;
  let skipped = 0;
  let failed = 0;
  let cancelled = false;
  let overwriteAll = false;
  let skipAll = false;
  let done = 0;

  // Cache each destination directory's existing names (one list per dir).
  const dirNames = new Map<string, Set<string>>();
  const namesOf = async (dir: string): Promise<Set<string>> => {
    let s = dirNames.get(dir);
    if (!s) {
      try {
        s = new Set((await ops.dstList(dir)).map((x) => x.name));
      } catch {
        s = new Set(); // dir doesn't exist yet (freshly created) => no conflicts
      }
      dirNames.set(dir, s);
    }
    return s;
  };

  for (const job of jobs) {
    if (cancelled || hooks.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    if (job.type === 'mkdir') {
      try {
        await ops.dstMkdir(job.dst);
      } catch {
        /* likely already exists */
      }
      continue;
    }

    const { dir: dstDir, name } = splitPath(job.dst, ops.dstSep);
    const names = await namesOf(dstDir);

    if (names.has(name)) {
      let action: ConflictAction;
      if (overwriteAll) action = 'overwrite';
      else if (skipAll) action = 'skip';
      else action = await hooks.onConflict(name);

      if (action === 'overwrite-all') {
        overwriteAll = true;
        action = 'overwrite';
      } else if (action === 'skip-all') {
        skipAll = true;
        action = 'skip';
      }
      if (action === 'cancel') {
        cancelled = true;
        break;
      }
      if (action === 'skip') {
        skipped++;
        done++;
        hooks.onProgress?.(done, total);
        continue;
      }
    }

    try {
      await ops.doTransfer(job.src, job.dst);
      transferred++;
      names.add(name);
    } catch (e) {
      failed++;
      console.error('transfer failed', job.dst, e);
    }
    done++;
    hooks.onProgress?.(done, total);
  }

  return { files: total, transferred, skipped, failed, cancelled };
}
