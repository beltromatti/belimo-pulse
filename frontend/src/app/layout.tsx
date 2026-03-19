import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belimo Pulse",
  description: "Control surface for Belimo Start Hackathon 2026.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
