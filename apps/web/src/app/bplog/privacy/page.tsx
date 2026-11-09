import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'BP Log Privacy Policy',
  description:
    'What the BP Log iPhone app does and does not collect. Your data stays on your phone and your iCloud.',
  alternates: { canonical: absoluteUrl('/bplog/privacy') },
};

const UPDATED = 'November 9, 2026';

export default function BpLogPrivacyPage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="fuchsia"
        size="md"
        eyebrow={`Legal · Updated ${UPDATED}`}
        title="BP Log Privacy Policy"
        description="BP Log is a blood pressure logbook for iPhone. The readings you enter stay on your phone and in your own iCloud. There is no account and no EticaHub server involved."
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
            This policy covers the BP Log app for iPhone, published by EticaHub Labs. Contact: the
            EticaHub Telegram community or the GitHub repository linked in the footer.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Where your data lives</h2>
          <p>
            BP Log stores your readings, notes and settings on your iPhone with Apple&apos;s
            SwiftData and syncs them through your personal iCloud account (CloudKit private
            database). Apple, not EticaHub, operates iCloud. Deleting the app and its iCloud data
            removes everything.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">What we do not collect</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>No accounts, passwords, emails or phone numbers.</li>
            <li>No copy of your entries on any EticaHub server.</li>
            <li>No contacts or location.</li>
            <li>No selling or sharing of your data with anyone.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Apple Health</h2>
          <p>
            If you turn on Apple Health sync, BP Log reads blood pressure, heart rate, blood oxygen
            and weight from Health and writes the readings you enter back to Health. Health data is
            only used inside the app and is never sent to EticaHub, advertisers or anyone else. You
            can revoke access at any time in Settings &gt; Health &gt; Data Access.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Camera</h2>
          <p>
            The cuff scan feature uses the camera and on-device text recognition to read the numbers
            on your monitor. Photos are processed on the phone and are not stored or uploaded.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Optional research donation</h2>
          <p>
            Off by default. If you turn it on, BP Log sends one anonymized weekly summary (average
            systolic, diastolic, pulse and reading count) to EticaHub Labs research. It contains no
            name, identifier, location or individual readings, and you can turn it off at any time.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Ads on the free plan</h2>
          <p>
            The free plan shows one banner ad from Google AdMob. Google&apos;s SDK may collect your
            device&apos;s advertising identifier, IP address and coarse usage data to serve and
            measure ads, under{' '}
            <a
              href="https://policies.google.com/privacy"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              Google&apos;s privacy policy
            </a>
            . iOS asks for permission before any cross-app tracking; if you say no, ads still show
            but are not personalized. The monthly or yearly ad-free subscription removes ads.
            Purchases are handled by Apple; we never see your payment details.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Not medical advice</h2>
          <p>
            BP Log is a log, not a medical device. It does not measure blood pressure or give
            medical advice.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Children</h2>
          <p>
            BP Log is not directed at children under 13 and we do not knowingly collect data from
            them.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Changes</h2>
          <p>
            If this policy changes we will update the date at the top of this page. Continued use of
            the app after a change means you accept the new policy.
          </p>
        </div>
      </section>
    </div>
  );
}
