/**
 * Live status of the off-chain bridge watcher jobs (GitHub Actions cron).
 *
 * The heartbeat / monitor / execute loops run in the public repo, so their
 * latest run is readable without auth, but anonymous quota is 60 req/h per
 * egress IP (shared on Vercel), so `GITHUB_DISPATCH_TOKEN` (already used for
 * Labs dispatch) is preferred. Results are cached via `next.revalidate`.
 */

export const WATCHER_REPO = process.env.BRIDGE_WATCHER_REPO ?? 'iamdexx/etica-hub';

export interface WatcherDef {
  id: string;
  file: string;
  label: string;
  cadenceMinutes: number;
  description: string;
}

export const WATCHERS: WatcherDef[] = [
  {
    id: 'heartbeat',
    file: 'bridge-heartbeat.yml',
    label: 'Heartbeat',
    cadenceMinutes: 15,
    description: 'Signs BridgeMinter.heartbeat() so the HeartbeatISM keeps accepting inbound messages.',
  },
  {
    id: 'monitor',
    file: 'bridge-monitor.yml',
    label: 'Monitor',
    cadenceMinutes: 5,
    description: 'Watches pending claims and raises a Telegram alert on anything that looks fraudulent.',
  },
  {
    id: 'execute',
    file: 'bridge-execute.yml',
    label: 'Executor',
    cadenceMinutes: 30,
    description: 'Finalises claims whose 48h challenge window has expired and refunds submitter bonds.',
  },
];

export type WatcherState = 'ok' | 'failed' | 'running' | 'late' | 'unknown';

export interface WatcherStatus {
  id: string;
  label: string;
  cadenceMinutes: number;
  description: string;
  state: WatcherState;
  conclusion: string | null;
  status: string | null;
  lastRunAt: string | null;
  runUrl: string | null;
  runNumber: number | null;
}

interface GhRun {
  status: string | null;
  conclusion: string | null;
  html_url: string;
  run_started_at?: string;
  created_at: string;
  run_number: number;
}

interface GhRunsResponse {
  workflow_runs?: GhRun[];
}

function classify(run: GhRun | null, cadenceMinutes: number, now: number): WatcherState {
  if (!run) return 'unknown';
  if (run.status !== 'completed') return 'running';
  const at = Date.parse(run.run_started_at ?? run.created_at);
  if (Number.isFinite(at) && now - at > cadenceMinutes * 60_000 * 3) return 'late';
  if (run.conclusion === 'success') return 'ok';
  if (run.conclusion === 'skipped' || run.conclusion === 'cancelled') return 'unknown';
  return 'failed';
}

async function latestRun(file: string): Promise<GhRun | null> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'EticaHub-Bridge-Status/1.0 (+https://eticahub.com/bridge)',
  };
  const token = process.env.GITHUB_DISPATCH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${WATCHER_REPO}/actions/workflows/${file}/runs?per_page=1&exclude_pull_requests=true`;
  const res = await fetch(url, { headers, next: { revalidate: 120 } });
  if (!res.ok) throw new Error(`github ${res.status}`);
  const body = (await res.json()) as GhRunsResponse;
  return body.workflow_runs?.[0] ?? null;
}

export async function fetchWatcherStatuses(now = Date.now()): Promise<WatcherStatus[]> {
  return Promise.all(
    WATCHERS.map(async (w) => {
      let run: GhRun | null = null;
      try {
        run = await latestRun(w.file);
      } catch {
        run = null;
      }
      return {
        id: w.id,
        label: w.label,
        cadenceMinutes: w.cadenceMinutes,
        description: w.description,
        state: classify(run, w.cadenceMinutes, now),
        conclusion: run?.conclusion ?? null,
        status: run?.status ?? null,
        lastRunAt: run ? (run.run_started_at ?? run.created_at) : null,
        runUrl: run?.html_url ?? null,
        runNumber: run?.run_number ?? null,
      };
    }),
  );
}
