import { supportedChains } from '@etica-hub/shared/chains';

/**
 * Forces every wallet transaction on an Etica chain to be a legacy (type 0)
 * transaction with an explicit `gasPrice` and `gas`.
 *
 * Etica reports `baseFeePerGas = 0` while `eth_gasPrice` is 500 gwei. Wallets
 * that build EIP-1559 fees from the base fee produce transactions the node
 * rejects, surfaced in MetaMask as "An internal error was received" (first seen
 * on contract creation, where the wallet also has to estimate gas itself). The
 * provider-level hook below runs for every `eth_sendTransaction` the app
 * issues, through any connector, so individual call sites need no overrides.
 */

type RequestArgs = { method: string; params?: unknown };
type Request = (args: RequestArgs) => Promise<unknown>;
export type Eip1193Provider = { request: Request };

type TxFields = Record<string, unknown> & {
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

const ETICA_CHAIN_IDS = new Set<number>(supportedChains.map((c) => c.id));
const PATCHED = Symbol.for('eticahub.legacyTx');

const toHex = (n: bigint) => `0x${n.toString(16)}`;

/** Headroom over the node's estimate; estimates on Etica are exact-ish but deploys vary with state. */
const GAS_HEADROOM_NUM = 13n;
const GAS_HEADROOM_DEN = 10n;

export async function toLegacyTx(request: Request, tx: TxFields): Promise<TxFields> {
  const chainId = Number(await request({ method: 'eth_chainId' }));
  if (!ETICA_CHAIN_IDS.has(chainId)) return tx;

  const { maxFeePerGas: _mf, maxPriorityFeePerGas: _mp, ...rest } = tx;
  void _mf;
  void _mp;

  const [gasPrice, gas] = await Promise.all([
    rest.gasPrice ?? (request({ method: 'eth_gasPrice' }) as Promise<string>),
    rest.gas ??
      (
        request({
          method: 'eth_estimateGas',
          params: [
            {
              from: rest.from,
              to: rest.to,
              data: rest.data ?? rest.input,
              value: rest.value,
            },
          ],
        }) as Promise<string>
      ).then((est) => toHex((BigInt(est) * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN)),
  ]);

  return { ...rest, type: '0x0', gasPrice, gas };
}

/**
 * Patches `provider.request` in place so `eth_sendTransaction` goes through
 * {@link toLegacyTx}. Idempotent; leaves providers it cannot patch untouched.
 */
export function withLegacyTxs<P>(provider: P): P {
  const p = provider as (Eip1193Provider & { [PATCHED]?: true }) | null | undefined;
  if (!p || typeof p.request !== 'function' || p[PATCHED]) return provider;
  const raw = p.request.bind(p);
  const patched: Request = async (args) => {
    const params = args?.params;
    if (args?.method === 'eth_sendTransaction' && Array.isArray(params) && params[0]) {
      const tx = await toLegacyTx(raw, params[0] as TxFields);
      return raw({ ...args, params: [tx, ...params.slice(1)] });
    }
    return raw(args);
  };
  try {
    p.request = patched;
    p[PATCHED] = true;
  } catch {
    /* frozen provider: fall back to the wallet's own fee builder */
  }
  return provider;
}
