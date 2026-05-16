import type { Metadata } from 'next';
import { Providers } from './providers';
import { SiteFooter } from '@/components/SiteFooter';
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
      <body className="min-h-screen overflow-x-hidden antialiased">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-4 md:px-5 md:py-8 lg:px-6">
            {children}
          </main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
