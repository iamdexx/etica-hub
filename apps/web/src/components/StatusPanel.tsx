import { createPublicClient, formatUnits, http, type Address } from 'viem';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  TREASURY_ADDRESS,
  abis,
  eticaMainnet,
} from '@etica-hub/shared';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

const reactorMiniAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'feeController',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const feeControllerMiniAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'FEE_CAP_BPS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

type ReactorState = {
  reactor: Address;
  reactorOwner: Address;
  reactorFeeController: Address;
  controller: Address | null;
  controllerOwner: Address | null;
  controllerTreasury: Address | null;
  controllerFeeBps: bigint | null;
  controllerFeeCapBps: bigint | null;
};

type Snapshot = {
  timestampMs: number;
  factoryFeeTo: Address;
  factoryFeeToSetter: Address;
  factoryPairCount: bigint;
  factoryPairCreationFee: bigint;
  etxTotalSupply: bigint;
  etxTreasuryBalance: bigint;
  treasuryIsTrustedCreator: boolean;
  eti_etx: { pair: Address; reserveEti: bigint; reserveEtx: bigint } | null;
  egaz_etx: { pair: Address; reserveEgaz: bigint; reserveEtx: bigint } | null;
  reactor: ReactorState | null;
};

async function loadSnapshot(): Promise<Snapshot | { error: string }> {
  const d = DEPLOYMENTS[61803];
  const e = EXTERNAL_ADDRESSES[61803];
  if (d.swapFactory === ZERO || d.etx === ZERO) {
    return { error: 'Mainnet addresses not wired into shared package.' };
  }
  const client = createPublicClient({ chain: eticaMainnet, transport: http() });

  try {
    const [
      feeTo,
      feeToSetter,
      pairCount,
      pairCreationFee,
      etxTotalSupply,
      etxTreasuryBalance,
      treasuryTrusted,
      etiEtxPair,
      egazEtxPair,
    ] = await Promise.all([
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'feeTo',
      }) as Promise<Address>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'feeToSetter',
      }) as Promise<Address>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'allPairsLength',
      }) as Promise<bigint>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'pairCreationFee',
      }) as Promise<bigint>,
      client.readContract({
        abi: abis.erc20Abi,
        address: d.etx,
        functionName: 'totalSupply',
      }) as Promise<bigint>,
      client.readContract({
        abi: abis.erc20Abi,
        address: d.etx,
        functionName: 'balanceOf',
        args: [TREASURY_ADDRESS],
      }) as Promise<bigint>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'trustedCreators',
        args: [TREASURY_ADDRESS],
      }) as Promise<boolean>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'getPair',
        args: [e.eti, d.etx],
      }) as Promise<Address>,
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'getPair',
        args: [d.wegaz, d.etx],
      }) as Promise<Address>,
    ]);

    async function loadPool(
      pair: Address,
      tokenA: Address,
    ): Promise<{ pair: Address; reserveA: bigint; reserveB: bigint } | null> {
      if (pair === ZERO) return null;
      const [reserves, token0] = await Promise.all([
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'getReserves',
        }) as Promise<readonly [bigint, bigint, number]>,
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'token0',
        }) as Promise<Address>,
      ]);
      const aIsToken0 = token0.toLowerCase() === tokenA.toLowerCase();
      return {
        pair,
        reserveA: aIsToken0 ? reserves[0] : reserves[1],
        reserveB: aIsToken0 ? reserves[1] : reserves[0],
      };
    }

    async function loadReactor(): Promise<ReactorState | null> {
      if (d.dutchReactor === ZERO) return null;
      const [reactorOwner, reactorFeeController] = await Promise.all([
        client.readContract({
          abi: reactorMiniAbi,
          address: d.dutchReactor,
          functionName: 'owner',
        }) as Promise<Address>,
        client.readContract({
          abi: reactorMiniAbi,
          address: d.dutchReactor,
          functionName: 'feeController',
        }) as Promise<Address>,
      ]);

      const ctrl = d.etxFeeController !== ZERO ? d.etxFeeController : null;
      if (!ctrl) {
        return {
          reactor: d.dutchReactor,
          reactorOwner,
          reactorFeeController,
          controller: null,
          controllerOwner: null,
          controllerTreasury: null,
          controllerFeeBps: null,
          controllerFeeCapBps: null,
        };
      }
      const [cOwner, cTreasury, cFeeBps, cCap] = await Promise.all([
        client.readContract({
          abi: feeControllerMiniAbi,
          address: ctrl,
          functionName: 'owner',
        }) as Promise<Address>,
        client.readContract({
          abi: feeControllerMiniAbi,
          address: ctrl,
          functionName: 'treasury',
        }) as Promise<Address>,
        client.readContract({
          abi: feeControllerMiniAbi,
          address: ctrl,
          functionName: 'feeBps',
        }) as Promise<bigint>,
        client.readContract({
          abi: feeControllerMiniAbi,
          address: ctrl,
          functionName: 'FEE_CAP_BPS',
        }) as Promise<bigint>,
      ]);
      return {
        reactor: d.dutchReactor,
        reactorOwner,
        reactorFeeController,
        controller: ctrl,
        controllerOwner: cOwner,
        controllerTreasury: cTreasury,
        controllerFeeBps: cFeeBps,
        controllerFeeCapBps: cCap,
      };
    }

    const [etiEtx, egazEtx, reactor] = await Promise.all([
      loadPool(etiEtxPair, e.eti),
      loadPool(egazEtxPair, d.wegaz),
      loadReactor(),
    ]);

    return {
      timestampMs: Date.now(),
      factoryFeeTo: feeTo,
      factoryFeeToSetter: feeToSetter,
      factoryPairCount: pairCount,
      factoryPairCreationFee: pairCreationFee,
      etxTotalSupply,
      etxTreasuryBalance,
      treasuryIsTrustedCreator: treasuryTrusted,
      eti_etx: etiEtx
        ? { pair: etiEtx.pair, reserveEti: etiEtx.reserveA, reserveEtx: etiEtx.reserveB }
        : null,
      egaz_etx: egazEtx
        ? {
            pair: egazEtx.pair,
            reserveEgaz: egazEtx.reserveA,
            reserveEtx: egazEtx.reserveB,
          }
        : null,
      reactor,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Read failed' };
  }
}

