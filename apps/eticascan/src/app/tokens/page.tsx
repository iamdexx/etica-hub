import { getTransfers } from "@/lib/api";
import { truncateHash, timeAgo } from "@/lib/utils";

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1");

  let data = { transfers: { data: [] } };
  try {
    data = await getTransfers(page);
  } catch (e) {
    console.error(e);
  }

  const transfers = data?.transfers?.data || [];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Token Transfers (ETI)</h1>
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-[var(--eth-muted)] uppercase">Token</div>
            <div className="text-base font-bold mt-1">ETI (Etica)</div>
          </div>
          <div>
            <div className="text-xs text-[var(--eth-muted)] uppercase">Contract</div>
            <div className="text-sm mt-1">
              <a href="/address/0x34c61EA91bAcdA647269d4e310A86b875c09946f" className="break-all">
                0x34c61EA91bAcdA647269d4e310A86b875c09946f
              </a>
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--eth-muted)] uppercase">Type</div>
            <div className="text-base font-bold mt-1">ERC-20</div>
          </div>
        </div>
      </div>

      <div className="card table-container">
        <table>
          <thead>
            <tr>
              <th>Tx Hash</th>
              <th>Age</th>
              <th>From</th>
              <th>To</th>
              <th>Value (ETI)</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t: any, i: number) => (
              <tr key={i}>
                <td>
                  <a href={`/tx/${t.transactionhash || t.hash}`} className="truncate-hash font-medium">
                    {truncateHash(t.transactionhash || t.hash || "", 10, 6)}
                  </a>
                </td>
                <td className="text-xs text-[var(--eth-muted)]">
                  {t.created_at ? timeAgo(t.created_at) : ""}
                </td>
                <td>
                  <a href={`/address/${t.fromaddress}`} className="truncate-hash">
                    {truncateHash(t.fromaddress || "", 8, 6)}
                  </a>
                </td>
                <td>
                  <a href={`/address/${t.toaddress}`} className="truncate-hash">
                    {truncateHash(t.toaddress || "", 8, 6)}
                  </a>
                </td>
                <td className="text-xs">
                  {t.value ? (Number(t.value) / 1e18).toFixed(4) : "0"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {transfers.length === 0 && (
          <p className="text-center text-[var(--eth-muted)] py-8">
            No token transfers indexed yet. Sync in progress...
          </p>
        )}

        <div className="flex justify-between items-center mt-4 pt-4 border-t border-[var(--eth-border)]">
          <a
            href={`/tokens?page=${Math.max(1, page - 1)}`}
            className={`text-sm px-3 py-1 rounded border ${page <= 1 ? "opacity-50 pointer-events-none" : ""}`}
          >
            &larr; Prev
          </a>
          <span className="text-sm text-[var(--eth-muted)]">Page {page}</span>
          <a href={`/tokens?page=${page + 1}`} className="text-sm px-3 py-1 rounded border">
            Next &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
