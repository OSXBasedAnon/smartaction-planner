import "./globals.css";
import type { Metadata } from "next";
import { Sora, Space_Grotesk } from "next/font/google";

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "600", "700"]
});

const space = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space",
  weight: ["500", "700"]
});

export const metadata: Metadata = {
  title: "SupplyFlare Blueprint Agent",
  description: "Turn any project idea into a practical DIY workflow, editable materials list, and cost plan.",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sora.className} ${space.variable}`}>{children}</body>
    </html>
  );
}
