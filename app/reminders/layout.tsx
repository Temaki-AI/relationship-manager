import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reminders',
};

export default function RemindersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
