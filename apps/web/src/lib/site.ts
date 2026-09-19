export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_ENV === 'production' || !process.env.VERCEL_URL
    ? 'https://eticahub.com'
    : `https://${process.env.VERCEL_URL}`)
).replace(/\/$/, '');

export const SITE_NAME = 'EticaHub';

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
