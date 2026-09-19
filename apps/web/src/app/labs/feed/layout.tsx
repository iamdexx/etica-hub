import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Autopilot Feed',
  description: 'Live feed of EticaHub Labs research runs: plans, candidates, folds and results as they happen.',
  alternates: { canonical: '/labs/feed' },
};

export default function FeedLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>;
}
