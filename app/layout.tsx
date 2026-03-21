import type { Metadata } from "next";
import "./globals.css";
import { Home, Users, Settings } from "lucide-react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Relationship Manager",
  description: "Personal relationship CRM",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen bg-gray-50">
          {/* Header */}
          <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between items-center h-16">
                <div className="flex items-center">
                  <h1 className="text-xl font-bold text-gray-900">
                    Relationship Manager
                  </h1>
                </div>
                <nav className="flex space-x-4">
                  <Link
                    href="/"
                    className="flex items-center px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md"
                  >
                    <Home className="w-4 h-4 mr-2" />
                    Dashboard
                  </Link>
                  <Link
                    href="/contacts"
                    className="flex items-center px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md"
                  >
                    <Users className="w-4 h-4 mr-2" />
                    Contacts
                  </Link>
                </nav>
              </div>
            </div>
          </header>

          {/* Main Content */}
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
