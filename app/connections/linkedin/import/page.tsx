import Link from 'next/link';
import { LinkedInExportImport } from '@/components/linkedin-export-import';
export default function LinkedInImportPage() {
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8"><Link className="inline-block py-3 underline" href="/connections/linkedin">Back to LinkedIn connections</Link><h1 className="text-2xl font-semibold">Import LinkedIn connections</h1><LinkedInExportImport /></div>;
}
