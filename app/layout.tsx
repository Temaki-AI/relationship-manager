import type { Metadata } from "next";
import "./globals.css";
import { NavHeader } from "@/components/nav-header";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Bonds — Personal Relationship Manager",
  description: "Keep your relationships alive",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen bg-background">
            <NavHeader />
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 sm:pb-8">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
