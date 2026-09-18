/** Small square badge marking a session as an SSH terminal or a file browser. */
export function PaneBadge({ kind, size = 20 }: { kind: 'ssh' | 'browser'; size?: number }) {
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
