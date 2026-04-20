export const metadata = { title: 'Research Hub · EticaHub' };

export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Research Hub</h1>
      <p className="text-sm text-white/60">
        Every research proposal submitted to the Etica core contract, indexed and rendered from
        IPFS. Search, browse by disease / chunk, tip researchers in ETI, or subscribe for curated
        feeds.
      </p>
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-10 text-center text-sm text-white/50">
        <div>Research Hub ships in <strong>Phase 2</strong>.</div>
        <div className="mt-2 text-xs text-white/40">
          Indexer scaffold lives at <code>apps/indexer</code>.
        </div>
      </div>
    </div>
  );
}
