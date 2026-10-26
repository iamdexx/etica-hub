import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Privacy Policy · EticaHub',
  description:
    'What EticaHub and the EticaHub Wallet do and do not collect. Self-custody: your keys never leave your device.',
  alternates: { canonical: absoluteUrl('/privacy') },
};

const UPDATED = 'October 26, 2026';

export default function PrivacyPage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow={`Legal · Updated ${UPDATED}`}
        title="Privacy Policy"
        description="EticaHub is self-custody software. We do not run accounts, we do not hold your keys, and we keep what we learn about you to the minimum needed to serve a page or answer a request."
        actions={
          <Link href="/terms" className="btn-ghost px-3.5 py-1.5 text-xs">
            Terms of Use
          </Link>
        }
      />

      <section className="surface space-y-6 p-5 text-sm leading-7 text-white/80 md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Who this covers</h2>
          <p>
            This policy covers eticahub.com, its APIs and RPC endpoints, the EticaHub Miner desktop
            app and the EticaHub Wallet mobile app (together, &quot;EticaHub&quot;). It is published
            by EticaHub Labs. Contact: the EticaHub Telegram community or the GitHub repository
            linked in the footer.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Your keys and funds</h2>
          <p>
            The EticaHub Wallet creates your recovery phrase and private keys on your phone and
            stores them only in the device&apos;s secure keychain, protected by Face ID, Touch ID or
            your passcode. They are never sent to EticaHub or anyone else. We cannot see, recover,
            freeze or move your funds. If you lose your phone and your 12 words, nobody can restore
            the wallet.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">What we do not collect</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>No accounts, passwords, emails or phone numbers.</li>
            <li>No private keys, recovery phrases or signing data.</li>
            <li>No contacts, photos, location or advertising identifiers.</li>
            <li>No analytics or tracking SDKs inside the wallet or miner apps.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">What our servers see</h2>
          <p>
            To show balances, prices and history, the apps call EticaHub services: the public RPC
            (rpc.eticahub.com), the explorer API, the token price API and the mining pool APIs. Like
            any web server these receive your IP address, the wallet address being looked up and
            standard request logs, kept for a short period for reliability and abuse prevention. We
            do not sell this data or use it for advertising. The apps also talk to public Etica RPC
            nodes run by others as a fallback; their logging is theirs.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Blockchain data is public</h2>
          <p>
            Every transaction you send is recorded on the Etica blockchain, which is public and
            permanent. Your wallet address, balances and transaction history are visible to anyone
            with a block explorer. EticaHub does not control this and cannot delete it.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Camera and biometrics</h2>
          <p>
            The wallet asks for the camera only to scan a QR code with a wallet address; the image
            is processed on the device and never uploaded. Face ID and Touch ID are handled by iOS;
            the app only learns whether the check passed.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Mining pools</h2>
          <p>
            When you mine to one of our pools, the pool records the wallet address you chose, your
            worker name, submitted shares and payouts. This is needed to pay you and is shown on the
            pool&apos;s public stats pages.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Children</h2>
          <p>
            EticaHub is not directed at children under 18 and we do not knowingly collect data from
            them.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Changes</h2>
          <p>
            We will post any change to this page with a new date at the top. Using EticaHub after a
            change means you accept the updated policy.
          </p>
        </div>
      </section>
    </div>
  );
}