export async function StatusPanel() {
  const snap = await loadSnapshot();
  const d = DEPLOYMENTS[61803];
  const e = EXTERNAL_ADDRESSES[61803];

  return (
    <div className="space-y-6">
      <AddressTable
        rows={[
          ['ETX', d.etx],
          ['WEGAZ', d.wegaz],
          ['Factory', d.swapFactory],
          ['Router', d.swapRouter],
          ['Permit2', d.permit2],
          ['DutchOrderReactor', d.dutchReactor],
          ['EticaProtocolFeeController', d.etxFeeController],
          ['ETI (external)', e.eti],
          ['Treasury', TREASURY_ADDRESS],
        ]}
      />

      {'error' in snap ? (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-200">
          Live read failed: {snap.error}
        </div>
      ) : (
        <>
          <Section title="Factory">
            <KV k="feeTo" v={formatFeeTo(snap.factoryFeeTo)} />
            <KV k="feeToSetter" v={shortAddr(snap.factoryFeeToSetter)} />
            <KV k="allPairsLength" v={snap.factoryPairCount.toString()} />
            <KV
              k="pairCreationFee"
              v={`${Number(formatUnits(snap.factoryPairCreationFee, 18)).toLocaleString()} ETX`}
            />
            <KV
              k="trustedCreators[treasury]"
              v={snap.treasuryIsTrustedCreator ? 'true' : 'false'}
            />
          </Section>

          <Section title="ETX token">
            <KV
              k="totalSupply"
              v={`${Number(formatUnits(snap.etxTotalSupply, 18)).toLocaleString()} ETX`}
            />
            <KV
              k="treasury balance"
              v={`${Number(formatUnits(snap.etxTreasuryBalance, 18)).toLocaleString()} ETX`}
            />
          </Section>

          <Section title="ETI / ETX pool">
            {snap.eti_etx ? (
              <>
                <KV k="pair" v={shortAddr(snap.eti_etx.pair)} />
                <KV
                  k="reserve ETI"
                  v={`${Number(formatUnits(snap.eti_etx.reserveEti, 18)).toLocaleString()}`}
                />
                <KV
                  k="reserve ETX"
                  v={`${Number(formatUnits(snap.eti_etx.reserveEtx, 18)).toLocaleString()}`}
                />
              </>
            ) : (
              <p className="text-sm text-rose-300">No pair deployed.</p>
            )}
          </Section>

          <Section title="UniswapX reactor + fee controller">
            {snap.reactor ? (
              <>
                <KV k="reactor" v={shortAddr(snap.reactor.reactor)} />
                <KV k="reactor owner" v={shortAddr(snap.reactor.reactorOwner)} />
                <KV
                  k="reactor.feeController()"
                  v={shortAddr(snap.reactor.reactorFeeController)}
                />
                <KV
                  k="fee controller"
                  v={
                    snap.reactor.controller
                      ? shortAddr(snap.reactor.controller)
                      : '0x0 (not wired)'
                  }
                />
                {snap.reactor.controller && (
                  <>
                    <KV
                      k="controller.owner"
                      v={shortAddr(snap.reactor.controllerOwner ?? ZERO)}
                    />
                    <KV
                      k="controller.treasury"
                      v={shortAddr(snap.reactor.controllerTreasury ?? ZERO)}
                    />
                    <KV
                      k="controller.feeBps"
                      v={
                        snap.reactor.controllerFeeBps === 0n
                          ? '0 bps (fees off)'
                          : `${snap.reactor.controllerFeeBps?.toString() ?? '—'} bps`
                      }
                    />
                    <KV
                      k="FEE_CAP_BPS"
                      v={`${snap.reactor.controllerFeeCapBps?.toString() ?? '—'} bps`}
                    />
                  </>
                )}
              </>
            ) : (
              <p className="text-sm text-amber-300">
                Reactor not deployed yet. Run <span className="font-mono">/deploy/trading</span>{' '}
                (operator only) to bring the non-custodial trading stack online.
              </p>
            )}
          </Section>

          <Section title="EGAZ / ETX pool (via WEGAZ)">
            {snap.egaz_etx ? (
              <>
                <KV k="pair" v={shortAddr(snap.egaz_etx.pair)} />
                <KV
                  k="reserve EGAZ"
                  v={`${Number(formatUnits(snap.egaz_etx.reserveEgaz, 18)).toLocaleString()}`}
                />
                <KV
                  k="reserve ETX"
                  v={`${Number(formatUnits(snap.egaz_etx.reserveEtx, 18)).toLocaleString()}`}
                />
              </>
            ) : (
              <p className="text-sm text-rose-300">No pair deployed.</p>
            )}
          </Section>

          <p className="text-xs text-white/40">
            Snapshot taken {new Date(snap.timestampMs).toISOString()}. Refreshed on every page load.
          </p>
        </>
      )}
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-sm font-medium text-white/70">{props.title}</h2>
      <dl className="space-y-1 text-sm">{props.children}</dl>
    </section>
  );
}

function KV(props: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-white/50">{props.k}</dt>
      <dd className="font-mono text-white/85">{props.v}</dd>
    </div>
  );
}

function AddressTable(props: { rows: ReadonlyArray<readonly [string, Address]> }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-sm font-medium text-white/70">Addresses (chain 61803)</h2>
      <dl className="space-y-1 text-sm">
        {props.rows.map(([label, addr]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-white/50">{label}</dt>
            <dd>
              <a
                className="font-mono text-emerald-300 underline decoration-emerald-300/30 hover:decoration-emerald-300"
                href={`https://eticascan.org/address/${addr}`}
                target="_blank"
                rel="noreferrer"
              >
                {addr}
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function shortAddr(a: Address): string {
  if (a === ZERO) return '0x0 (unset)';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatFeeTo(a: Address): string {
  if (a === ZERO) return '0x0 (bootstrap — pool-creation fee disabled)';
  return shortAddr(a);
}
