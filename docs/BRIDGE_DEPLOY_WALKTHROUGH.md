# EticaHub Bridge — First Deploy Walkthrough

This is the step-by-step orchestration for the **first** mainnet deploy of
the Phase 3 ETX bridge. It complements the [`BRIDGE_OPS_RUNBOOK.md`](BRIDGE_OPS_RUNBOOK.md)
(day-2 reference manual) by giving the operator a single linear narrative:
do this, verify that, do the next thing.

Read [`BRIDGE_DESIGN.md`](BRIDGE_DESIGN.md) and [`BRIDGE_CONTRACT_SPEC.md`](BRIDGE_CONTRACT_SPEC.md)
first if you have not.

> **Reading guide.** Phases run **in order**. Do not skip ahead. Every
> phase has a verify step — do not start the next phase until verify
> passes. Anything tagged ⚠️ is a "stop, think, double-check before
> broadcasting" gate.

---

## Phase −1 — Pre-deploy checklist

Block out a half-day window. Have all of this ready **before** you
broadcast the first transaction.

### People & access

- [ ] Hardware wallet for `BRIDGE_OWNER` (a multisig is strongly
      recommended — 2-of-3 minimum). Same address is used on all three
      chains for symmetry.
- [ ] Hardware wallet for `vetoAuthority` on each `BridgeMinter`.
      May be the same hardware as `BRIDGE_OWNER`, but ideally a
      separate seed for blast-radius isolation.
- [ ] EOA for `heartbeatSigner` — generated fresh, private key kept
      only in GitHub Secrets (never on a personal machine).
- [ ] EOA for the auto-execute keeper — same posture as
      `heartbeatSigner`. Funded with ~0.05 ETH on Eth, ~0.05 BNB on BNB
      to start.
- [ ] One Telegram chat dedicated to operator-private alerts (NOT the
      public buy-bot channel). Bot reused from #90/#121 is fine.

### Funds

- [ ] **Etica:** ≥10M ETX in `BRIDGE_OWNER` (10M for the insurance fund
      pre-fund, plus a few hundred ETX for gas / first-deposit smoke
      test). Plus enough EGAZ for ~30 transactions of gas.
- [ ] **Ethereum:** ~0.2 ETH in the deployer EOA. Mainnet deploy gas at
      30 gwei is currently ~0.08 ETH for the full minter side.
- [ ] **BNB Chain:** ~0.05 BNB in the deployer EOA.

### External addresses (must be locked **before** the first broadcast)

- [ ] Hyperlane mailbox address on Etica.
- [ ] Hyperlane mailbox address on Ethereum.
- [ ] Hyperlane mailbox address on BNB Chain.
- [ ] ETX ERC-20 address on Etica.
- [ ] `TreasuryHarvester` address on Etica
      (already deployed — see `packages/shared/addresses`).

### Decisions to lock (write them in the address book first)

- [ ] **Initial TVL cap:** 1M ETX (per spec §3.5). Auto-raises after
      30d clean ops via timelocked op — do not pre-raise.
- [ ] **Bond:** 25% (`bondBps = 2500`).
- [ ] **Bridge fee:** 0.1% (`bridgeFeeBps = 10`).
- [ ] **Challenge window:** 48h (`challengeWindowSeconds = 172800`).
- [ ] **Per-claim cap:** 1% of TVL (`perClaimCapBps = 100`).
- [ ] **Per-day rate limit:** 5% of TVL (`dailyMintCapBps = 500`).

If you want to deviate from any of these, lock the new values in
writing **before** running the deploy script. Changing them post-deploy
costs a 24-48h timelock per parameter.

### Repo state

- [ ] On `main`, latest, all PRs through #170 merged.
- [ ] `pnpm install && pnpm -r run typecheck` clean.
- [ ] `cd packages/contracts && forge build` succeeds (~21KB
      `BridgeMinter`, ~3.4KB EIP-170 margin).
