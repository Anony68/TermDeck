import { SHELLS } from '../shells';
import type { Pane, ShellKind } from '../types';

/** Badge for any pane: shell badge, or a fixed badge for SSH / Browser panes. */
export function PaneBadge({ pane, size = 20 }: { pane: Pane; size?: number }) {
  const kind = pane.kind ?? 'shell';
  if (kind === 'shell') return <ShellBadge shell={pane.shell} size={size} />;
  const meta =
    kind === 'ssh'
      ? { badge: 'SSH', color: 'var(--sh-wsl, #e5b34a)' }
      : { badge: 'FB', color: 'var(--sh-ps, #4aa3ff)' };
  const fontSize = size <= 18 ? 7 : size <= 20 ? 7.5 : 8.5;
  return (
    <div
      title={kind === 'ssh' ? 'SSH terminal' : 'File Browser'}
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: size >= 24 ? 6 : 5,
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize,
        background: `color-mix(in srgb, ${meta.color} 16%, transparent)`,
        color: meta.color,
      }}
    >
      {meta.badge}
    </div>
  );
}

export function ShellBadge({ shell, size = 20 }: { shell: ShellKind; size?: number }) {
  const meta = SHELLS[shell];
  const color = `var(${meta.colorVar})`;
  const fontSize = size <= 18 ? 8 : size <= 20 ? 8.5 : 9.5;
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: size >= 24 ? 6 : 5,
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
      }}
    >
      {meta.badge}
    </div>
  );
}
