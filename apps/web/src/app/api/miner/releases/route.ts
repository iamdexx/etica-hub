/**
 * Which miner installer to serve per platform: the newest `miner-v*` GitHub release that
 * actually has that asset. Mac builds wait on Apple's notarization and can land hours after
 * Windows/Linux, so a fixed tag would 404 for Mac visitors in between. Cached 5 minutes so
 * GitHub's unauthenticated rate limit (60/h per IP) is never a problem for visitors.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const REVALIDATE = 300;

const RELEASES = 'https://api.github.com/repos/iamdexx/etica-hub/releases?per_page=100';
const FILES = ['x64-setup.exe', 'aarch64.dmg', 'x64.dmg', 'amd64.AppImage', 'amd64.deb'];

type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] };
export type MinerReleaseAssets = Partial<Record<string, { url: string; version: string }>>;

export async function GET(): Promise<NextResponse> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'eticahub.com' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const out: MinerReleaseAssets = {};
  try {
    const res = await fetch(RELEASES, { headers, next: { revalidate: REVALIDATE } });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const releases = (await res.json()) as Release[];
    for (const r of releases) {
      if (r.draft || r.prerelease || !r.tag_name.startsWith('miner-v')) continue;
      const version = r.tag_name.slice('miner-v'.length);
      for (const file of FILES) {
        if (out[file]) continue;
        const asset = r.assets.find((a) => a.name.endsWith(`_${file}`));
        if (asset) out[file] = { url: asset.browser_download_url, version };
      }
    }
  } catch {
    // Not cached: the page falls back to its pinned APP_VERSION links until GitHub answers again.
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(out, { headers: { 'Cache-Control': `public, max-age=${REVALIDATE}, s-maxage=${REVALIDATE}` } });
}