- [ ] `forge test` shows 503/503 green.

---

## Phase 0 — Deploy Etica side

Do this **first**. The Etica vault is the source of truth; its address
is needed to wire trusted-sender on each remote.

### 0.1 Broadcast

```bash
cd packages/contracts
export DEPLOYER_PRIVATE_KEY=0x...                # gas-payer (typically owner)
export BRIDGE_OWNER=0x...                         # multisig
export ETX_ADDRESS=0x...
export HYPERLANE_MAILBOX_ETICA=0x...
export ETICA_DOMAIN=61803
export HARVESTER_ADDRESS=0x...
export INSURANCE_WITHDRAW_TIMELOCK=172800
export FEE_ROUTER_SPLIT_TIMELOCK=86400
export VAULT_OP_TIMELOCK=172800

forge script script/bridge/DeployBridgeEtica.s.sol \
  --rpc-url https://rpc2.etica-stats.org \
  --broadcast --slow
```

⚠️ If `DEPLOYER_PRIVATE_KEY` is **not** `BRIDGE_OWNER`, you'll need to
run `setBridgeVault` on both `BridgeInsuranceFund` and `FeeRouter` from
the owner account in a separate transaction (each is a one-time
setter).

### 0.2 Verify

Capture the four addresses from the broadcast log:

- `BridgeVault` → `0x...`
- `BridgeInsuranceFund` → `0x...`
- `FeeRouter` → `0x...`
- `InsuranceTopUpReceiver` → `0x...`

Then on-chain:

```bash
# Vault wired correctly
cast call $VAULT 'feeRouter()(address)' --rpc-url $ETICA_RPC
cast call $VAULT 'insuranceFund()(address)' --rpc-url $ETICA_RPC
cast call $VAULT 'owner()(address)' --rpc-url $ETICA_RPC          # == BRIDGE_OWNER
cast call $VAULT 'paused()(bool)' --rpc-url $ETICA_RPC            # default false

# Insurance fund's vault setter is closed
cast call $INSURANCE 'bridgeVault()(address)' --rpc-url $ETICA_RPC # == VAULT
cast call $INSURANCE 'owner()(address)' --rpc-url $ETICA_RPC      # == BRIDGE_OWNER

# Fee router split = 20/80 insurance/harvester per spec
cast call $FEEROUTER 'insuranceShareBps()(uint16)' --rpc-url $ETICA_RPC  # 2000
cast call $FEEROUTER 'harvesterShareBps()(uint16)' --rpc-url $ETICA_RPC  # 8000
```

### 0.3 Pre-fund the insurance backstop

```bash
# From BRIDGE_OWNER
cast send $ETX_ADDRESS 'transfer(address,uint256)' \
  $INSURANCE 10000000000000000000000000 \
  --rpc-url $ETICA_RPC --private-key $OWNER_KEY
```

Then deposit it into the fund:

```bash
cast send $INSURANCE 'depositETX(uint256)' 10000000000000000000000000 \
  --rpc-url $ETICA_RPC --private-key $OWNER_KEY
cast call $INSURANCE 'totalAssets()(uint256)' --rpc-url $ETICA_RPC  # == 10M ETX wei
```

⚠️ **Stop here** if `totalAssets` is not exactly 10M ETX. The bridge
must not accept its first deposit with an under-funded backstop.

---

## Phase 1 — Deploy Ethereum minter

### 1.1 Broadcast

```bash
export DEPLOYER_PRIVATE_KEY=0x...
export BRIDGE_OWNER=0x...
export HYPERLANE_MAILBOX_REMOTE=0x...   # Eth mailbox
export SELF_DOMAIN=1
export ETICA_DOMAIN=61803
export MINTER_OP_TIMELOCK=172800
export MODULE_OP_TIMELOCK=86400
export ISM_OP_TIMELOCK=86400
export TVL_CAP_ETX_WEI=1000000000000000000000000   # 1M ETX
export BOND_BPS=2500
export BRIDGE_FEE_BPS=10
export CHALLENGE_WINDOW_SECONDS=172800
export DAILY_MINT_CAP_BPS=500
export PER_CLAIM_CAP_BPS=100

forge script script/bridge/DeployBridgeRemote.s.sol \
  --rpc-url $ETH_RPC --broadcast --slow
```

