# EticaHub Deployment Runbook

Step-by-step commands to promote each phase from "tested locally" to a live
chain. Every command that moves real value runs on **your** machine with
**your** key. The VM never signs a mainnet transaction.

Legend:
- 🟢 safe to run unattended (testnet, local fork, read-only)
- 🟡 requires review (testnet deploy that will burn gas)
- 🔴 irreversible on mainnet — require audit sign-off + full backup first

## 0. Shared Setup (once per machine)

```bash
git clone https://github.com/iamdexx/etica-hub && cd etica-hub
pnpm install
pnpm --filter @etica-hub/contracts build  # forge build
pnpm --filter @etica-hub/contracts test   # 41 passing
```

Environment variables you will need (put in `.env`, never commit — already
gitignored):

```bash
DEPLOYER_PRIVATE_KEY=0x<your_key>                      # required for any deploy
TREASURY_ADDRESS=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
FEE_TREASURY_ADDRESS=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
VALIDATOR_1=0x...   # 3 validator addresses for the 2-of-3 multisig
VALIDATOR_2=0x...
VALIDATOR_3=0x...
BRIDGE_THRESHOLD=2
```

RPC endpoints:

```bash
ETICA_MAINNET_RPC=https://eticamainnet.eticascan.org
ETICA_CRUCIBLE_RPC=http://173.212.202.226:8545
ETH_MAINNET_RPC=https://eth.llamarpc.com    # or your own Alchemy/Infura
ETH_SEPOLIA_RPC=https://sepolia.drpc.org
```

## 1. Phase 1 — EticaSwap V2

### 1.0 🟢 Preferred path — deploy via the EticaHub webapp

For operators who would rather not hand their private key to a CLI, the app
ships a browser-based deployer at `/deploy/swap`. It embeds the same compiled
bytecode as `DeploySwap.s.sol` but signs every transaction via your connected
wallet (MetaMask, hardware wallet through MetaMask, WalletConnect). The private
key never leaves the wallet.

1. Open the live site (or a preview URL) at `/deploy/swap`.
2. Connect MetaMask and switch to Etica Mainnet (61803). The page offers a
   one-click "Switch network" that will also add the chain if needed.
3. Confirm the treasury / `feeToSetter` address (defaults to
   `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`).
4. Click **Deploy** on each of the three cards in order: WEGAZ → Factory →
   Router. Each click prompts a single MetaMask signature.
5. Once all three go to "Deployed", copy the summary block at the bottom of
   the page and paste it wherever the addresses need to be recorded (the
   next step wires them into `packages/shared/src/addresses.ts`).

If you prefer a terminal flow — or need unattended / scripted deploys —
continue to §1.1 / §1.2 below. The end state is identical.

### 1.1 🟡 Crucible testnet deploy

```bash
cd packages/contracts
forge script script/DeploySwap.s.sol \
  --rpc-url $ETICA_CRUCIBLE_RPC \
  --broadcast \
  --legacy
```

Record the three addresses from the broadcast output:

- `WEGAZ` → paste into `packages/shared/src/addresses.ts` under `DEPLOYMENTS[61888].wegaz`
- `EticaSwapFactory` → `DEPLOYMENTS[61888].swapFactory`
- `EticaSwapRouter` → `DEPLOYMENTS[61888].swapRouter`

Commit + PR. CI will rerun typecheck/build against the new addresses.

### 1.2 🔴 Etica mainnet deploy

Identical to 1.1 with `--rpc-url $ETICA_MAINNET_RPC`. Prerequisites:

- PR #3 merged (live swap UI verified on fork).
- You have enough EGAZ for deployment gas.
- You are running this from a machine you trust, with a hardware wallet if
  possible (`--ledger --hd-paths "m/44'/60'/0'/0/0"` instead of
  `DEPLOYER_PRIVATE_KEY`).

After deploy, update `DEPLOYMENTS[61803]` with the three addresses and push.

Factory `feeToSetter` is already your treasury; `feeTo` stays unset until you
turn ETX rewards on. No rewards means the Router keeps 0.30% of each swap
inside the pool as LP yield, Uniswap V2 default.

## 2. Phase 2a — ETX Reward Stack (held)

Not deployed in MVP. When you're ready:

```bash
forge script script/DeployETX.s.sol \
  --rpc-url $ETICA_MAINNET_RPC \
  --broadcast \
  --legacy
```

This deploys `ETX`, `MasterChef`, `xETXVault`, `FeeRouter`, and the vesting
contracts with the 20/10/70 split + 4-year vests wired to your treasury.

After deploy, call `Factory.setFeeTo(feeRouter)` to start routing 1/6 of the
Router fee into the `FeeRouter`, which auto-swaps to ETI and distributes to
xETX stakers.

**Coordinate marketing + liquidity seeding before flipping `setFeeTo`.**

## 3. Phase 2b — Research Hub

### 3.1 🟡 Crucible

```bash
forge script script/DeployResearchSubscription.s.sol \
  --rpc-url $ETICA_CRUCIBLE_RPC \
  --broadcast \
  --legacy
```

Update `DEPLOYMENTS[61888].researchSubscription`.

