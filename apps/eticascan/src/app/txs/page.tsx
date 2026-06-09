import { getTransactions } from "@/lib/api";
import { truncateHash, timeAgo } from "@/lib/utils";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1");
  let data = { transactions: { data: [] } };

  try {
    data = await getTransactions(page);
  } catch (e) {
    console.error(e);
  }

  const txs = data?.transactions?.data || [];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Transactions</h1>
      <div className="card table-container">
        <table>
          <thead>
            <tr>
              <th>Tx Hash</th>
              <th>Block</th>
              <th>Age</th>
              <th>From</th>
              <th>To</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx: any) => (
              <tr key={tx.hash}>
                <td>
                  <a href={`/tx/${tx.hash}`} className="truncate-hash font-medium">
                    {truncateHash(tx.hash, 10, 6)}
                  </a>
                </td>
                <td>
                  <a href={`/block/${tx.blocknumber || tx.blockNumber}`}>
                    {tx.blocknumber || tx.blockNumber || ""}
                  </a>
                </td>
                <td className="text-[var(--eth-muted)] text-xs">
                  {tx.timestamp ? timeAgo(tx.timestamp) : tx.created_at ? timeAgo(tx.created_at) : ""}
                </td>
                <td>
                  <a href={`/address/${tx.fromaddress || tx.from_address}`} className="truncate-hash">
                    {truncateHash(tx.fromaddress || tx.from_address || "", 8, 6)}
                  </a>
                </td>
                <td>
                  <a href={`/address/${tx.toaddress || tx.to_address}`} className="truncate-hash">
                    {truncateHash(tx.toaddress || tx.to_address || "", 8, 6)}
                  </a>
                </td>
                <td className="text-xs">
                  {tx.value ? (Number(tx.value) / 1e18).toFixed(4) : "0"} EGAZ
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {txs.length === 0 && (
          <p className="text-center text-[var(--eth-muted)] py-8">
            No transactions indexed yet. Sync in progress...
          </p>
        )}

        <div className="flex justify-between items-center mt-4 pt-4 border-t border-[var(--eth-border)]">
          <a
            href={`/txs?page=${Math.max(1, page - 1)}`}
            className={`text-sm px-3 py-1 rounded border ${page <= 1 ? "opacity-50 pointer-events-none" : ""}`}
          >
            &larr; Prev
          </a>
          <span className="text-sm text-[var(--eth-muted)]">Page {page}</span>
          <a href={`/txs?page=${page + 1}`} className="text-sm px-3 py-1 rounded border">
            Next &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
