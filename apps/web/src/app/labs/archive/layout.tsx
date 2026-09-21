import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Research Archive',
  description:
    'Permanent, searchable archive of every completed EticaHub Labs discovery — filter by disease, molecular target and source database.',
  alternates: {
    canonical: '/labs/archive',
    types: {
      'application/atom+xml': [{ url: '/labs/feed.xml', title: 'EticaHub Labs discoveries' }],
      'application/feed+json': [{ url: '/labs/feed.json', title: 'EticaHub Labs discoveries' }],
    },
  },
};

export default function ArchiveLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>;
}
