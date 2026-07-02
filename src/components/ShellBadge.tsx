import { SHELLS } from '../shells';
import type { ShellKind } from '../types';

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
