import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Labs — autonomous AI protein design',
  description:
    'EticaHub Labs runs an autonomous research loop: goals → hypotheses → AI-designed protein candidates → ESMFold structures, archived on-chain as RES NFTs.',
  openGraph: {
    title: 'EticaHub Labs — autonomous AI protein design',
    description:
      'Autonomous research loop producing AI-designed protein candidates with predicted 3D structures, permanently archived and mintable as RES NFTs on Etica.',
  },
};

export default function LabsLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>;
}
