import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Terms of Use',
  description:
    'Terms for using eticahub.com, the EticaHub Wallet and the EticaHub Miner. Self-custody software provided as is.',
  alternates: { canonical: absoluteUrl('/terms') },
};

const UPDATED = 'October 26, 2026';

export default function TermsPage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow={`Legal · Updated ${UPDATED}`}
        title="Terms of Use"
        description="Short version: EticaHub is free, open-source, self-custody software. You are in control of your keys and your decisions, and you accept the risks that come with that."
        actions={
          <Link href="/privacy" className="btn-ghost px-3.5 py-1.5 text-xs">
            Privacy Policy
          </Link>
        }
      />

      <section className="surface space-y-6 p-5 text-sm leading-7 text-white/80 md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">1. What EticaHub is</h2>
          <p>
            EticaHub Labs publishes eticahub.com, the EticaHub Wallet, the EticaHub Miner, public
            RPC nodes and mining pools for the Etica blockchain (together, the
            &quot;Services&quot;). The wallet and miner are interfaces to a public blockchain and to
            smart contracts that run on their own. EticaHub is not a bank, broker, exchange,
            custodian or money transmitter and does not hold or control your assets.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">2. Self-custody</h2>
          <p>
            You alone hold your recovery phrase and private keys. You are responsible for keeping
            them safe and offline. Anyone with your 12 words controls your funds. EticaHub cannot
            reverse transactions, recover lost phrases, unlock wallets or return funds sent to the
            wrong address.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">3. Risks you accept</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Crypto assets are volatile and can lose all their value.</li>
            <li>Smart contracts, networks and devices can have bugs or be attacked.</li>
            <li>Transactions are final once confirmed on the blockchain.</li>
            <li>
              Prices, balances and quotes shown in the apps come from public data and can be delayed
              or wrong.
            </li>
            <li>Mining earnings depend on network difficulty and luck and are not guaranteed.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">4. Your responsibilities</h2>
          <p>
            Use the Services only where it is legal for you to do so, and handle your own taxes and
            reporting. Do not use the Services for anything unlawful, to attack the network or other
            users, or on devices you do not have the right to use. Mining on a phone is not
            supported and is against the app stores&apos; rules.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">5. Fees</h2>
          <p>
            EticaHub does not charge for the wallet or the miner. The Etica network charges gas
            (EGAZ) for every transaction, EticaSwap pools charge the swap fee shown before you
            confirm, and EticaHub mining pools charge the pool fee published on the pool page
            (currently 0.5%). Fees can change; the current numbers are always shown in the app or on
            the page before you act.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">6. No warranty</h2>
          <p>
            The Services are provided &quot;as is&quot; and &quot;as available&quot;, without
            warranties of any kind, express or implied, including fitness for a particular purpose,
            accuracy or uninterrupted operation. Nothing in the Services is financial, investment,
            legal or tax advice.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">7. Limitation of liability</h2>
          <p>
            To the fullest extent the law allows, EticaHub Labs and its contributors are not liable
            for any loss of funds, profits, data or opportunity, or for indirect, incidental or
            consequential damages arising from the Services, even if told such losses were possible.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">8. Open source</h2>
          <p>
            The code is published on GitHub under its stated licenses. You may inspect, fork and
            build it yourself. Third-party software bundled or downloaded by the apps (for example
            mining engines) is governed by its own licenses.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">9. Changes and termination</h2>
          <p>
            We may update these terms or stop offering any part of the Services at any time; the
            date at the top shows the current version. Because the wallet is self-custody, your
            funds stay yours and remain usable with any compatible software even if EticaHub stops.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">10. Contact</h2>
          <p>
            Questions go to the EticaHub Telegram community or the GitHub repository linked in the
            footer.
          </p>
        </div>
      </section>
    </div>
  );
}