### 1.2 Verify

Capture all seven addresses (BridgeMinter, WrappedETX, OptimisticVetoModule, FraudProverModule, HeartbeatISM, TVLCapISM, RateLimitISM).

```bash
cast call $MINTER 'wETX()(address)' --rpc-url $ETH_RPC          # == WRAPPED_ETX
cast call $MINTER 'mailbox()(address)' --rpc-url $ETH_RPC       # == HYPERLANE_MAILBOX
cast call $MINTER 'eticaDomain()(uint32)' --rpc-url $ETH_RPC    # 61803
cast call $MINTER 'paused()(bool)' --rpc-url $ETH_RPC           # false
cast call $MINTER 'tvlCap()(uint256)' --rpc-url $ETH_RPC        # 1M ETX wei
cast call $MINTER 'bondBps()(uint16)' --rpc-url $ETH_RPC        # 2500
cast call $WRAPPED_ETX 'minter()(address)' --rpc-url $ETH_RPC   # == MINTER
```

⚠️ `vetoAuthority` is `address(0)` immediately after deploy — the
minter cannot be vetoed yet. This is intentional; the operator wires
it in Phase 3 once everything else is verified.

---

## Phase 2 — Deploy BNB minter

Repeat Phase 1 with `SELF_DOMAIN=56` and the BNB Hyperlane mailbox /
RPC. Capture addresses. Same verify checklist.

> The Eth and BNB minters are deployed independently and do not need
> to be aware of each other. They both bridge **to** Etica, never to
> each other.

---

## Phase 3 — Cross-chain wireup

Each step here is a 24-48h timelocked op. Plan accordingly: you queue
all of them up-front, wait, then execute them in a batch.

