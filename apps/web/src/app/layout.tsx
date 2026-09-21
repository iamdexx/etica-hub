import type { Metadata } from 'next';
import { Providers } from './providers';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { JsonLd } from '@/components/JsonLd';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo/jsonld';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

const DESCRIPTION =
  'EticaHub is the first on-chain DEX, open-research proposal hub, AI protein-design lab, and Ethereum bridge for the Etica mainnet (chain 61803).';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'EticaHub — DEX · Research Hub · Bridge on Etica',
    template: '%s · EticaHub',
  },
  description: DESCRIPTION,
  openGraph: {
    siteName: SITE_NAME,
    type: 'website',
    url: SITE_URL,
    title: 'EticaHub — DEX · Research Hub · Bridge on Etica',
    description: DESCRIPTION,
    images: [{ url: '/etx-logo-512.png', width: 512, height: 512, alt: 'EticaHub' }],
  },
  twitter: { card: 'summary', title: 'EticaHub', description: DESCRIPTION },
  icons: { icon: '/etx-logo.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen overflow-x-hidden antialiased">
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={websiteJsonLd()} />
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
