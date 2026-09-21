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
 * Posting is best-effort and must never fail the archive write. Each channel
 * is gated by an atomic SADD on a per-channel Redis set so concurrent
 * completions can't double-post; a failed post releases the gate and parks
 * the record in a pending set that the autopilot dispatch tick drains.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { absoluteUrl } from '@/lib/site';
import { scoreOutOf100 } from '@/lib/seo/labs';

import { type ArchivedResearch, getArchivedResearch } from './archive';
import { labsStore } from './store';

type Channel = 'telegram' | 'x';
const ANNOUNCED_SET = (channel: Channel) => `labs:archive:announced:${channel}`;
/** Record ids with at least one channel still unsent; drained by `retryPendingAnnouncements`. */
const PENDING_SET = 'labs:archive:announce:pending';
const RETRY_BATCH = 5;

export interface AnnounceOutcome {
  telegram: 'sent' | 'skipped' | 'failed';
  x: 'sent' | 'skipped' | 'failed';
}

function trunc(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (max < 2) return '';
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

/** X counts every URL as 23 characters. */
const X_LIMIT = 280;
const X_URL_LEN = 23;

export function tweetText(r: ArchivedResearch): string {
  const f = discoveryFacts(r);
  const head = `🧬 New autonomous Labs discovery${f.disease ? ` for ${trunc(f.disease, 60)}` : ''}`;
  const stats = `${f.score} best candidate · ${f.residues} aa · ${f.folded}/${f.candidates} folded`;
  const tags = '#DeSci #ProteinDesign $ETX';
  const separators = 6; // \n\n, \n, \n\n, \n
  const fixed = head.length + stats.length + tags.length + X_URL_LEN + separators;
  const title = trunc(f.title, Math.max(0, X_LIMIT - fixed));
  const body = title ? `${head}\n\n${title}\n${stats}` : `${head}\n${stats}`;
  return `${body}\n\n${f.url}\n${tags}`;
}

/** Length as X measures it (URL weighted at 23). */
export function tweetLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(X_URL_LEN)).length;
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

  const store = labsStore();
  const once = async <C extends Channel>(
    channel: C,
    post: () => Promise<AnnounceOutcome[C]>,
  ): Promise<AnnounceOutcome[C]> => {
    const key = ANNOUNCED_SET(channel);
    if ((await store.sadd(key, r.id)) === 0) return 'skipped';
    const outcome = await post().catch(() => 'failed' as const);
    if (outcome !== 'sent') await store.srem(key, r.id);
    return outcome;
  };

  const [telegram, x] = await Promise.all([
    once('telegram', () => postTelegram(r, env, fetchImpl)),
    once('x', () => postX(r, env, fetchImpl)),
  ]);
  if (telegram === 'failed' || x === 'failed') await store.sadd(PENDING_SET, r.id);
  else await store.srem(PENDING_SET, r.id);
  return { telegram, x };
}

/**
 * Re-attempt announcements whose channel failed earlier (e.g. X 503). Runs
 * from the autopilot dispatch tick; bounded so a long outage can't stall it.
 */
export async function retryPendingAnnouncements(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ retried: number; sent: number }> {
  const env = opts.env ?? process.env;
  if (!announcementsEnabled(env)) return { retried: 0, sent: 0 };
  const store = labsStore();
  const ids = (await store.smembers(PENDING_SET)).slice(0, RETRY_BATCH);
  let sent = 0;
  for (const id of ids) {
    const record = await getArchivedResearch(id);
    if (!record) {
      await store.srem(PENDING_SET, id);
      continue;
    }
    const out = await announceDiscovery(record, { ...opts, env });
    if (out && out.telegram !== 'failed' && out.x !== 'failed') sent += 1;
  }
  return { retried: ids.length, sent };
}
