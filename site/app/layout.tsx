import type { Metadata } from "next";
import AgentChat from "./AgentChat";
import SideNav from "./SideNav";
import "./globals.css";

const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";
const description =
  "Measuring the city’s heartbeat and detecting irregularities: transparent movement-change signals from WCC transport countlines.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Murmur",
  description,
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "Murmur",
    description,
    url: siteUrl,
    images: [{ url: "/og-card.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Murmur",
    description,
    images: ["/og-card.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-NZ">
      <body>
        {/* One shell for every route: a hideable rail, the page, and an agent
            that can be opened from anywhere. */}
        <div className="app-frame">
          <SideNav />
          <div className="app-main">{children}</div>
        </div>
        <AgentChat />
      </body>
    </html>
  );
}
