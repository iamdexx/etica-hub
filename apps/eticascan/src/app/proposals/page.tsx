import { getProposals, getDiseases } from "@/lib/api";
import { truncateHash, timeAgo } from "@/lib/utils";

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1");

  let proposalData = { proposals: { data: [] } };
  let diseaseData = { diseases: { data: [] } };

  try {
    [proposalData, diseaseData] = await Promise.all([
      getProposals(page),
      getDiseases(),
    ]);
  } catch (e) {
    console.error(e);
  }

  const proposals = proposalData?.proposals?.data || [];
  const diseases = diseaseData?.diseases?.data || [];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Research Proposals</h1>

      {/* Disease Topics */}
      {diseases.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-base font-bold mb-3">Disease Topics</h2>
          <div className="flex flex-wrap gap-2">
            {diseases.map((d: any) => (
              <span
                key={d.id || d.diseasehash}
                className="badge bg-blue-50 text-blue-700 px-3 py-1"
              >
                {d.title || d.name || truncateHash(d.diseasehash || "", 8, 6)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Proposals Table */}
      <div className="card table-container">
        <table>
          <thead>
            <tr>
              <th>Proposal Hash</th>
              <th>Proposer</th>
              <th>Disease</th>
              <th>Age</th>
              <th>Chunk</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p: any) => (
              <tr key={p.id || p.proposalhash}>
                <td>
                  <span className="truncate-hash font-medium text-[var(--eth-link)]">
                    {truncateHash(p.proposalhash || p.hash || "", 10, 6)}
                  </span>
                </td>
                <td>
                  <a href={`/address/${p.proposer}`} className="truncate-hash">
                    {truncateHash(p.proposer || "", 8, 6)}
                  </a>
                </td>
                <td>
                  <span className="truncate-hash text-xs">
                    {truncateHash(p.diseasehash || "", 8, 6)}
                  </span>
                </td>
                <td className="text-xs text-[var(--eth-muted)]">
                  {p.created_at ? timeAgo(p.created_at) : ""}
                </td>
                <td>
                  <span className="truncate-hash text-xs">
                    {truncateHash(p.chunkid || p.raw_release_hash || "", 8, 6)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {proposals.length === 0 && (
          <p className="text-center text-[var(--eth-muted)] py-8">
            No proposals indexed yet. Sync in progress...
          </p>
        )}

        <div className="flex justify-between items-center mt-4 pt-4 border-t border-[var(--eth-border)]">
          <a
            href={`/proposals?page=${Math.max(1, page - 1)}`}
            className={`text-sm px-3 py-1 rounded border ${page <= 1 ? "opacity-50 pointer-events-none" : ""}`}
          >
            &larr; Prev
          </a>
          <span className="text-sm text-[var(--eth-muted)]">Page {page}</span>
          <a href={`/proposals?page=${page + 1}`} className="text-sm px-3 py-1 rounded border">
            Next &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
