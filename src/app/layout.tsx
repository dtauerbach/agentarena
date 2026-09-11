import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "arena",
  description: "N agents, one board, no game",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b">
          <nav className="mx-auto flex h-12 max-w-5xl items-center gap-6 px-4 text-sm">
            <Link href="/" className="font-semibold tracking-tight">
              arena
            </Link>
            <Link
              href="/#conditions"
              className="text-muted-foreground hover:text-foreground"
            >
              variations
            </Link>
            <Link
              href="/#batches"
              className="text-muted-foreground hover:text-foreground"
            >
              batches
            </Link>
            <Link
              href="/#runs"
              className="text-muted-foreground hover:text-foreground"
            >
              runs
            </Link>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
