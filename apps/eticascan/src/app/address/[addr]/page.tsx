import { fetchAPI } from "@/lib/api";
import { truncateHash, timeAgo } from "@/lib/utils";

export default async function AddressPage({
  params,
}: {
  params: Promise<{ addr: string }>;
}) {
  const { addr } = await params;

  let transfers: any[] = [];
  try {
    const data = await fetchAPI("/api/etica/transfers", { page: "1" });
    transfers = (data?.transfers?.data || []).filter(
      (t: any) =>
        (t.fromaddress || "").toLowerCase() === addr.toLowerCase() ||
        (t.toaddress || "").toLowerCase() === addr.toLowerCase()
    );
  } catch (e) {
    console.error(e);
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Address</h1>
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-sm font-medium text-[var(--eth-muted)]">Address:</span>
          <span className="text-sm break-all font-mono">{addr}</span>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Balance</div>
          <div className="text-lg font-bold mt-1">Query via RPC</div>
          <div className="text-xs text-[var(--eth-muted)]">Live balance requires RPC call</div>
        </div>
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Transactions</div>
          <div className="text-lg font-bold mt-1">{transfers.length} indexed</div>
          <div className="text-xs text-[var(--eth-muted)]">From current sync window</div>
        </div>
        <div className="card">
          <div className="text-xs text-[var(--eth-muted)] uppercase">Token</div>
          <div className="text-lg font-bold mt-1">ETI / EGAZ</div>
        </div>
      </div>

      {/* Transfers Table */}
      <div className="card">
        <h2 className="text-base font-bold mb-4">Token Transfers</h2>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Tx Hash</th>
                <th>Age</th>
                <th>From</th>
                <th>To</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t: any, i: number) => (
                <tr key={i}>
                  <td>
                    <a href={`/tx/${t.transactionhash || t.hash}`} className="truncate-hash">
                      {truncateHash(t.transactionhash || t.hash || "", 10, 6)}
                    </a>
                  </td>
                  <td className="text-xs text-[var(--eth-muted)]">
                    {t.created_at ? timeAgo(t.created_at) : ""}
                  </td>
                  <td>
                    <a
                      href={`/address/${t.fromaddress}`}
                      className={`truncate-hash ${(t.fromaddress || "").toLowerCase() === addr.toLowerCase() ? "text-red-500" : ""}`}
                    >
                      {truncateHash(t.fromaddress || "", 8, 6)}
                    </a>
                  </td>
                  <td>
                    <a
                      href={`/address/${t.toaddress}`}
                      className={`truncate-hash ${(t.toaddress || "").toLowerCase() === addr.toLowerCase() ? "text-green-600" : ""}`}
                    >
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
              No transfers found for this address in the current sync window.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
