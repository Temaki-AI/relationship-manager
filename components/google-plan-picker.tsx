'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';
type Directory = { plans: Array<{ public_id: string; contact_name: string; planned_date: string; type: string }>; pagination: { totalPages: number } };
export function GooglePlanPicker({ connectionId }: { connectionId: string }) {
  const [page, setPage] = useState(1), [data, setData] = useState<Directory | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    fetch(`/api/plans?status=open&page=${page}&pageSize=25`, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load your plans.')); setData(await response.json());
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page]);
  return <div className="mx-auto max-w-2xl space-y-5 px-4 py-6 pb-28">
    <Link className="inline-flex min-h-11 items-center underline" href={`/connections/google/${connectionId}/publish`}>Calendar setup</Link>
    <h1 className="text-2xl font-semibold">Choose a plan to publish</h1><p>Choose an open plan, then review its event details and any Google invitations. Your private plan notes stay in Everclose.</p>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">Loading plans…</p>}
    {data && !loading && <><ul className="space-y-3">{data.plans.map((plan) => <li key={plan.public_id} className="rounded-xl border p-4"><Link className="block min-h-11 break-words underline" href={`/connections/google/${connectionId}/plans/${plan.public_id}`}>{plan.contact_name} · {plan.type} · {plan.planned_date}</Link></li>)}</ul>{!data.plans.length && <p>No open plans. Create a plan from a person’s profile, then return here.</p>}
      <nav aria-label="Plan pages" className="flex items-center justify-between gap-3"><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page} of {Math.max(1, data.pagination.totalPages)}</span><Button variant="outline" disabled={loading || page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>Next</Button></nav></>}
  </div>;
}
