import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eticascan - Etica Blockchain Explorer",
  description:
    "Etica blockchain explorer. Search transactions, blocks, addresses, tokens, and research proposals on the Etica network.",
};

function Header() {
  return (
    <header className="bg-white border-b border-[var(--eth-border)] sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 text-xl font-bold text-[var(--eth-blue)] no-underline hover:no-underline">
          <span className="text-2xl">&#9670;</span>
          Eticascan
        </a>
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <a href="/" className="text-[var(--eth-text)] hover:text-[var(--eth-link)]">Home</a>
          <a href="/blocks" className="text-[var(--eth-text)] hover:text-[var(--eth-link)]">Blocks</a>
          <a href="/txs" className="text-[var(--eth-text)] hover:text-[var(--eth-link)]">Transactions</a>
          <a href="/tokens" className="text-[var(--eth-text)] hover:text-[var(--eth-link)]">Tokens</a>
          <a href="/proposals" className="text-[var(--eth-text)] hover:text-[var(--eth-link)]">Research</a>
        </nav>
        <div className="flex items-center gap-2 text-xs text-[var(--eth-muted)]">
          <span className="badge badge-success">EGAZ: Gas</span>
          <span>Chain ID: 61803</span>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="bg-white border-t border-[var(--eth-border)] mt-12">
      <div className="max-w-7xl mx-auto px-4 py-8 text-center text-sm text-[var(--eth-muted)]">
        <p>Eticascan &copy; {new Date().getFullYear()} | Etica Blockchain Explorer</p>
        <p className="mt-1">
          Powered by{" "}
          <a href="https://github.com/etica/etica-explorer-engine" target="_blank" rel="noopener">
            Etica Explorer Engine
          </a>{" "}
          | Chain ID: 61803 | RPC: rpc2.etica-stats.org
        </p>
      </div>
    </footer>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
