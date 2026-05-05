# EticaHub Bridge — Operator Runbook

This runbook is the day-2 operating manual for the Phase 3 ETX bridge. It
assumes the reader has already read [BRIDGE_DESIGN.md](BRIDGE_DESIGN.md) and
[BRIDGE_CONTRACT_SPEC.md](BRIDGE_CONTRACT_SPEC.md), and that the contracts
(PRs #159–#168) are deployed.

The bridge is **default-pass with operator veto**. Most of these procedures
are unattended; the ones you actually have to do regularly are
[heartbeat monitoring](#1-heartbeat-monitoring--watcher-bot) and
[periodic cap rotation](#2-cap-rotation-tvl-rate-limit-bond-fee).

---

## Address book (fill in post-deploy)

| Slot                          | Etica            | Ethereum           | BNB                |
|-------------------------------|------------------|--------------------|--------------------|
| `BridgeVault`                 | TBD              | —                  | —                  |
| `BridgeInsuranceFund`         | TBD              | —                  | —                  |
| `FeeRouter`                   | TBD              | —                  | —                  |
| `InsuranceTopUpReceiver`      | TBD              | —                  | —                  |
| `BridgeMinter`                | —                | TBD                | TBD                |
| `WrappedETX`                  | —                | TBD                | TBD                |
| `OptimisticVetoModule`        | —                | TBD                | TBD                |
| `FraudProverModule`           | —                | TBD                | TBD                |
| `HeartbeatISM`                | —                | TBD                | TBD                |
| `TVLCapISM`                   | —                | TBD                | TBD                |
| `RateLimitISM`                | —                | TBD                | TBD                |
| Hyperlane mailbox             | TBD              | TBD                | TBD                |
| Domain ID                     | 61803            | 1                  | 56                 |

> Update this table in the same PR that wires deployed addresses into
> `packages/shared/addresses` so on-chain addresses, the runbook, and the UI
> stay in lockstep.

---

## 0. Deployment

Foundry scripts under `packages/contracts/script/bridge/` deploy each side in
isolation. Each script reads env vars and broadcasts a single-account session;
no script performs cross-chain wireup (those are timelocked ops, see §3).

### 0.1 Etica side

```bash
cd packages/contracts
forge script script/bridge/DeployBridgeEtica.s.sol \
  --rpc-url $ETICA_RPC \
  --broadcast \
  --slow
```

Required env:

```
DEPLOYER_PRIVATE_KEY=...       # holds EGAZ for gas
BRIDGE_OWNER=0x...             # multisig recommended
ETX_ADDRESS=0x...              # ETX ERC20 on Etica
HYPERLANE_MAILBOX_ETICA=0x...
ETICA_DOMAIN=61803
HARVESTER_ADDRESS=0x...
INSURANCE_WITHDRAW_TIMELOCK=172800   # 48h
FEE_ROUTER_SPLIT_TIMELOCK=86400      # 24h
VAULT_OP_TIMELOCK=172800             # 48h
```

If `DEPLOYER_PRIVATE_KEY` is also `BRIDGE_OWNER`, the script wires
`setBridgeVault` on both `BridgeInsuranceFund` and `FeeRouter` in the same
broadcast. Otherwise the operator runs those two one-time setters manually
from the owner account.

### 0.2 Ethereum / BNB side (run twice, once per chain)

```bash
forge script script/bridge/DeployBridgeRemote.s.sol \
  --rpc-url $ETH_RPC \
  --broadcast \
  --slow
```

Required env (per chain — change `SELF_DOMAIN`, `HYPERLANE_MAILBOX_REMOTE`,
and RPC for BNB):

```
DEPLOYER_PRIVATE_KEY=...
BRIDGE_OWNER=0x...
HYPERLANE_MAILBOX_REMOTE=0x...
SELF_DOMAIN=1                  # 1 for Ethereum, 56 for BNB
ETICA_DOMAIN=61803
MINTER_OP_TIMELOCK=172800      # 48h per spec §5.2
MODULE_OP_TIMELOCK=86400       # 24h
ISM_OP_TIMELOCK=86400          # 24h (RateLimitISM)
TVL_CAP_ETX_WEI=1000000000000000000000000   # 1M ETX
BOND_BPS=2500                  # 25%
BRIDGE_FEE_BPS=10              # 0.1%
CHALLENGE_WINDOW_SECONDS=172800
DAILY_MINT_CAP_BPS=500         # 5%
PER_CLAIM_CAP_BPS=100          # 1%
RATE_LIMIT_DAILY_CAP_WEI=50000000000000000000000   # 50K wETX/day
```

### 0.3 Insurance top-up receiver (Etica)

```bash
forge script script/bridge/DeployInsuranceTopUpReceiver.s.sol \
  --rpc-url $ETICA_RPC \
  --broadcast \
  --slow
```

```
DEPLOYER_PRIVATE_KEY=...
BRIDGE_OWNER=0x...
HYPERLANE_MAILBOX_ETICA=0x...
TOPUP_OP_TIMELOCK=86400        # 24h
```

### 0.4 Pre-fund the insurance backstop

The contract spec calls for a 10M ETX backstop in `BridgeInsuranceFund`. Deposit
is permissionless:

```solidity
etx.approve(address(insuranceFund), 10_000_000e18);
insuranceFund.deposit(10_000_000e18);
```

Withdrawals from the fund are 48h-timelocked (`requestWithdraw` →
`executeWithdraw`). Treasury cannot drain instantly.

---

## 1. Heartbeat monitoring & watcher bot

### What the contract enforces

`BridgeMinter.heartbeatTimeoutSeconds` defaults to **4 hours**. If the bot
goes silent longer than that, `HeartbeatISM` fails inbound deliveries and
auto-pause kicks in (claims still tick toward expiry; new submissions
rejected). After 90 days of total operator silence the successor key
auto-activates (see §4).

### What the bot has to do

The watcher bot, running on a $20/mo VPS, is responsible for:

1. **Heartbeat.** Call `minter.heartbeat()` from the
   `heartbeatSigner` key every ≤ 1 hour (target cadence: every 30 minutes
   to give a 3.5h margin to the 4h timeout).
2. **Veto on suspicion.** When a `ClaimSubmitted` event fires, run sanity
   checks against the Etica RPC:
   - Does the cited Etica deposit `nonce` exist on the vault?
   - Does the recorded `srcDomain`, `recipient`, `amount` match the
     destination-chain claim?
   - Is the cited Etica `srcBlockNumber` finalized (>2× safe-confirms)?
   - Is the recipient address well-formed and non-zero?
   If any check fails: send `vetoModule.veto(claimNonce, reason)` with the
   appropriate `VetoReason`.
3. **Auto-execute matured claims** (optional but operator-friendly): on
   `ClaimSubmitted` events, schedule an `executeClaim(nonce)` call once
   `expiresAt` has passed. Pays gas; receives the prover share if any
   community fraud-prover beat you to it (you should be running both a
   fraud-prover and the bot, but they must use distinct keys).

### Alerting

Hook the bot's Telegram channel into the same group used for harvest alerts.
Severity:

| Event                                            | Severity |
|--------------------------------------------------|----------|
| `Vetoed` event fires                             | **HIGH** |
| Heartbeat tx failed > 2 attempts                 | **HIGH** |
| Bot has not heartbeat-pinged in > 2h             | **HIGH** |
| `Paused` event fires (auto-pause via heartbeat)  | **CRITICAL** |
| `BondSlashed` event fires                        | **MED**  |
| `InsuranceTopUpDispatched` fires                 | **LOW**  |
| Successor-key warning (>60 days since heartbeat) | **CRITICAL** |

### Bot key hygiene

- Heartbeat signer **only** has authority to call `heartbeat()` on the minter.
  It is **not** a veto authority and **not** the owner. Compromise = annoying
  (attacker can spam heartbeats), not dangerous.
- Veto signer (used to call `OptimisticVetoModule.veto()`) is the
  high-stakes key. Should live in a hardware wallet or HSM, not the same VPS
  as the bot. Bot can monitor; manual veto is one tap on a phone.

---

## 2. Cap rotation (TVL, rate limit, bond, fee)

All economic parameters are owner-controlled behind a 24-48h timelock. The
flow is the same for every parameter:

1. Owner submits `requestSet*` (returns an `opId`).
2. Wait ≥ `opTimelock` seconds (24h for most ops, 48h on `BridgeMinter`).
3. Owner submits `executeOp(opId)`.

You can cancel a pending op before execution with `cancelOp(opId)`.

### 2.1 Raise TVL cap after 30d clean ops

After the 30-day post-launch observation window with no veto events:

**On `BridgeVault` (Etica):**

```solidity
// vault.tvlCapEtx is set by the constructor to 1_000_000e18.
// Raise to 2M for month 2.
uint256 opId = vault.requestSetTvlCap(2_000_000e18);
// wait 48h (vault opTimelock)
vault.executeOp(opId);
```

**On each `BridgeMinter` (Eth + BNB):**

```solidity
uint256 opId = minter.requestSetTvlCap(2_000_000e18);
// wait 48h
minter.executeOp(opId);
```

> The minters' TVL caps drive `dailyMintCapBps` and `perClaimCapBps`
> dynamically (5% and 1% of `tvlCapEtx`). Raising the cap proportionally
> raises both throughput limits.

### 2.2 Rotate the RateLimitISM daily cap

`RateLimitISM` is independent from `BridgeMinter.dailyMintCapBps` — it
provides defense-in-depth at the Hyperlane mailbox boundary. Adjust when
TVL grows or trading volume requires more headroom:

```solidity
uint256 opId = rateLimitIsm.requestSetDailyCap(100_000e18); // 100K wETX/day
// wait 24h
rateLimitIsm.executeOp(opId);
```

### 2.3 Rotate veto authority (rare)

Only run this if your veto key is compromised or you're swapping to a 2-of-3
multisig:

**On the minter (each remote chain):**

```solidity
uint256 opId = minter.requestSetVetoAuthority(<new authority>);
// wait 48h
minter.executeOp(opId);
```

If you previously routed veto through `OptimisticVetoModule`, update its key
instead:

```solidity
uint256 opId = vetoModule.requestSetVetoKey(<new vetoer>);
// wait 24h
vetoModule.executeOp(opId);
```

### 2.4 Adjust bond size

Defaults to 25%; bounded `[10%, 100%]` (`MIN_BOND_BPS`, `MAX_BOND_BPS`).

```solidity
uint256 opId = minter.requestSetBondBps(3_000); // 30%
// wait 48h
minter.executeOp(opId);
```

### 2.5 Adjust bridge fee

Defaults to 10 bps (0.1%); capped at `MAX_BRIDGE_FEE_BPS`. Apply on **both**
the vault (Etica side, deposit fee) and each minter (remote side, burn fee)
to keep them aligned:

```solidity
vault.requestSetBridgeFeeBps(15);   // 0.15% deposit fee on Etica
minter.requestSetBridgeFeeBps(15);  // 0.15% burn fee on remote chain
// wait timelock
vault.executeOp(opId1);
minter.executeOp(opId2);
```

### 2.6 Pause / unpause

Pause is **instant** (no timelock); unpause is **timelocked** (24h on the
vault, 48h on the minter). Pending claims continue ticking toward expiry
during a pause — you can still veto them, but new submissions are blocked.

```solidity
// instant
vault.pause();
minter.pause();

// timelocked
uint256 opId = vault.requestUnpause();
// wait 24h
vault.executeOp(opId);
```

---

## 3. Cross-chain wireup (run once per chain after deploy)

Because the deploy scripts only deploy contracts (not wire them), you must
run the following timelocked wireup ops **after** deploys on both sides
complete. The 24-48h timelock window is intentional — gives you time to
double-check addresses.

### 3.1 Etica → tell each remote chain about us

Convert `BridgeVault` address to `bytes32` (left-zero-padded):

```python
vault_b32 = "0x" + "00" * 12 + vault_address[2:].lower()
```

On each remote `BridgeMinter`:

```solidity
minter.requestSetTrustedVault(ETICA_DOMAIN, vault_b32);
minter.requestSetAllowedDestDomain(ETICA_DOMAIN, true);
// wait 48h
minter.executeOp(opId1);
minter.executeOp(opId2);
```

### 3.2 Each remote chain → tell Etica about us

Pad each minter address to `bytes32`:

```python
minter_eth_b32 = "0x" + "00" * 12 + minter_eth_address[2:].lower()
minter_bnb_b32 = "0x" + "00" * 12 + minter_bnb_address[2:].lower()
```

On `BridgeVault` (Etica):

```solidity
vault.requestSetTrustedMinter(ETH_DOMAIN, minter_eth_b32);
vault.requestSetAllowedDestDomain(ETH_DOMAIN, true);

vault.requestSetTrustedMinter(BNB_DOMAIN, minter_bnb_b32);
vault.requestSetAllowedDestDomain(BNB_DOMAIN, true);
// wait 48h
vault.executeOp(...);
```

### 3.3 Wire insurance top-up trust

On each `BridgeMinter`:

```solidity
minter.requestSetInsuranceTopUpTarget(ETICA_DOMAIN, topUpReceiver_b32);
// wait 48h
minter.executeOp(opId);
```

On `InsuranceTopUpReceiver` (Etica):

```solidity
receiver.requestSetTrustedSender(ETH_DOMAIN, minter_eth_b32);
receiver.requestSetTrustedSender(BNB_DOMAIN, minter_bnb_b32);
// wait 24h each
receiver.executeOp(...);
```

### 3.4 Wire fraud-prover root oracle

The oracle is whoever you trust to attest Etica block roots. v1 default:
operator multisig. Pad oracle address to `bytes32`:

```solidity
prover.requestSetTrustedRootSender(oracle_b32);
// wait 24h
prover.executeOp(opId);
```

### 3.5 Wire ISMs to the local Hyperlane mailbox

ISM rotation is a Hyperlane-mailbox operation, not a bridge-contract op.
Follow the Hyperlane V3 mailbox-config flow on each chain:

- Set `BridgeMinter`'s ISM (per-recipient) to an Aggregation ISM containing:
  - Hyperlane MultisigISM (default chain security)
  - `HeartbeatISM`
  - `TVLCapISM`
  - `RateLimitISM`
- Set `BridgeVault` and `InsuranceTopUpReceiver` ISMs similarly (no
  `TVLCapISM` on vault — it doesn't apply).

If you don't have the multisig vote ready yet, defer ISM rotation. The bridge
contracts can run with the default Hyperlane ISM at modest TVL; the custom
ISMs become important once the bridge crosses ~5M ETX and absolute caps
matter.

---

## 4. Successor key activation

If the operator goes offline for **90 consecutive days** (configured via
`successorTimelockSeconds`, defaults to 90 days on the minter):

1. Set up a successor key in advance — required, otherwise no recovery is
   possible:

   ```solidity
   uint256 opId = minter.requestSetSuccessorKey(<successor address>);
   // wait 48h
   minter.executeOp(opId);
   ```

   The successor can be a contract (e.g., a 2-of-3 community multisig). The
   successor *only* gains owner powers after activation, never before.

2. After 90 days of no `heartbeat()` calls *and* no owner txs, anyone can
   call `minter.activateSuccessor()` to transfer ownership to the
   pre-configured successor address. The successor then has the same powers
   as the original owner (timelocked ops, instant pause, key rotations).

3. Original owner can revoke the threat by calling `heartbeat()` *or* by
   rotating the successor key back to their own address (timelocked).

> The successor key activation is asymmetric: it transfers ownership of the
> minter only, not the Etica-side vault. The vault has its own owner; if you
> want a single multisig to govern everything post-activation, configure
> the successor key to **be** the multisig that already owns the vault.

---

## 5. Settling slashed bonds

Bond slashes split 25/50/25 (prover / treasury / insurance) per the locked
defaults. The minter routes funds atomically when the slash fires:

- Prover share → wherever the manual vetoer reward recipient is set, OR
  paid directly to the community fraud-prover that won the slash.
- Treasury share → `treasuryRecipient` (set via timelocked op).
- Insurance share → `insuranceSweepRecipient` (typically a sweep router that
  forwards to Etica's `InsuranceTopUpReceiver`).

There's no manual settlement work for bond splits during normal slashing.

The only thing that requires your attention is the **insurance top-up
notice closeout**: when the minter routes a slice of fees/slashed bonds to
`insuranceSweepRecipient`, it dispatches a Hyperlane message to Etica's
`InsuranceTopUpReceiver`. The receiver records the notice but does NOT
move ETX (the message carries no value). You're expected to:

1. Move the equivalent ETX amount from your Etica treasury into
   `BridgeInsuranceFund.deposit()` (off-chain action, on-chain effect).
2. Call `InsuranceTopUpReceiver.markSettled(noticeId)` to close the audit
   trail.

Cadence: weekly (matches the spec's batch top-up cadence). Skipping
settlement doesn't break anything — the notice list grows but the bridge
operates fine. It's an audit-trail discipline thing.

---

## 6. Emergency procedures

### 6.1 Suspected exploit in progress

1. **Pause both sides immediately:**
   - `vault.pause()` (Etica)
   - `minter.pause()` (each remote chain)
   - **No timelock.** Tx finalizes, no new claims/deposits accepted.
2. **Veto every pending claim** that looks suspicious. Vetos are still
   accepted while paused.
3. **Investigate from the public on-chain logs.** Cross-check `Deposit`
   events on the Etica vault against `ClaimSubmitted` events on the
   destination minter.
4. **If insurance fund insufficient,** publish an incident report and
   make affected users whole from treasury (out of scope for the
   contract; this is a manual treasury op).
5. **Resume only after:** root cause identified, parameters adjusted via
   timelocked ops, watcher bot logic patched if needed.

### 6.2 Watcher bot compromised

1. Rotate `heartbeatSigner` to a new key (timelocked, but pause first if
   you're worried about active attack).
2. Decommission the compromised VPS.
3. If the compromised key was *only* the heartbeat signer (not a vetoer),
   treat as nuisance — attacker can spam heartbeats, can't approve fake
   claims.

### 6.3 Veto key compromised

1. Pause the minter immediately.
2. Rotate `vetoAuthority` (or `vetoKey` on `OptimisticVetoModule`) via
   timelocked op.
3. Wait the 24-48h timelock — during this window, no claims can mature
   anyway because the bridge is paused.
4. Once the rotation executes, unpause.

### 6.4 Successor key compromised before activation

1. Rotate the successor address via `requestSetSuccessorKey` (timelocked).
2. Anchor `lastHeartbeatAt` by calling `heartbeat()` from the current
   signer to push activation 90 days into the future.

### 6.5 Insurance fund drained

1. Pause both sides.
2. Top up insurance fund via direct treasury `deposit()` (no timelock on
   deposits).
3. Resume.
4. If treasury can't cover the gap, publicly post a recovery plan
   (timeline, source of replenishment) before resuming.

---

## 7. Status checks

Quick read-only commands to inspect bridge health from the operator console:

```solidity
// Etica
vault.totalLockedEtx()           // ETX held in custody
vault.dailyUsedWei()             // current day's withdrawals
vault.tvlCapEtx()
vault.paused()
insuranceFund.totalAssets()
feeRouter.toInsuranceBps()       // should be 2000
feeRouter.toHarvesterBps()       // should be 8000

// Each remote
minter.totalMintedWei()
minter.dailyUsedWei()
minter.tvlCapEtx()
minter.paused()
minter.lastHeartbeatAt()         // unix timestamp; alert if >2h ago
minter.successorActivatedAt()    // 0 if not activated
minter.heartbeatTimeoutSeconds() // should be 14400 (4h)
minter.successorTimelockSeconds()// should be 7776000 (90d)
wetx.totalSupply()               // should equal vault.totalLockedEtx() across both chains
```

These are good values to dump on `/status` in the web app once the bridge
is live (deferred to a later UI PR).

---

## 8. Reference

- [BRIDGE_DESIGN.md](BRIDGE_DESIGN.md) — full design rationale.
- [BRIDGE_CONTRACT_SPEC.md](BRIDGE_CONTRACT_SPEC.md) — function sigs,
  storage layout, events, reverts.
- [Hyperlane docs](https://docs.hyperlane.xyz/) — mailbox, ISM, validator
  set configuration on third-party chains.
- Solidity sources: `packages/contracts/src/bridge/`.
- Foundry tests: `packages/contracts/test/bridge/` (503 tests, full
  coverage).
- Deploy scripts: `packages/contracts/script/bridge/`.
