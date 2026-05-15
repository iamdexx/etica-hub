import type { ReactNode } from 'react';

export function MarketChartShell({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#06110e] shadow-2xl shadow-emerald-950/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/70">{eyebrow}</div>
          <h2 className="mt-1 text-sm font-semibold text-white">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-white/45">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2 text-[11px]">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function MarketPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'red' }) {
  const cls =
    tone === 'green'
      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
      : tone === 'red'
        ? 'border-rose-400/20 bg-rose-400/10 text-rose-200'
        : 'border-white/10 bg-white/5 text-white/55';

  return <span className={`rounded-md border px-2 py-1 ${cls}`}>{children}</span>;
}

export function TimeframePills({ active = '24H' }: { active?: string }) {
  const frames = ['1H', '24H', '7D', '30D'];
  return (
    <div className="flex rounded-md border border-white/10 bg-black/20 p-1 text-[10px]">
      {frames.map((frame) => (
        <span
          key={frame}
          className={`rounded px-2 py-1 ${frame === active ? 'bg-brand-accent text-brand-ink' : 'text-white/45'}`}
        >
          {frame}
        </span>
      ))}
    </div>
  );
}
