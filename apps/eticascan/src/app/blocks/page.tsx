import { getBlocks } from "@/lib/api";
import { formatNumber, timeAgo, truncateHash } from "@/lib/utils";

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1");
  let data = { blocks: { data: [] }, links: {} as any };

  try {
    data = await getBlocks(page);
  } catch (e) {
    console.error(e);
  }

  const blocks = data?.blocks?.data || [];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Blocks</h1>
      <div className="card table-container">
        <table>
          <thead>
            <tr>
              <th>Block</th>
              <th>Age</th>
              <th>Txns</th>
              <th>Miner</th>
              <th>Gas Used</th>
              <th>Gas Limit</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block: any) => (
              <tr key={block.number}>
                <td>
                  <a href={`/block/${block.number}`} className="font-medium">
                    {formatNumber(block.number)}
                  </a>
                </td>
                <td className="text-[var(--eth-muted)] text-xs">
                  {block.timestamp ? timeAgo(block.timestamp) : ""}
                </td>
                <td>{block.nbtxs || 0}</td>
                <td>
                  <a href={`/address/${block.miner}`} className="truncate-hash">
                    {truncateHash(block.miner, 10, 8)}
                  </a>
                </td>
                <td>{formatNumber(block.gasUsed || block.gasused || 0)}</td>
                <td>{formatNumber(block.gasLimit || block.gaslimit || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {blocks.length === 0 && (
          <p className="text-center text-[var(--eth-muted)] py-8">
            No blocks indexed yet. Sync in progress...
          </p>
        )}

        {/* Pagination */}
        <div className="flex justify-between items-center mt-4 pt-4 border-t border-[var(--eth-border)]">
          <a
            href={`/blocks?page=${Math.max(1, page - 1)}`}
            className={`text-sm px-3 py-1 rounded border ${page <= 1 ? "opacity-50 pointer-events-none" : ""}`}
          >
            &larr; Prev
          </a>
          <span className="text-sm text-[var(--eth-muted)]">Page {page}</span>
          <a
            href={`/blocks?page=${page + 1}`}
            className="text-sm px-3 py-1 rounded border"
          >
            Next &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
