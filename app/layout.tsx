import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SupplyFlare",
  description: "Fast multi-vendor quote engine"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
