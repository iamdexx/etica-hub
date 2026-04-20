# EticaHub FAQ

## What is EticaHub?

A single site that combines three dapps on the Etica chain:

1. **EticaSwap V2** — the first on-chain DEX for ETI / EGAZ / ERC-20 pairs.
   Uniswap V2 fork. Live on local fork, not yet on mainnet.
2. **Research Hub** — browse Etica research proposals, read IPFS content,
   tip authors in ETI, subscribe to your favorite researchers. Live on local
   fork, not yet on mainnet.
3. **Bridge** — lock ETI on Etica, mint wETI on Ethereum (and back).
   Contracts + relayer + UI complete; NOT deployed anywhere, pending audit.

## Does EticaHub have a testnet?

**Partly.** Etica has an official Crucible testnet (chain ID `61888`,
RPC `http://173.212.202.226:8545`), but in practice it's limited:

- **No public faucet.** The official `eti-faucet` repo has never been
  publicly hosted. `yogurt.rocks/faucet` is permanently offline.
- **One HTTP-only RPC on a non-standard port.** Many cloud/VM providers
  block non-443 egress, so infra devs often can't use it.
- **Near-zero activity.** You can query blocks but there's very little to
  interact with.

For development and PR validation, EticaHub uses a **local anvil fork of
Etica mainnet** (chain ID `31337`). It has the real ETI contract, real
liquidity patterns, real proposal state — but zero real funds and instant
transactions. This gives a better test surface than Crucible would.

If you need real testnet EGAZ for Crucible, ask in the Etica Telegram:
https://t.me/eticaprotocol. The core team has historically sent dev EGAZ
on request.

## Is anything deployed to mainnet?

**No.** Every `DEPLOYMENTS` / `BRIDGE_ETHEREUM_DEPLOYMENTS` entry in
`packages/shared/src/addresses.ts` is still placeholder zeros. The UI
explicitly disables actions and explains the state on each page.

See `docs/DEPLOYMENT_RUNBOOK.md` for the promotion path.

## Who controls the treasury?

The treasury address `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` (the
repo owner's address) is the `feeToSetter` on the swap factory and the
`feeTreasury` on the bridge. Once the project has a DAO or multisig, those
roles should be transferred.

## What is the tokenomics plan for the ETX reward token?

- **100M fixed supply.**
- **20% treasury** on a 4-year linear vest, 6-month cliff.
- **10% team / ops reserve** on a 4-year vest.
- **70% to emissions** over 4 years — farmers on ETI-paired LP pools and
  xETX stakers.
- **0.05% of every swap fee** auto-swaps to ETI and is distributed to xETX
  stakers (the "Option B hybrid" model).

Details in `packages/contracts/src/etx/`. Not deployed.

## How does the bridge work?

Lock-and-mint with a 2-of-3 ECDSA multisig attestation.

1. You lock `X` ETI in `EticaBridgeVault` on Etica (no fee).
2. Each validator watches the `Deposited` event, signs an EIP-191 personal
   message over `keccak256(abi.encode(srcChainId, dstChainId, srcTxHash, nonce, token, amount, recipient))`,
   and submits to the coordinator.
3. The coordinator aggregates signatures. When `threshold` is reached, you
   can submit `mint()` on `EthereumBridgeMinter`, which verifies the
   signatures and mints `X − fee` wETI to the recipient. The fee goes to
   `feeTreasury`.
4. Reverse direction is symmetric: burn wETI on Ethereum (no fee) →
   withdraw ETI on Etica with fee.

Key invariant: `vault.ETI balance == wETI.totalSupply` at all times.

See `docs/BRIDGE_AUDIT_SCOPE.md` for the full trust model.

## What are the fees?

- **Swap:** 0.30% Uniswap V2 default. 1/6 of that (0.05%) will route to
  xETX stakers once the `FeeRouter` is wired in.
- **Research tips / subscriptions:** no platform fee in MVP.
- **Bridge:** charged only on the destination side. Default fee basis
  points in `EthereumBridgeMinter` / `EticaBridgeVault` — adjustable by
  admin within `MAX_FEE_BPS`.

## Is the code audited?

Not yet. EticaSwap V2 contracts are a minimally-modified Uniswap V2 fork
(audited upstream) but the fork itself has not been re-audited. ETX, the
subscription contract, and the bridge all need audit before any real
deployment.

## How do I contribute?

- Issues and PRs welcome at https://github.com/iamdexx/etica-hub.
- Run the test suite first: `pnpm --filter @etica-hub/contracts test`
  (41 tests) and `pnpm --filter @etica-hub/relayer test` (11 tests).
- Follow existing conventions in the module you're touching.
