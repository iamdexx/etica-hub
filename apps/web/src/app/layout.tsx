import type { Metadata } from 'next';
import { Providers } from './providers';
import { SiteHeader } from '@/components/SiteHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'EticaHub — DEX · Research Hub · Bridge on Etica',
  description:
    'EticaHub is the first on-chain DEX, open-research proposal hub, and Ethereum bridge for the Etica mainnet (chain 61803).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl px-4 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
