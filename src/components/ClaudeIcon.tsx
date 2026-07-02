/** Claude Code spark icon (8-ray starburst, brand orange). */
export const CLAUDE_ORANGE = '#d97757';

export function ClaudeIcon({
  size = 13,
  color = CLAUDE_ORANGE,
  title,
  className,
}: {
  size?: number;
  color?: string;
  title?: string;
  className?: string;
}) {
  // 8 rays from an inner radius to the edge, leaving a gap at the center.
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return {
      x1: 12 + 4.2 * Math.cos(a),
      y1: 12 + 4.2 * Math.sin(a),
      x2: 12 + 10.2 * Math.cos(a),
      y2: 12 + 10.2 * Math.sin(a),
    };
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ flex: 'none', display: 'block' }}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <g stroke={color} strokeWidth={3.4} strokeLinecap="round">
        {rays.map((r, i) => (
          <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
        ))}
      </g>
    </svg>
  );
}
