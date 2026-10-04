'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { LinkedInSourceForm } from '@/components/linkedin-source-form';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
export default function LinkedInLinkPage() {
  const [dirty, setDirty] = useState(false);
  const markDirty = useCallback((value: boolean) => setDirty(value), []);
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link href="/integrations" className="inline-block py-3 underline">Back to data connections</Link>
    <h1 className="text-2xl font-semibold">LinkedIn profile links</h1>
    <p>Keep a LinkedIn profile with an existing relationship or create a person from it. Your private notes and history stay with the same person.</p>
    <Link className="inline-block py-3 underline" href="/connections/linkedin/import">Import a LinkedIn Connections.csv export</Link>
    <LinkedInSourceForm onDirty={markDirty} />
    <UnsavedChangesGuard active={dirty} onDiscard={() => window.location.reload()} />
  </div>;
}
