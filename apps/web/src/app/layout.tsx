import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from './providers';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { NextUp } from '@/components/NextUp';
import { JsonLd } from '@/components/JsonLd';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo/jsonld';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

const DESCRIPTION =
  'EticaHub is the first on-chain DEX, open-research proposal hub, AI protein-design lab, and Ethereum bridge for the Etica mainnet (chain 61803).';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'EticaHub — DEX · Labs · Bridge on Etica',
    template: '%s · EticaHub',
  },
  description: DESCRIPTION,
  openGraph: {
    siteName: SITE_NAME,
    type: 'website',
    url: SITE_URL,
    title: 'EticaHub — DEX · Labs · Bridge on Etica',
    description: DESCRIPTION,
    images: [{ url: '/brand/og.png', width: 1200, height: 630, alt: 'EticaHub' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EticaHub',
    description: DESCRIPTION,
    images: ['/brand/og.png'],
  },
  icons: {
    icon: [
      { url: '/brand/eticahub-mark-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/eticahub-mark-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/brand/eticahub-mark-192.png', sizes: '192x192', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen overflow-x-hidden font-sans antialiased">
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={websiteJsonLd()} />
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5 md:px-6 md:py-10 lg:px-8">
            {children}
          </main>
          <NextUp />
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