For every detailed `requestSet…` invocation, see
[`BRIDGE_OPS_RUNBOOK.md` §3](BRIDGE_OPS_RUNBOOK.md#3-cross-chain-wireup-run-once-per-chain-after-deploy).

### 3.1 Queue the wireup ops (T+0)

From `BRIDGE_OWNER` on each side:

**On Etica `BridgeVault`:**
- `requestSetTrustedSender(domain=1, sender=ETH_MINTER)`
- `requestSetTrustedSender(domain=56, sender=BNB_MINTER)`

**On each remote `BridgeMinter`:**
- `requestSetTrustedSender(domain=61803, sender=ETICA_VAULT)`
- `requestSetVetoAuthority(authority=VETO_HARDWARE_WALLET)`
- `requestSetHeartbeatSigner(signer=HEARTBEAT_EOA)`
- `requestSetInsuranceTopUpReceiver(receiver=ETICA_TOP_UP_RECEIVER)`
- `requestSetVetoModule(module=OPTIMISTIC_VETO_MODULE)`
- `requestSetFraudProverModule(module=FRAUD_PROVER_MODULE)`

Record every queued op's `nonce` and `eta` from the event log.

### 3.2 Wait the timelock

48h for `MINTER_OP_TIMELOCK` ops, 24h for module/ISM ops. The longest
chain is the gating factor — typically ~48h end-to-end.

### 3.3 Execute the wireup ops (T+48h)

For each queued nonce:

```bash
cast send $MINTER 'executeOp(uint256)' $NONCE \
  --rpc-url $REMOTE_RPC --private-key $OWNER_KEY
```

### 3.4 Verify wireup

```bash
# Etica side
cast call $VAULT 'trustedSender(uint32)(bytes32)' 1 --rpc-url $ETICA_RPC   # == ETH_MINTER (padded)
cast call $VAULT 'trustedSender(uint32)(bytes32)' 56 --rpc-url $ETICA_RPC

# Remote side (each chain)
cast call $MINTER 'trustedSender(uint32)(bytes32)' 61803 --rpc-url $REMOTE_RPC
cast call $MINTER 'vetoAuthority()(address)' --rpc-url $REMOTE_RPC        # != address(0)
cast call $MINTER 'heartbeatSigner()(address)' --rpc-url $REMOTE_RPC
```

⚠️ If `vetoAuthority` is still `address(0)` on any chain, **do not
proceed**. The minter is unguarded; un-veto-able claims would be a
catastrophic failure mode.

---

## Phase 4 — Activate the watcher

Now and only now do you turn on the GitHub Actions watcher.

### 4.1 GitHub environment

In the `etica-hub` repo settings → Environments → `bridge-watcher`:

**Secrets:**
- `BRIDGE_HEARTBEAT_PRIVATE_KEY` — heartbeat EOA's private key
- `BRIDGE_EXECUTE_PRIVATE_KEY` — auto-execute EOA's private key
- `BRIDGE_TELEGRAM_BOT_TOKEN` — same bot as the buy-bot is fine
- `BRIDGE_TELEGRAM_CHAT_ID` — operator-private chat (NOT the public channel)

**Variables:**
- `BRIDGE_VAULT_ADDRESS` — Etica vault address from Phase 0
- `BRIDGE_MINTER_ETH_ADDRESS` — Eth minter from Phase 1
- `BRIDGE_MINTER_BNB_ADDRESS` — BNB minter from Phase 2
- (optional) `BRIDGE_ETH_RPC_URL`, `BRIDGE_BNB_RPC_URL` — override
  the default publicnode endpoints if you have private RPC access

### 4.2 Dry-run

Trigger each workflow manually via the Actions tab → Run workflow.
Verify each succeeds:

- `Bridge heartbeat (live)` — should write a `heartbeat()` tx on each
  remote and exit 0. Confirm `lastHeartbeatAt` updated on each minter.
- `Bridge monitor (live)` — first run will find 0 claims (none
  submitted yet) and exit 0. Confirm logs show "0 ClaimSubmitted in
  last 5000 blocks".
- `Bridge execute (live)` — same: 0 matured claims, exit 0.

If any workflow red-fails or the Telegram alert channel goes silent
when it shouldn't, **stop and debug** before any user-facing surface
goes live. The watcher is the only thing standing between a malicious
claim and the insurance fund during normal ops.

### 4.3 Confirm cron is scheduled

GitHub Actions sometimes drops `schedule:` triggers on default
branches that have not had recent activity. After this PR merges,
check Actions → All workflows → confirm `Bridge heartbeat (live)`
shows a "Schedule" tab with upcoming runs every 15 min.

---

## Phase 5 — First-deposit smoke test

Use the smallest non-trivial amount the rate limits allow.

### 5.1 Deposit on Etica

From a test EOA (NOT `BRIDGE_OWNER`):

```bash
# Approve vault
cast send $ETX 'approve(address,uint256)' $VAULT $AMOUNT \
  --rpc-url $ETICA_RPC --private-key $TEST_KEY

# Deposit (destDomain = 1 for Eth)
cast send $VAULT 'deposit(uint128,uint32,address)' \
  $AMOUNT 1 $TEST_RECIPIENT \
  --rpc-url $ETICA_RPC --private-key $TEST_KEY
```

Capture the `nonce` from the `Deposit` event in the receipt.

### 5.2 Wait for Hyperlane delivery

Hyperlane validators sign the message; relayers deliver it to Eth.
Typical end-to-end latency is 5-15 minutes. Track at
https://explorer.hyperlane.xyz.

### 5.3 Verify claim arrived

Once delivered, the recipient (or any caller) submits a claim on the
Eth minter:

```bash
cast send $MINTER 'submitClaim(bytes32)' $NONCE \
  --rpc-url $ETH_RPC --private-key $TEST_KEY \
  --value $BOND_WEI    # 25% of amount in ETH (native gas bond)
```

The monitor workflow will run within 5 min and verify this claim
matches the source Etica deposit. **Confirm a "PASS" appears in the
Telegram channel** (silent post — no alert means everything matched).

### 5.4 Wait the challenge window (48h)

Do nothing. The watcher heartbeats every 15 min. The monitor
re-checks the pending claim every 5 min. After 48h elapses, the
auto-execute workflow will detect the matured claim and call
`executeClaim` automatically.

### 5.5 Verify funds delivered

```bash
cast call $WRAPPED_ETX 'balanceOf(address)(uint256)' $TEST_RECIPIENT \
  --rpc-url $ETH_RPC    # == AMOUNT
```

The bond is refunded to the original submitter. Test EOA's ETH
balance should be back to ≈starting balance (minus gas).

⚠️ If anything in §5 goes wrong — Hyperlane never delivers, monitor
posts a mismatch alert, executeClaim reverts — **pause the bridge
immediately** with `cast send $VAULT 'pause()'` from `BRIDGE_OWNER` and
investigate before opening to users.

---

## Phase 6 — Open to users (cap-ramp schedule)

The TVL cap auto-raises 1M ETX → 2M → 3M → … → 10M ETX over the
30-day clean-ops window per spec §3.5. This is operator-driven via
`requestSetTvlCap`. There is no on-chain auto-ramp; the operator
times each raise.

### 6.1 Day 0 — open at 1M ETX

After the smoke test passes:

- [ ] Update `packages/shared/addresses` with all deployed addresses.
- [ ] Open the `/bridge` UI (PR B) to public traffic.
- [ ] Announce in #bridge-status (Telegram).
- [ ] Pin the public address book + monitoring expectations.

### 6.2 Day 30 — first cap raise

Only if the bridge has had **zero vetoes** and **zero monitor
mismatch alerts** in the prior 30 days:

```bash
cast send $MINTER 'requestSetTvlCap(uint256)' 2000000000000000000000000 \
  --rpc-url $REMOTE_RPC --private-key $OWNER_KEY
```

48h later, execute the queued op. Repeat the cap-raise schedule each
month while clean-ops streak holds.

### 6.3 Day 90 — successor key activation window opens

Per spec §11. Operator decides whether to engage the successor flow
or roll the keys forward another 90 days.

---

## Phase 7 — Day-1 ops checklist

Pin these alerts/dashboards in the operator's chat:

- Heartbeat workflow run history → red badge = wake up immediately.
- Monitor workflow run history → red badge = sanity-check failure
  (Telegram alert will fire too).
- `BridgeInsuranceFund.totalAssets` snapshot → expect monotonic
  upward (insurance share + slashed bonds replenish it).
- `BridgeVault.locked()` per-chain → matches sum of
  `WrappedETX.totalSupply()` across remotes within ±1% (rounding +
  in-flight messages).
- Hyperlane explorer for any message stuck >1h.

If any of these go anomalous, see [`BRIDGE_OPS_RUNBOOK.md` §6 Emergency procedures](BRIDGE_OPS_RUNBOOK.md#6-emergency-procedures).

---

## Reference

- [BRIDGE_DESIGN.md](BRIDGE_DESIGN.md) — architecture, threat model, parameter rationale
- [BRIDGE_CONTRACT_SPEC.md](BRIDGE_CONTRACT_SPEC.md) — every function signature, storage slot, event
- [BRIDGE_OPS_RUNBOOK.md](BRIDGE_OPS_RUNBOOK.md) — day-2 ops manual; this walkthrough delegates to it for individual procedures
- [BRIDGE_AUDIT_SCOPE.md](BRIDGE_AUDIT_SCOPE.md) — Sherlock contest scope (deferred to operator discretion)
- [`apps/bridge-watcher/README.md`](../apps/bridge-watcher/README.md) — watcher configuration reference
