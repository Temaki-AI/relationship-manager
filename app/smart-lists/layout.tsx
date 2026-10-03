import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Smart Lists',
};

export default function SmartListsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
