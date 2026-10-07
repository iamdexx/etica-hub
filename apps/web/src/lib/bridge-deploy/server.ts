/**
 * Server side of the /deploy/bridge flow: signature verification, nonce
 * burn, workflow dispatch, pre-flight reads and result discovery. See
 * `./typed-data.ts` for the message the keeper wallet signs.
 */
import {
  createPublicClient,
  fallback,
  formatEther,
  formatGwei,
  http,
  keccak256,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { BRIDGE_ROLES, eticaMainnet, isUsdcWarpRouteLive } from '@etica-hub/shared';
import { memoryKv, restKv, tcpKv, type KvStore } from '@/lib/buybot/state';
import {
  BRIDGE_DEPLOY_DOMAIN,
  BRIDGE_DEPLOY_PRIMARY_TYPE,
  BRIDGE_DEPLOY_TYPES,
  DEPLOY_SIGNATURE_TTL_SECONDS,
  type BridgeDeployMessage,
} from './typed-data';
import { ETHEREUM_PUBLIC_RPCS } from '@/lib/bridge/ethereum-rpcs';

export const BRIDGE_DEPLOY_WORKFLOW = 'bridge-deploy.yml';
export const BRIDGE_DEPLOY_REF = 'main';

/** Same keyless rotation the keeper and the workflow use. */
export { ETHEREUM_PUBLIC_RPCS };

/** Mirrors the workflow pre-flight: ~8M gas for the Ethereum side, 2x margin. */
export const WARP_DEPLOY_GAS = 8_000_000n;
export const MIN_KEEPER_ETH_WEI = 50_000_000_000_000_000n;
export const MIN_KEEPER_EGAZ_WEI = 5_000_000_000_000_000_000n;

const REGISTRY_CORE_PATH = 'infra/hyperlane/registry/chains/etica/addresses.yaml';
const REGISTRY_WARP_PATH = 'infra/hyperlane/registry/deployments/warp_routes/USDC/etica-config.yaml';
const REGISTRY_FEE_PATH = 'infra/hyperlane/registry/deployments/warp_routes/USDC/etica-fee-contract.txt';

export function deployRepo(): string {
  return (process.env.GITHUB_DISPATCH_REPO ?? 'iamdexx/etica-hub').trim();
}

function dispatchToken(): string {
  return (process.env.GITHUB_DISPATCH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'EticaHub-Bridge-Deploy/1.0 (+https://eticahub.com/deploy/bridge)',
  };
  const token = dispatchToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

export type VerifyResult = { ok: true } | { ok: false; error: string };

export async function verifyDeployAuthorization(
  message: BridgeDeployMessage,
  signature: Hex,
  opts: { nowSeconds?: number; signer?: Address } = {},
): Promise<VerifyResult> {
  const now = BigInt(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (message.deadline < now) return { ok: false, error: 'authorisation expired; sign again' };
  if (message.deadline > now + BigInt(DEPLOY_SIGNATURE_TTL_SECONDS)) {
    return { ok: false, error: 'deadline too far in the future' };
  }
  let valid = false;
  try {
    valid = await verifyTypedData({
      address: opts.signer ?? BRIDGE_ROLES.keeper,
      domain: BRIDGE_DEPLOY_DOMAIN,
      types: BRIDGE_DEPLOY_TYPES,
      primaryType: BRIDGE_DEPLOY_PRIMARY_TYPE,
      message,
      signature,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'signature is not from the keeper wallet' };
  return { ok: true };
}

let memory: KvStore | null = null;

/**
 * Store for burned signatures. Production refuses to run without a real
 * backend: a replayed authorisation would queue a second deploy.
 */
export function deployNonceStore(): KvStore | null {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) return tcpKv(redisUrl);
  const restUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) return restKv(restUrl, restToken);
  if (process.env.VERCEL_ENV === 'production') return null;
  memory ??= memoryKv();
  return memory;
}

export function nonceKey(signature: Hex): string {
  return `bridge-deploy:sig:${keccak256(signature)}`;
}

/** Marks the signature used. Returns false if it was already spent. */
export async function burnDeploySignature(store: KvStore, signature: Hex): Promise<boolean> {
  return store.setIfAbsent(nonceKey(signature), '1', DEPLOY_SIGNATURE_TTL_SECONDS * 2);
}

// ---------------------------------------------------------------------------
// Dispatch + run discovery
// ---------------------------------------------------------------------------

export type DispatchResult = { ok: true } | { ok: false; status: number; detail: string };

export async function dispatchBridgeDeploy(message: BridgeDeployMessage): Promise<DispatchResult> {
  if (!dispatchToken()) {
    return { ok: false, status: 503, detail: 'GITHUB_DISPATCH_TOKEN is not configured on the server' };
  }
  const url = `https://api.github.com/repos/${deployRepo()}/actions/workflows/${BRIDGE_DEPLOY_WORKFLOW}/dispatches`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...ghHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: BRIDGE_DEPLOY_REF,
        inputs: {
          step: message.step,
          owner: message.owner,
          validator: message.validator,
          guardian: message.guardian,
          confirm: message.confirm,
        },
      }),
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, status: 502, detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 204) return { ok: true };
  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, detail: text.slice(0, 400) };
}

