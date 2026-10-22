import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resale price assistant",
  description:
    "Photos and a few questions about something you are about to sell, then a suggested listing price from used listings of the same model, and where to sell it.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
