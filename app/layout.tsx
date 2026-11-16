import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OUTLAST // COMMAND — Infrastructure Intelligence",
  description: "Your infrastructure command center. Official signals, local awareness, and readiness in one place.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
