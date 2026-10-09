import { GooglePlanPicker } from '@/components/google-plan-picker';
export default async function PlanPickerPage({ params }: { params: Promise<{ id: string }> }) { return <GooglePlanPicker connectionId={(await params).id} />; }
