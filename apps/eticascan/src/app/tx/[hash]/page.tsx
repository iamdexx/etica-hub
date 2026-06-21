import { fetchAPI } from "@/lib/api";
import { formatTimestamp, formatNumber, truncateHash } from "@/lib/utils";

export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;

  let tx: any = null;
  try {
    const data = await fetchAPI("/api/etica/transactions", { page: "1" });
    tx = data?.transactions?.data?.find((t: any) => t.hash === hash);
  } catch (e) {
    console.error(e);
  }

  if (!tx) {
    return (
      <div className="card">
        <h1 className="text-xl font-bold mb-4">Transaction Details</h1>
        <p className="text-[var(--eth-muted)]">
          Transaction not found or not yet indexed.
        </p>
        <p className="text-xs text-[var(--eth-muted)] mt-2 break-all">Hash: {hash}</p>
      </div>
    );
  }

  const fields = [
    { label: "Transaction Hash", value: tx.hash },
    { label: "Status", value: tx.status === 1 || tx.status === "1" ? "Success" : tx.status === 0 || tx.status === "0" ? "Failed" : "Pending", badge: true },
    { label: "Block", value: String(tx.blocknumber || tx.blockNumber || ""), link: `/block/${tx.blocknumber || tx.blockNumber}` },
    { label: "Timestamp", value: tx.timestamp ? formatTimestamp(tx.timestamp) : tx.created_at ? formatTimestamp(tx.created_at) : "N/A" },
    { label: "From", value: tx.fromaddress || tx.from_address || "", link: `/address/${tx.fromaddress || tx.from_address}` },
    { label: "To", value: tx.toaddress || tx.to_address || "", link: `/address/${tx.toaddress || tx.to_address}` },
    { label: "Value", value: `${tx.value ? (Number(tx.value) / 1e18).toFixed(6) : "0"} EGAZ` },
    { label: "Gas Used", value: formatNumber(tx.gasused || tx.gasUsed || 0) },
    { label: "Gas Price", value: tx.gasprice || tx.gasPrice ? `${(Number(tx.gasprice || tx.gasPrice) / 1e9).toFixed(2)} Gwei` : "N/A" },
    { label: "Nonce", value: String(tx.nonce ?? "") },
    { label: "Input Data", value: tx.input || tx.inputdata || "0x" },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Transaction Details</h1>
      <div className="card">
        <dl className="space-y-4">
          {fields.map(({ label, value, link, badge }) => (
            <div key={label} className="flex flex-col sm:flex-row sm:gap-4 border-b border-[var(--eth-border)] pb-3">
              <dt className="text-sm font-medium text-[var(--eth-muted)] sm:w-48 shrink-0">
                {label}:
              </dt>
              <dd className="text-sm break-all">
                {badge ? (
                  <span className={`badge ${value === "Success" ? "badge-success" : "badge-pending"}`}>
                    {value}
                  </span>
                ) : link ? (
                  <a href={link}>{value}</a>
                ) : label === "Input Data" ? (
                  <code className="text-xs bg-gray-100 p-2 rounded block max-h-32 overflow-y-auto">
                    {value}
                  </code>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
