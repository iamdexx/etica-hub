export function truncateHash(hash: string, start = 10, end = 8): string {
  if (!hash || hash.length <= start + end) return hash || "";
  return `${hash.slice(0, start)}...${hash.slice(-end)}`;
}

export function formatTimestamp(ts: number | string): string {
  const date = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function timeAgo(ts: number | string): string {
  const date = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds} secs ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

export function formatGwei(wei: string | number): string {
  const val = typeof wei === "string" ? parseInt(wei) : wei;
  return (val / 1e9).toFixed(2) + " Gwei";
}

export function formatEther(wei: string | number): string {
  const val = typeof wei === "string" ? BigInt(wei) : BigInt(Math.floor(Number(wei)));
  const eth = Number(val) / 1e18;
  if (eth === 0) return "0 EGAZ";
  if (eth < 0.0001) return "< 0.0001 EGAZ";
  return eth.toFixed(4) + " EGAZ";
}

export function formatNumber(n: number | string | null): string {
  if (n === null || n === undefined) return "0";
  return Number(n).toLocaleString();
}
