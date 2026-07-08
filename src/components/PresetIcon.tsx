import { PRESET_RECTS } from '../layouts';
import type { LayoutMode } from '../types';

export function PresetIcon({
  preset,
  active,
  w = 22,
  h = 16,
}: {
  preset: LayoutMode;
  active?: boolean;
  w?: number;
  h?: number;
}) {
  const fill = active ? 'var(--accent)' : 'var(--text-muted)';
  // 'auto' isn't a fixed grid — draw a 2×2 with a corner "A" to signal adaptivity.
  if (preset === 'auto') {
    return (
      <svg width={w} height={h} viewBox="0 0 22 16">
        {PRESET_RECTS.grid2x2.map(([x, y, rw, rh], i) => (
          <rect key={i} x={x} y={y} width={rw} height={rh} rx={1.5} fill={fill} opacity={0.4} />
        ))}
        <text x="11" y="12" textAnchor="middle" fontSize="11" fontWeight="700" fill={fill}>
          A
        </text>
      </svg>
    );
  }
  return (
    <svg width={w} height={h} viewBox="0 0 22 16">
      {PRESET_RECTS[preset].map(([x, y, rw, rh], i) => (
        <rect key={i} x={x} y={y} width={rw} height={rh} rx={rw < 8 ? 1.5 : 2} fill={fill} />
      ))}
    </svg>
  );
}
