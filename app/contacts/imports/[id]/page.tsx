import { ImportReportView } from '@/components/import-report-view';

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ImportReportView key={id} id={id} />;
}
