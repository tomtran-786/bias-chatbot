"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const EVENT = "themechange";

/** The theme in force: an explicit choice if there is one, otherwise the system's. */
function current(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const system = matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    system.removeEventListener("change", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/**
 * Light or dark, one tap. Starts from the system setting and remembers a choice.
 *
 * The choice is written to `data-theme`, which globals.css already honours in both
 * directions. The saved value is applied before first paint by the inline script in
 * app/layout.tsx, so a returning visitor never sees the wrong theme flash. Storage
 * can be blocked (private windows), so every use of it is allowed to fail: the toggle
 * still works for the visit, it just is not remembered.
 */
export function ThemeToggle() {
  // The server cannot know; "light" is replaced as soon as the client has read the real one.
  const theme = useSyncExternalStore(subscribe, current, () => "light" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // not remembered, still applied
        }
        window.dispatchEvent(new Event(EVENT));
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="-mr-2 flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-sunken hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {theme === "dark" ? (
          // Showing the moon says which mode this is; the label says what a tap does.
          <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
          </>
        )}
      </svg>
    </button>
  );
}
