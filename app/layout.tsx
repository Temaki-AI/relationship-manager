import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import { NavHeader } from "@/components/nav-header";
import { Providers } from "@/components/providers";
import { SectionNav } from "@/components/section-nav";

export const metadata: Metadata = {
  title: {
    default: "Everclose CRM - Personal Relationship Manager",
    template: "%s | Everclose CRM",
  },
  description: "Remember what matters and stay close to the people who matter.",
  applicationName: "Everclose CRM",
  manifest: "/manifest.webmanifest",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Everclose CRM",
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#cb1a41",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen bg-background">
            <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-3">Skip to content</a>
            <NavHeader />
            <main id="main-content" tabIndex={-1} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8">
              <SectionNav />
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
