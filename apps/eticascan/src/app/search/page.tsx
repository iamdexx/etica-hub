import { redirect } from "next/navigation";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const query = (params.q || "").trim();

  if (!query) {
    redirect("/");
  }

  // Determine what the user searched for
  if (/^0x[a-fA-F0-9]{64}$/.test(query)) {
    // Transaction hash
    redirect(`/tx/${query}`);
  } else if (/^0x[a-fA-F0-9]{40}$/.test(query)) {
    // Address
    redirect(`/address/${query}`);
  } else if (/^\d+$/.test(query)) {
    // Block number
    redirect(`/block/${query}`);
  }

  return (
    <div className="card">
      <h1 className="text-xl font-bold mb-4">Search Results</h1>
      <p className="text-[var(--eth-muted)]">
        No results found for: <span className="font-mono break-all">{query}</span>
      </p>
      <p className="text-sm text-[var(--eth-muted)] mt-2">
        Try searching for a valid block number, transaction hash (0x...), or address (0x...).
      </p>
    </div>
  );
}
