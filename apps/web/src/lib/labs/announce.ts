/**
 * Discovery announcer — pushes every newly archived Labs research record to
 * social channels so the autonomous lab produces a public, steady stream of
 * "new protein folded" posts.
 *
 * Channels (each independently optional, enabled by env):
 *
 *   Telegram  LABS_ANNOUNCE_TELEGRAM_BOT_TOKEN / LABS_ANNOUNCE_TELEGRAM_CHAT_ID
 *             (falls back to the buybot's BUYBOT_TELEGRAM_* so a single
 *             community channel works with zero extra config). Posts the
 *             record's OG image with an HTML caption via `sendPhoto`.
 *
 *   X         X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 *             (OAuth 1.0a user context, POST /2/tweets). Text-only; X unfurls
 *             the archive link into a card using the page's OG image.
 *
 * Posting is best-effort and must never fail the archive write. Duplicate
 * suppression uses a Redis set of announced record ids so a retried worker
 * update can't double-post.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { absoluteUrl } from '@/lib/site';
import { scoreOutOf100 } from '@/lib/seo/labs';

import type { ArchivedResearch } from './archive';
import { labsStore } from './store';

const ANNOUNCED_SET = 'labs:archive:announced';

export interface AnnounceOutcome {
  telegram: 'sent' | 'skipped' | 'failed';
  x: 'sent' | 'skipped' | 'failed';
}

function trunc(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function archiveUrl(id: string): string {
  return absoluteUrl(`/labs/archive/${encodeURIComponent(id)}`);
}

export function archiveImageUrl(id: string): string {
  return absoluteUrl(`/labs/archive/${encodeURIComponent(id)}/opengraph-image`);
}

/** Shared facts every channel renders. */
export function discoveryFacts(r: ArchivedResearch) {
  const best = r.bestCandidate;
  const folded = r.candidates.filter((c) => c.folded).length;
  return {
    title: r.goalTitle ?? r.prompt,
    disease: r.disease,
    score: scoreOutOf100(best?.score),
    engine: best?.engine,
    residues: best?.sequence?.length ?? 0,
    folded,
    candidates: r.candidates.length,
    iterations: r.iterations,
    url: archiveUrl(r.id),
  };
}

export function telegramCaption(r: ArchivedResearch): string {
  const f = discoveryFacts(r);
  const lines = [
    `🧬 <b>New Labs discovery</b>${f.disease ? ` · ${escapeHtml(f.disease)}` : ''}`,
    '',
    `<b>${escapeHtml(trunc(f.title, 160))}</b>`,
  ];
  if (r.hypothesis) lines.push('', escapeHtml(trunc(r.hypothesis, 300)));
  lines.push(
    '',
    `Best candidate: <b>${f.score}</b> · ${f.residues} aa` +
      (f.engine ? ` · folded by ${escapeHtml(f.engine)}` : ''),
    `${f.folded}/${f.candidates} candidates folded · ${f.iterations} iteration${f.iterations === 1 ? '' : 's'}`,
    '',
    `<a href="${f.url}">View structure &amp; mint →</a>`,
  );
  return lines.join('\n');
}

export function tweetText(r: ArchivedResearch): string {
  const f = discoveryFacts(r);
  const head = `🧬 New autonomous Labs discovery${f.disease ? ` for ${f.disease}` : ''}`;
  const stats = `${f.score} best candidate · ${f.residues} aa · ${f.folded}/${f.candidates} folded`;
  const tags = '#DeSci #ProteinDesign $ETX';
  // 280 chars; URLs count as 23 on X.
  const budget = 280 - 23 - (head.length + stats.length + tags.length + 6);
  const title = trunc(f.title, Math.max(40, budget));
  return `${head}\n\n${title}\n${stats}\n\n${f.url}\n${tags}`;
}

/* ------------------------------------------------------------------ */
/*  Telegram                                                           */
/* ------------------------------------------------------------------ */

function telegramTarget(env: NodeJS.ProcessEnv): { token: string; chatId: string } | null {
  const token = env.LABS_ANNOUNCE_TELEGRAM_BOT_TOKEN || env.BUYBOT_TELEGRAM_BOT_TOKEN || '';
  const chatId = env.LABS_ANNOUNCE_TELEGRAM_CHAT_ID || env.BUYBOT_TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return null;
  return { token, chatId };
}

async function postTelegram(
  r: ArchivedResearch,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<AnnounceOutcome['telegram']> {
  const target = telegramTarget(env);
  if (!target) return 'skipped';
  const caption = telegramCaption(r);
  const base = `https://api.telegram.org/bot${target.token}`;
  const photo = await fetchImpl(`${base}/sendPhoto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: target.chatId,
      photo: archiveImageUrl(r.id),
      caption,
      parse_mode: 'HTML',
    }),
    cache: 'no-store',
  });
  if (photo.ok) return 'sent';
  // Telegram couldn't fetch/decode the image (e.g. cold OG render) — fall
  // back to a plain message so the discovery is still announced.
  const text = await fetchImpl(`${base}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: target.chatId,
      text: caption,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
    cache: 'no-store',
  });
  return text.ok ? 'sent' : 'failed';
}

/* ------------------------------------------------------------------ */
/*  X (OAuth 1.0a)                                                     */
/* ------------------------------------------------------------------ */

interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

function xCreds(env: NodeJS.ProcessEnv): XCreds | null {
  const apiKey = env.X_API_KEY ?? '';
  const apiSecret = env.X_API_SECRET ?? '';
  const accessToken = env.X_ACCESS_TOKEN ?? '';
  const accessSecret = env.X_ACCESS_SECRET ?? '';
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** RFC 5849 Authorization header for a JSON-body request (no body params signed). */
export function oauth1Header(
  method: string,
  url: string,
  creds: XCreds,
  nonce: string = randomBytes(16).toString('hex'),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), pct(url), pct(paramString)].join('&');
  const signingKey = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  const all: Record<string, string> = { ...params, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(all)
      .sort()
      .map((k) => `${pct(k)}="${pct(all[k])}"`)
      .join(', ')
  );
}

async function postX(
  r: ArchivedResearch,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<AnnounceOutcome['x']> {
  const creds = xCreds(env);
  if (!creds) return 'skipped';
  const url = 'https://api.x.com/2/tweets';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: oauth1Header('POST', url, creds),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: tweetText(r) }),
    cache: 'no-store',
  });
  return res.ok ? 'sent' : 'failed';
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export function announcementsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LABS_ANNOUNCE_DISABLED === '1') return false;
  return telegramTarget(env) !== null || xCreds(env) !== null;
}

/**
 * Announce a freshly archived discovery. Idempotent per record id; only
 * records with at least one folded candidate are worth broadcasting.
 */
export async function announceDiscovery(
  r: ArchivedResearch,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<AnnounceOutcome | null> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!announcementsEnabled(env)) return null;
  if (!r.candidates.some((c) => c.folded)) return null;

  const added = await labsStore().sadd(ANNOUNCED_SET, r.id);
  if (added === 0) return null;

  const [telegram, x] = await Promise.all([
    postTelegram(r, env, fetchImpl).catch(() => 'failed' as const),
    postX(r, env, fetchImpl).catch(() => 'failed' as const),
  ]);
  return { telegram, x };
}