### 3.2 🔴 Etica mainnet

Same command with `$ETICA_MAINNET_RPC`. The indexer reads Etica core contract
events — nothing to deploy there.

## 4. Phase 3 — Bridge

**Audit must be complete before ANY Ethereum-side deploy.** See
`docs/BRIDGE_AUDIT_SCOPE.md`.

### 4.1 🟡 Testnet deploy (Crucible ↔ Sepolia)

Etica Crucible side:

```bash
forge script script/DeployBridgeVault.s.sol \
  --rpc-url $ETICA_CRUCIBLE_RPC \
  --broadcast \
  --legacy \
  --sig "run(address[],uint256,address)" \
  "[$VALIDATOR_1,$VALIDATOR_2,$VALIDATOR_3]" $BRIDGE_THRESHOLD $FEE_TREASURY_ADDRESS
```

Sepolia side:

```bash
forge script script/DeployBridgeMinter.s.sol \
  --rpc-url $ETH_SEPOLIA_RPC \
  --broadcast \
  --sig "run(address[],uint256,address)" \
  "[$VALIDATOR_1,$VALIDATOR_2,$VALIDATOR_3]" $BRIDGE_THRESHOLD $FEE_TREASURY_ADDRESS
```

This will deploy `WrappedETI` + `EthereumBridgeMinter` + `MultisigVerifier`
and wire them together.

Update:

- `DEPLOYMENTS[61888].bridgeVault`
- `BRIDGE_ETHEREUM_DEPLOYMENTS[11155111].{weti,bridgeMinter,bridgeVerifier}`

### 4.2 Stand up the coordinator

```bash
cd apps/relayer
cp .env.example .env
# set MODE=coordinator, COORDINATOR_PORT=4000, VALIDATOR_ADDRESSES, THRESHOLD
pnpm dev:coordinator
```

Put the coordinator behind HTTPS (Caddy or nginx). Set
`NEXT_PUBLIC_BRIDGE_COORDINATOR_URL` in `apps/web/.env.production` to the
HTTPS URL.

### 4.3 Stand up each validator (one per operator host)

```bash
# on validator host 1, 2, 3 — do not colocate with the coordinator
cp .env.example .env
# set MODE=signer, VALIDATOR_PRIVATE_KEY=<key held ONLY on this host>,
#     COORDINATOR_URL, SRC_CHAIN, RPC_URL, VAULT_ADDRESS or MINTER_ADDRESS
pnpm dev:signer
```

**Validator keys never transit the coordinator, the VM, or any Devin
infrastructure.** Each operator generates and stores their own key on their
own machine. HSM / cloud KMS is strongly preferred.

### 4.4 Smoke test on testnet

1. Lock 1 ETI on Crucible via the `/bridge` UI. Copy the nonce.
2. Watch each validator log a `signed nonce=…` line.
3. Watch the coordinator log `threshold reached`.
4. Switch wallet to Sepolia. Paste the nonce into the Claim card. Submit.
5. Confirm wETI balance = 1 ETI − fee.
6. Reverse direction (burn wETI, withdraw ETI).

### 4.5 🔴 Mainnet promotion

Only after:

- Audit complete, all high/critical findings fixed + re-reviewed.
- §4.4 smoke test passes at least 10x end-to-end on testnet.
- Fee treasury confirmed as a multisig (not an EOA).
- Validator key management confirmed with each operator.

Mainnet commands mirror §4.1 with mainnet RPCs.

## 5. Rollback / Incident Response

- **A single validator is compromised.** Keep going — the 2-of-3 threshold
  tolerates 1 malicious or offline validator. Rotate the key on the operator
  host, update the validator set on both contracts (Phase 3.5 admin multisig
  required).
- **Threshold of validators compromised.** Pause the bridge via
  `pauseMint()` / `pauseWithdraw()` (admin multisig). All in-flight deposits
  and burns become reclaimable only after a governance-signed emergency
  withdraw. This is the single worst-case; audit should confirm the pause
  path cannot itself be used adversarially.
- **Coordinator down.** Spin up a replacement. Validators will resubmit
  signatures on their next polling cycle. No signatures are lost (they re-sign
  from the on-chain event log).
- **Contract bug post-deploy.** Bridge contracts are not upgradeable in MVP.
  A bug that affects solvency requires a migration: pause → deploy v2 → DAO
  vote to point the UI and validators at v2 → users re-bridge. Document this
  explicitly in the audit report.

## 6. Checklist Before Any Mainnet Button

- [ ] Audit report received, all ≥high findings fixed.
- [ ] Fee treasury address is a multisig.
- [ ] Validator set confirmed with each operator, keys hardware-backed.
- [ ] Coordinator behind HTTPS with monitoring + alerting.
- [ ] `NEXT_PUBLIC_BRIDGE_COORDINATOR_URL` points at production.
- [ ] All `DEPLOYMENTS` / `BRIDGE_ETHEREUM_DEPLOYMENTS` entries updated
      and committed.
- [ ] Smoke test passed ≥10x on testnet with the exact validator set that
      will run on mainnet.
- [ ] Rollback playbook printed and shared with operators.