export interface DeployRun {
  id: number;
  runNumber: number;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

interface GhRun {
  id: number;
  run_number: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

export async function listBridgeDeployRuns(limit = 6): Promise<DeployRun[]> {
  const url = `https://api.github.com/repos/${deployRepo()}/actions/workflows/${BRIDGE_DEPLOY_WORKFLOW}/runs?event=workflow_dispatch&per_page=${limit}`;
  const res = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`github runs ${res.status}`);
  const body = (await res.json()) as { workflow_runs?: GhRun[] };
  return (body.workflow_runs ?? []).map((r) => ({
    id: r.id,
    runNumber: r.run_number,
    status: r.status,
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
    createdAt: r.created_at,
  }));
}

export interface RenderedAddresses {
  branch: string;
  core: Record<string, Address>;
  ethereumRouter?: Address;
  eticaRouter?: Address;
  eticaFeeContract?: Address;
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, '');
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Flat `key: "0x…"` document the CLI writes for `chains/etica/addresses.yaml`. */
export function parseCoreAddresses(yaml: string): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const line of yaml.split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const v = stripQuotes(m[2]);
    if (ADDRESS_RE.test(v)) out[m[1]] = v as Address;
  }
  return out;
}

/** `tokens:` list of the rendered warp config -> router per chain. */
export function parseWarpRouters(yaml: string): Partial<Record<'ethereum' | 'etica', Address>> {
  const items: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of yaml.split('\n')) {
    const start = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (start) {
      current = { [start[1]]: stripQuotes(start[2]) };
      items.push(current);
      continue;
    }
    const kv = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv && current) current[kv[1]] = stripQuotes(kv[2]);
  }
  const out: Partial<Record<'ethereum' | 'etica', Address>> = {};
  for (const it of items) {
    const chain = it.chainName;
    const addr = it.addressOrDenom;
    if ((chain === 'ethereum' || chain === 'etica') && addr && ADDRESS_RE.test(addr)) {
      out[chain] = addr as Address;
    }
  }
  return out;
}

