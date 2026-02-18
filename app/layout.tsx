import "./globals.css";
import type { Metadata } from "next";
import { Outfit } from "next/font/google";

const outfit = Outfit({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "700"]
});

export const metadata: Metadata = {
  title: "SupplyFlare",
  description: "Fast multi-vendor quote engine"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={outfit.className}>{children}</body>
    </html>
  );
}
