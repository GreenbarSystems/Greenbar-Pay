import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Greenbar AP Assurance",
  description: "AP invoice intake and review",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-gray-50 text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
