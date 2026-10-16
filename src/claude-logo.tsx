/** Claude-style spark mark, drawn as rotated rounded rays. */
export function ClaudeLogo({ className }: { className?: string }) {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const lengths = [9, 6, 8, 5.5, 9, 6, 8, 5.5, 9, 6, 8, 5.5];
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" fill="none">
      {rays.map((deg, i) => (
        <line
          key={deg}
          x1="16"
          y1={16 - 3}
          x2="16"
          y2={16 - 3 - lengths[i]}
          stroke="#D97757"
          strokeWidth="2.6"
          strokeLinecap="round"
          transform={`rotate(${deg} 16 16)`}
        />
      ))}
    </svg>
  );
}
