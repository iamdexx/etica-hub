import { getBlocks, getTransactions } from "@/lib/api";
import { truncateHash, timeAgo, formatNumber } from "@/lib/utils";

export default async function Home() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blocks: any = { blocks: { data: [] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txs: any = { transactions: { data: [] } };

  try {
    [blocks, txs] = await Promise.all([getBlocks(), getTransactions()]);
  } catch (e) {
    console.error("Failed to fetch data:", e);
  }

  const latestBlocks = blocks?.blocks?.data?.slice(0, 10) || [];
  const latestTxs = txs?.transactions?.data?.slice(0, 10) || [];

  return (
    <div>
      {/* Hero / Search */}
      <section className="bg-[var(--eth-blue)] text-white rounded-xl p-8 mb-6">
        <h1 className="text-2xl font-bold mb-2">Etica Blockchain Explorer</h1>
        <p className="text-sm text-gray-300 mb-4">
          Decentralized Science Chain | Chain ID: 61803
        </p>
        <form action="/search" method="GET" className="flex gap-2">
          <input
            name="q"
            type="text"
            placeholder="Search by Address / Tx Hash / Block Number"
            className="flex-1 px-4 py-3 rounded-lg text-black text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            type="submit"
            className="bg-[var(--eth-link)] px-6 py-3 rounded-lg font-medium hover:bg-blue-600 transition"
          >
            Search
          </button>
        </form>
      </section>

      {/* Stats Row */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Latest Block</div>
          <div className="text-lg font-bold mt-1">
            {latestBlocks[0] ? formatNumber(latestBlocks[0].number) : "..."}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Transactions</div>
          <div className="text-lg font-bold mt-1">
            {latestTxs[0] ? "Syncing..." : "Loading..."}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Native Token</div>
          <div className="text-lg font-bold mt-1">EGAZ</div>
        </div>
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Network</div>
          <div className="text-lg font-bold mt-1">Etica Mainnet</div>
        </div>
      </section>

      {/* Latest Blocks & Transactions */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Latest Blocks */}
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-base font-bold">Latest Blocks</h2>
            <a href="/blocks" className="text-xs">View All &rarr;</a>
          </div>
          <div className="space-y-3">
            {latestBlocks.map((block: any) => (
              <div
                key={block.number}
                className="flex items-center justify-between border-b border-[var(--eth-border)] pb-3"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center text-xs font-bold text-[var(--eth-muted)]">
                    Bk
                  </div>
                  <div>
                    <a href={`/block/${block.number}`} className="font-medium text-sm">
                      {formatNumber(block.number)}
                    </a>
                    <div className="text-xs text-[var(--eth-muted)]">
                      {block.timestamp ? timeAgo(block.timestamp) : ""}
                    </div>
                  </div>
                </div>
                <div className="text-right text-xs">
                  <div className="text-[var(--eth-muted)]">
                    Miner{" "}
                    <a href={`/address/${block.miner}`} className="text-[var(--eth-link)]">
                      {truncateHash(block.miner, 8, 6)}
                    </a>
                  </div>
                  <div className="text-[var(--eth-muted)]">
                    {block.nbtxs || 0} txns
                  </div>
                </div>
              </div>
            ))}
            {latestBlocks.length === 0 && (
              <p className="text-sm text-[var(--eth-muted)]">
                Syncing blocks... Data will appear shortly.
              </p>
            )}
          </div>
        </div>

        {/* Latest Transactions */}
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-base font-bold">Latest Transactions</h2>
            <a href="/txs" className="text-xs">View All &rarr;</a>
          </div>
          <div className="space-y-3">
            {latestTxs.map((tx: any) => (
              <div
                key={tx.hash}
                className="flex items-center justify-between border-b border-[var(--eth-border)] pb-3"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center text-xs font-bold text-[var(--eth-muted)]">
                    Tx
                  </div>
                  <div>
                    <a href={`/tx/${tx.hash}`} className="font-medium text-sm">
                      {truncateHash(tx.hash, 10, 6)}
                    </a>
                    <div className="text-xs text-[var(--eth-muted)]">
                      {tx.timestamp ? timeAgo(tx.timestamp) : tx.created_at ? timeAgo(tx.created_at) : ""}
                    </div>
                  </div>
                </div>
                <div className="text-right text-xs">
                  <div>
                    From{" "}
                    <a href={`/address/${tx.from_address || tx.fromaddress}`}>
                      {truncateHash(tx.from_address || tx.fromaddress || "", 6, 4)}
                    </a>
                  </div>
                  <div>
                    To{" "}
                    <a href={`/address/${tx.to_address || tx.toaddress}`}>
                      {truncateHash(tx.to_address || tx.toaddress || "", 6, 4)}
                    </a>
                  </div>
                </div>
              </div>
            ))}
            {latestTxs.length === 0 && (
              <p className="text-sm text-[var(--eth-muted)]">
                Syncing transactions... Data will appear shortly.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
