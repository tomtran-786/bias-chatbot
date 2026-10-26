import { useId } from "react";

/**
 * The assistant's face: a pale glossy sphere with a dark visor, a rim that runs
 * cyan to violet, and two white eyes that blink now and then (globals.css).
 *
 * Drawn here rather than shipped as an image so it is sharp at every size and does
 * not add a request. Decorative: the thread says who is speaking in words, so it is
 * hidden from assistive tech.
 */
export function BotAvatar({ size = 40 }: { size?: number }) {
  // A page can hold several, and gradient ids are global to the document.
  const id = useId().replace(/:/g, "");

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0"
      style={{ filter: "drop-shadow(0 4px 8px rgb(38 70 120 / 0.22))" }}
    >
      <defs>
        <radialGradient id={`${id}-body`} cx="38%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="65%" stopColor="#edf2f8" />
          <stop offset="100%" stopColor="#c9d8ea" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#27e3e6" />
          <stop offset="50%" stopColor="#3a6bff" />
          <stop offset="100%" stopColor="#9b3dff" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${id}-body)`} />
      <rect
        x="15"
        y="32"
        width="70"
        height="38"
        rx="19"
        fill="#0a1020"
        stroke={`url(#${id}-rim)`}
        strokeWidth="5"
      />
      <ellipse className="bot-eye" cx="38" cy="51" rx="4.8" ry="6.4" fill="#ffffff" />
      <ellipse className="bot-eye" cx="62" cy="51" rx="4.8" ry="6.4" fill="#ffffff" />
    </svg>
  );
}
