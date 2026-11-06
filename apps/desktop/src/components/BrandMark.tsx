/**
 * The DABWORKS "D" icon.
 *
 * Geometry is an exact copy of the brand package's vector artwork
 * (01_Logo_Master_Pack/SVG/DABWORKS_Icon_FullColor.svg), kept inline rather
 * than loaded as an <img> so the navy counter-form can follow `--ui-logo` and
 * invert on dark backgrounds — that is the package's own Reversed variant
 * (white D, orange slash). The slash stays DAB Orange in both themes.
 *
 * The mark is wider than it is tall (1269.27 x 1000), so size it by height and
 * leave the width automatic.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1269.27 1000"
      className={className}
      role="img"
      aria-label="DABWORKS"
    >
      <path
        fill="var(--ui-logo)"
        d="M157.72,0 L796.57,0 C1057.57,0 1269.27,223.87 1269.27,500 C1269.27,776.13 1057.57,1000 796.57,1000 L334.63,1000 L496.1,753.51 L752.11,753.51 C883.15,753.51 989.24,637.6 989.24,494.54 C989.24,351.48 883.15,235.57 752.11,235.57 L451.01,235.57 L451.01,385.34 L333.23,385.34 L157.72,653.2 Z"
      />
      <path fill="#f36c21" d="M366.77,439.94 L633.54,439.94 L266.77,1000 L0,1000 Z" />
    </svg>
  );
}
