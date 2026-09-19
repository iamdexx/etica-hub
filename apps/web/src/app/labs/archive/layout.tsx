import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Research Archive',
  description:
    'Permanent, searchable archive of every completed EticaHub Labs discovery — filter by disease, molecular target and source database.',
  alternates: { canonical: '/labs/archive' },
};

export default function ArchiveLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>;
}