async function rawFile(branch: string, path: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${deployRepo()}/${encodeURIComponent(branch)}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${path} ${res.status}`);
  return res.text();
}

/** Addresses the workflow pushed to `bridge-deploy/<run_id>`, if any. */
export async function renderedAddressesForRun(runId: number): Promise<RenderedAddresses | null> {
  const branch = `bridge-deploy/${runId}`;
  const [core, warp, fee] = await Promise.all([
    rawFile(branch, REGISTRY_CORE_PATH),
    rawFile(branch, REGISTRY_WARP_PATH),
    rawFile(branch, REGISTRY_FEE_PATH),
  ]);
  if (core === null && warp === null && fee === null) return null;
  const routers = warp ? parseWarpRouters(warp) : {};
  const feeAddr = fee ? stripQuotes(fee) : '';
  return {
    branch,
    core: core ? parseCoreAddresses(core) : {},
    ethereumRouter: routers.ethereum,
    eticaRouter: routers.etica,
    eticaFeeContract: ADDRESS_RE.test(feeAddr) ? (feeAddr as Address) : undefined,
  };
}

export async function coreDeployedOnMain(): Promise<boolean> {
  try {
    return (await rawFile(BRIDGE_DEPLOY_REF, REGISTRY_CORE_PATH)) !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BridgeDeployPreflight {
  roles: typeof BRIDGE_ROLES;
  ethereum: { chainId: number | null; balanceEth: string; gasPriceGwei: string; estimatedCostEth: string; error?: string };
  etica: { chainId: number | null; balanceEgaz: string; error?: string };
  routeLive: boolean;
  coreDeployed: boolean;
  dispatchConfigured: boolean;
  checks: PreflightCheck[];
  ready: boolean;
  generatedAt: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function bridgeDeployPreflight(): Promise<BridgeDeployPreflight> {
  const keeper = BRIDGE_ROLES.keeper;
  const ethereum = createPublicClient({
    chain: mainnet,
    transport: fallback(
      ETHEREUM_PUBLIC_RPCS.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: false },
    ),
  });
  const etica = createPublicClient({
    chain: eticaMainnet,
    transport: fallback(
      eticaMainnet.rpcUrls.default.http.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: false },
    ),
  });

  const [ethRes, etiRes, coreDeployed] = await Promise.all([
    Promise.all([ethereum.getChainId(), ethereum.getBalance({ address: keeper }), ethereum.getGasPrice()])
      .then(([chainId, balance, gasPrice]) => ({ chainId, balance, gasPrice, error: undefined as string | undefined }))
      .catch((err: unknown) => ({ chainId: null, balance: 0n, gasPrice: 0n, error: errText(err) })),
    Promise.all([etica.getChainId(), etica.getBalance({ address: keeper })])
      .then(([chainId, balance]) => ({ chainId, balance, error: undefined as string | undefined }))
      .catch((err: unknown) => ({ chainId: null, balance: 0n, error: errText(err) })),
    coreDeployedOnMain(),
  ]);

  const estimatedCost = WARP_DEPLOY_GAS * ethRes.gasPrice;
  const routeLive = isUsdcWarpRouteLive();
  const dispatchConfigured = dispatchToken().length > 0;

  const checks: PreflightCheck[] = [
    {
      label: 'Ethereum RPC answers as mainnet (chain 1)',
      ok: ethRes.chainId === 1,
      detail: ethRes.error ?? `chain ${ethRes.chainId}`,
    },
    {
      label: 'Etica RPC answers as mainnet (chain 61803)',
      ok: etiRes.chainId === eticaMainnet.id,
      detail: etiRes.error ?? `chain ${etiRes.chainId}`,
    },
    {
      label: 'Keeper holds >= 0.05 ETH',
      ok: ethRes.balance >= MIN_KEEPER_ETH_WEI,
      detail: `${formatEther(ethRes.balance)} ETH`,
    },
    {
      label: 'Keeper ETH covers 2x the warp deploy at the current gas price',
      ok: ethRes.gasPrice > 0n && ethRes.balance >= 2n * estimatedCost,
      detail: `${formatGwei(ethRes.gasPrice)} gwei -> ~${formatEther(estimatedCost)} ETH for ${WARP_DEPLOY_GAS.toLocaleString()} gas`,
    },
    {
      label: 'Keeper holds >= 5 EGAZ',
      ok: etiRes.balance >= MIN_KEEPER_EGAZ_WEI,
      detail: `${formatEther(etiRes.balance)} EGAZ`,
    },
    {
      label: 'Server can dispatch the deploy workflow',
      ok: dispatchConfigured,
      detail: dispatchConfigured ? 'GITHUB_DISPATCH_TOKEN present' : 'GITHUB_DISPATCH_TOKEN missing on Vercel',
    },
    {
      label: 'USDC.e route not already wired into the app',
      ok: !routeLive,
      detail: routeLive
        ? 'USDC_WARP_ROUTE already has live addresses — a new deploy would create a second route'
        : 'packages/shared USDC_WARP_ROUTE still zero',
    },
  ];

  return {
    roles: BRIDGE_ROLES,
    ethereum: {
      chainId: ethRes.chainId,
      balanceEth: formatEther(ethRes.balance),
      gasPriceGwei: formatGwei(ethRes.gasPrice),
      estimatedCostEth: formatEther(estimatedCost),
      error: ethRes.error,
    },
    etica: { chainId: etiRes.chainId, balanceEgaz: formatEther(etiRes.balance), error: etiRes.error },
    routeLive,
    coreDeployed,
    dispatchConfigured,
    checks,
    ready: checks.every((c) => c.ok),
    generatedAt: new Date().toISOString(),
  };
}
