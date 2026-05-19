/**
 * Inline pill rendering the current moderation status for a labs goal
 * or job. Visible across /labs/feed, /labs/goals, and the detail pages.
 */
import type { ModerationStatus } from '@/lib/labs/moderation';

const STYLES: Record<ModerationStatus, { cls: string; label: string }> = {
  visible: { cls: 'border-white/10 bg-white/[0.04] text-white/65', label: 'visible' },
  hidden: { cls: 'border-amber-400/30 bg-amber-400/10 text-amber-200', label: 'community-hidden' },
  'operator-hidden': {
    cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    label: 'operator-hidden',
  },
  'operator-approved': {
    cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    label: 'operator-approved',
  },
  denied: { cls: 'border-rose-500/50 bg-rose-500/15 text-rose-100', label: 'denied' },
};

export function ModerationBadge({ status }: { status: ModerationStatus | undefined }): JSX.Element | null {
  if (!status || status === 'visible') return null;
  const s = STYLES[status] ?? STYLES.visible;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
