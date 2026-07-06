import { IS_TAURI } from './env';
import { translate } from '../i18n';
import { useStore } from '../state/store';

const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate(useStore.getState().settings.language, key, params);

export interface UpdateResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
  /** Direct download URL of the Windows installer (.exe), if present. */
  downloadUrl?: string;
}

function parseVer(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10) || 0);
}
function isNewer(a: string, b: string): boolean {
  const pa = parseVer(a);
  const pb = parseVer(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function getAppVersion(): Promise<string> {
  if (!IS_TAURI) return '0.0.0';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '0.0.0';
  }
}

/** Check the latest GitHub release for `owner/repo` against the running version. */
export async function checkUpdate(repo: string): Promise<UpdateResult> {
  const current = await getAppVersion();
  const clean = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error(tr('update.errRepo'));
  const res = await fetch(`https://api.github.com/repos/${clean}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) throw new Error(tr('update.err404'));
  if (!res.ok) throw new Error(tr('update.errStatus', { status: res.status }));
  const data = await res.json();
  const latest = String(data.tag_name ?? '').replace(/^v/i, '');
  const url = data.html_url ?? `https://github.com/${clean}/releases/latest`;
  const assets: Array<{ name: string; browser_download_url: string }> = Array.isArray(data.assets)
    ? data.assets
    : [];
  const exe =
    assets.find((a) => /setup\.exe$/i.test(a.name)) ??
    assets.find((a) => /\.exe$/i.test(a.name)) ??
    assets.find((a) => /\.msi$/i.test(a.name));
  return {
    current,
    latest,
    hasUpdate: !!latest && isNewer(latest, current),
    url,
    downloadUrl: exe?.browser_download_url,
  };
}

/** Open the release page in the default browser. */
export async function openUpdateUrl(url: string): Promise<void> {
  if (!IS_TAURI) {
    window.open(url, '_blank');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Download the installer .exe and launch it (auto-update). */
export async function downloadAndRun(url: string): Promise<void> {
  if (!IS_TAURI) {
    window.open(url, '_blank');
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('download_and_run', { url });
}

/** Close the app so the installer can replace the running exe. */
export async function quitApp(): Promise<void> {
  if (!IS_TAURI) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().destroy();
}
