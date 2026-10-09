import { GooglePlanPublication } from '@/components/google-plan-publication';
export default async function PublishPlanPage({ params }: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await params; return <GooglePlanPublication connectionId={id} planId={planId} />;
}
