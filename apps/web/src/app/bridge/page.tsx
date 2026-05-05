import { BridgeStatusBoard } from '@/components/bridge/BridgeStatusBoard';
import { BridgeFlowsCard } from '@/components/bridge/BridgeFlowsCard';
import { BridgeParamsTable } from '@/components/bridge/BridgeParamsTable';
import { BridgeAddressBook } from '@/components/bridge/BridgeAddressBook';

export const metadata = { title: 'Bridge · EticaHub' };

export default function BridgePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">ETX bridge</h1>
        <p className="mt-1 text-sm text-white/60">
          Move ETX between Etica and external chains. Deposits lock ETX on Etica and mint{' '}
          <strong>wETX</strong> on Ethereum or BNB after a 48 h challenge window. Burning wETX on a
          remote chain unlocks the underlying ETX back on Etica. The bridge runs on Hyperlane rails
          with an optimistic-veto layer — no liquidity provider, no validator multisig, no permission
          to bridge.
        </p>
      </div>

      <BridgeStatusBoard />
      <BridgeFlowsCard />
      <BridgeParamsTable />
      <BridgeAddressBook />

      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
        <div className="font-medium text-white/70">How a deposit moves</div>
        <ol className="mt-1 list-decimal pl-5 space-y-1">
          <li>
            You call <code className="font-mono">deposit(destination, recipient, amount)</code> on{' '}
            <code className="font-mono">BridgeVault</code> on Etica. The contract takes a 0.1% fee
            and emits a Hyperlane message to the destination chain.
          </li>
          <li>
            A relayer posts the message on the destination minter. A bonded submitter calls{' '}
            <code className="font-mono">submitClaim</code> with 25% of the amount as a refundable
            bond — the claim is now in a 48 h challenge window.
          </li>
          <li>
            During those 48 h the operator can veto fraudulent claims. Anyone can also veto by
            submitting a Merkle proof against an Etica state root (community fraud-prover layer).
          </li>
          <li>
            After 48 h pass without a veto the claim auto-executes — the watcher bot pays the gas so
            recipients receive wETX without any extra steps. Submitter bond is refunded.
          </li>
        </ol>
        <div className="mt-2 text-white/40">
          Burning wETX on a remote chain is the same flow in reverse — burn message goes back to
          Etica, the same 48 h window applies, and ETX is released from the vault to the recipient.
        </div>
      </div>
    </div>
  );
}
