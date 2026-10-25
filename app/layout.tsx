import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resale price assistant",
  description:
    "Photos and a few questions about something you are about to sell, then a suggested listing price from used listings of the same model, and where to sell it.",
  robots: { index: false, follow: false },
};

/**
 * Applies a saved light/dark choice before the first paint, so it does not flash
 * the system theme first. Runs as plain text in the head because React has not
 * loaded yet; storage may be blocked, so it is allowed to do nothing.
 */
const APPLY_SAVED_THEME = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is set by the script below before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPLY_SAVED_THEME }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
