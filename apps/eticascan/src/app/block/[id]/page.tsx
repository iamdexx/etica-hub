import { fetchAPI } from "@/lib/api";
import { formatNumber, formatTimestamp, truncateHash } from "@/lib/utils";

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let block: any = null;
  try {
    const data = await fetchAPI("/api/etica/blocks", { page: "1" });
    block = data?.blocks?.data?.find((b: any) => String(b.number) === id);
  } catch (e) {
    console.error(e);
  }

  if (!block) {
    return (
      <div className="card">
        <h1 className="text-xl font-bold mb-4">Block #{id}</h1>
        <p className="text-[var(--eth-muted)]">
          Block not found or not yet indexed. The indexer may not have reached this block yet.
        </p>
      </div>
    );
  }

  const fields = [
    { label: "Block Height", value: formatNumber(block.number) },
    { label: "Timestamp", value: block.timestamp ? formatTimestamp(block.timestamp) : "N/A" },
    { label: "Transactions", value: String(block.nbtxs || 0) },
    { label: "Miner", value: block.miner, link: `/address/${block.miner}` },
    { label: "Difficulty", value: formatNumber(block.difficulty || 0) },
    { label: "Total Difficulty", value: formatNumber(block.totalDifficulty || block.totaldifficulty || 0) },
    { label: "Size", value: `${formatNumber(block.size || 0)} bytes` },
    { label: "Gas Used", value: formatNumber(block.gasUsed || block.gasused || 0) },
    { label: "Gas Limit", value: formatNumber(block.gasLimit || block.gaslimit || 0) },
    { label: "Hash", value: block.hash },
    { label: "Parent Hash", value: block.parenthash, link: block.parenthash ? `/block/${block.number - 1}` : undefined },
    { label: "Nonce", value: block.nonce },
    { label: "Extra Data", value: block.extraData || block.extradata || "" },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">
        Block <span className="text-[var(--eth-muted)]">#{formatNumber(block.number)}</span>
      </h1>
      <div className="card">
        <dl className="space-y-4">
          {fields.map(({ label, value, link }) => (
            <div key={label} className="flex flex-col sm:flex-row sm:gap-4 border-b border-[var(--eth-border)] pb-3">
              <dt className="text-sm font-medium text-[var(--eth-muted)] sm:w-48 shrink-0">
                {label}:
              </dt>
              <dd className="text-sm break-all">
                {link ? (
                  <a href={link}>{value}</a>
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
