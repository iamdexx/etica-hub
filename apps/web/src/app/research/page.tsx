import Link from 'next/link';

export const metadata = { title: 'Research Hub - EticaHub' };
export const revalidate = 60;

export default function ResearchPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-sky-400/20 bg-[#061018] p-6 shadow-2xl shadow-sky-950/20">
        <div className="text-xs uppercase tracking-wider text-sky-200">Research Hub</div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">
          Research proposals are temporarily unavailable.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
          The live proposal feed is paused while the production deploy is repaired.
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-xs">
          <Link href="/explorer" className="rounded-md border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-sky-100 hover:bg-sky-400/15">
            Open explorer
          </Link>
          <Link href="/whitepaper" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">
            Whitepaper
          </Link>
        </div>
      </section>
    </div>
  );
}
