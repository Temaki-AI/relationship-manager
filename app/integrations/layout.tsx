import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Data connections',
};

export default function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
