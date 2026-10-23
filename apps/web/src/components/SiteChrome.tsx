'use client';

import { usePathname } from 'next/navigation';

/**
 * Site header/footer/next-up wrapper. Pages under `/embed` are meant to be
 * iframed into third-party sites, so they render bare: no chrome, no page
 * gutters.
 */
export function SiteChrome({
  header,
  footer,
  children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  if (pathname?.startsWith('/embed')) {
    return <main className="min-h-screen w-full">{children}</main>;
  }
  return (
    <>
      {header}
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5 md:px-6 md:py-10 lg:px-8">
        {children}
      </main>
      {footer}
    </>
  );
}
