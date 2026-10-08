import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automator",
  description: "Google Forms workflow runs",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
