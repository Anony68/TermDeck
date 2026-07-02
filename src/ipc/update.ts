import { IS_TAURI } from './env';

export interface UpdateResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
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
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error('Repo không hợp lệ (định dạng owner/repo)');
  const res = await fetch(`https://api.github.com/repos/${clean}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) throw new Error('Chưa có bản phát hành công khai nào trên repo này');
  if (!res.ok) throw new Error(`GitHub trả về ${res.status}`);
  const data = await res.json();
  const latest = String(data.tag_name ?? '').replace(/^v/i, '');
  const url = data.html_url ?? `https://github.com/${clean}/releases/latest`;
  return { current, latest, hasUpdate: !!latest && isNewer(latest, current), url };
}

/** Open the release page/installer in the default browser. */
export async function openUpdateUrl(url: string): Promise<void> {
  if (!IS_TAURI) {
    window.open(url, '_blank');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
