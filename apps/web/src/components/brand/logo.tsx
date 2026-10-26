/**
 * The DemoFlow mark: a play triangle on an accent tile, with a frame line
 * under it — a recording that runs. Drawn with the accent token, so it follows
 * the theme (spec #373, open question "Logo"). The owner can replace the SVG.
 */
export function Logomark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="24" height="24" rx="6" className="fill-accent" />
      <path d="M9.5 6.5v8l6.5-4z" className="fill-on-accent" />
      <rect
        x="6"
        y="17"
        width="12"
        height="1.75"
        rx="0.875"
        className="fill-on-accent"
        opacity="0.7"
      />
    </svg>
  );
}

/** The mark and the name, for headers and the app sidebar. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-ink">
      <Logomark size={size} />
      <span>DemoFlow</span>
    </span>
  );
}
