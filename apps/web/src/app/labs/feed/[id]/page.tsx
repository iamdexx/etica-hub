/**
 * EticaLabs Autopilot — public run detail page.
 *
 * Server-fetched first paint, then a client poller refreshes the page state
 * every 5s while the job is still pending/running. Once the job lands in a
 * terminal state ('done' | 'error') the poller stops.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';

import { labsQueue } from '@/lib/labs/queue';

import { LabsRunDetail } from './LabsRunDetail';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LabsRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!id) notFound();

  const job = await labsQueue()
    .get(id)
    .catch(() => null);
  if (!job) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-12 text-center md:px-6">
        <h1 className="text-2xl font-semibold text-white">Run not found</h1>
        <p className="text-sm text-white/65">
          The job ID <code className="rounded bg-white/5 px-1.5 py-0.5 text-xs">{id}</code> is not
          in the queue. Jobs are retained for 30 days; older runs may have expired.
        </p>
        <Link
          href="/labs/feed"
          className="inline-flex items-center justify-center rounded-full bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink transition hover:opacity-90"
        >
          ← Back to the feed
        </Link>
      </div>
    );
  }

  return <LabsRunDetail initialJob={job} />;
}
