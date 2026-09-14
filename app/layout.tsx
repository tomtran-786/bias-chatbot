import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decision grader",
  description:
    "Asks about a decision you have not made yet, grades your reasoning, and recommends one of your options.",
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
