/** Cursor logo mark (isometric cube), mono-color for the dark UI. */
export function CursorIcon({
  size = 13,
  color = '#e6e6e6',
  title,
  className,
}: {
  size?: number;
  color?: string;
  title?: string;
  className?: string;
}) {
  // Hexagon outline + Y-shaped inner edges = the Cursor cube.
  const hex = '12,2.5 20.2,7.25 20.2,16.75 12,21.5 3.8,16.75 3.8,7.25';
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
      <g stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
        <polygon points={hex} />
        <path d="M12 12 L3.8 7.25 M12 12 L20.2 7.25 M12 12 L12 21.5" />
      </g>
      <polygon points="12,12 20.2,7.25 20.2,16.75 12,21.5" fill={color} opacity={0.4} />
    </svg>
  );
}
