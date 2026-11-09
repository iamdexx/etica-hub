import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Pet Meds Privacy Policy',
  description:
    'What the Pet Meds iPhone app does and does not collect. Your data stays on your phone and your iCloud.',
  alternates: { canonical: absoluteUrl('/petmeds/privacy') },
};

const UPDATED = 'November 9, 2026';

export default function PetMedsPrivacyPage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow={`Legal · Updated ${UPDATED}`}
        title="Pet Meds Privacy Policy"
        description="Pet Meds is a medication tracker for pets, for iPhone. Your pets, medications and dose history stay on your phone and in your own iCloud. There is no account and no EticaHub server involved."
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
            This policy covers the Pet Meds app for iPhone, published by EticaHub Labs. Contact: the
            EticaHub Telegram community or the GitHub repository linked in the footer.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Where your data lives</h2>
          <p>
            Pet Meds stores pets, medications, dose history, photos and settings on your iPhone with
            Apple&apos;s SwiftData and syncs them through your personal iCloud account (CloudKit
            private database). Apple, not EticaHub, operates iCloud. Deleting the app and its iCloud
            data removes everything.
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
          <h2 className="text-lg font-semibold text-white">Photos and camera</h2>
          <p>
            Pet photos and prescription label photos you add are stored only in the app&apos;s
            database on your phone and iCloud. They are never uploaded to EticaHub.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Notifications</h2>
          <p>
            Dose and refill reminders are local notifications scheduled on your phone. No reminder
            data leaves the device.
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
            Pet Meds is a logbook, not veterinary advice. Always follow the dose on the prescription
            label.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">Children</h2>
          <p>
            Pet Meds is not directed at children under 13 and we do not knowingly collect data from
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
