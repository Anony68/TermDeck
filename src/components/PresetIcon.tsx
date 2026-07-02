import { PRESET_RECTS } from '../layouts';
import type { LayoutPreset } from '../types';

export function PresetIcon({
  preset,
  active,
  w = 22,
  h = 16,
}: {
  preset: LayoutPreset;
  active?: boolean;
  w?: number;
  h?: number;
}) {
  const fill = active ? 'var(--accent)' : 'var(--text-muted)';
  return (
    <svg width={w} height={h} viewBox="0 0 22 16">
      {PRESET_RECTS[preset].map(([x, y, rw, rh], i) => (
        <rect key={i} x={x} y={y} width={rw} height={rh} rx={rw < 8 ? 1.5 : 2} fill={fill} />
      ))}
    </svg>
  );
}
