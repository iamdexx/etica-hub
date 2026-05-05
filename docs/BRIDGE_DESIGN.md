# EticaHub Bridge — Design Document

**Status:** draft v0.1 — architecture locked, ready for review before contract specification
**Phase:** Phase 3 (post-stableswap, post-staking, post-farms)
**Audit posture:** self-audit; Sherlock contest deferred at user discretion
**Mainnet deploy:** blocked until self-audit complete + design doc approved

---

## 1. Goals and non-goals

### Goals

1. Move **ETX** between Etica mainnet (chain `61803`) and Ethereum mainnet (chain `1`) + BNB Chain (chain `56`), with Tron added later as Phase 3c.
2. **Single-signer trust model**: only the operator (`iamdex`) signs anything that affects user funds. No external validators, no community signers.
3. **Automatic by default**: no per-withdrawal manual approval. Withdrawals execute optimistically; the operator only intervenes to reject fraud.
4. **Self-funding**: bridge fees and slashed fraud bonds cover all ongoing infrastructure. No recurring cost to operator wallets.
5. **Backstopped by insurance**: 10M ETX `BridgeInsuranceFund` auto-covers user losses from missed fraud claims up to that amount.
6. **Hyperlane mailbox rails**: reuse audited Hyperlane permissionless deployment for cross-chain message passing; do not write our own cryptography.

### Non-goals (v1)

- ZK light client (deferred, requires 6+ months and external research engineering).
- Bridging assets other than ETX (no ETI, no EGAZ, no LP tokens at launch).
- Liquidity-network model (Hop / Across) for fast withdrawals — design preserves the option to layer on a fast-withdraw LP module later, but v1 is pure lock-and-mint.
- Tron at launch (TVM differs in address format + RPC SDK; phased into 3c after Eth + BNB are operational for 30+ days).
- Decentralized governance over bridge parameters (treasury wallet retains owner role; transition path documented).
- Cross-chain message passing for general-purpose data (only ETX value transfer).

---

## 2. Why this architecture

### The fundamental constraint

Ethereum cannot natively read Etica's state. For any cross-chain ETX transfer to be safe, **something Eth-readable must attest** that an Etica-side deposit really happened. Three options exist in nature:

| Option | What it is | Trust assumption |
|---|---|---|
| Off-chain validators sign block roots | N keys attest to Etica state | Trust that ≤N validators don't collude |
| ZK light client | Cryptographic proof of Etica's PoW | Trustless |
| Optimistic + bond + challenge | Anyone claims; anyone can challenge with proof | At least one honest watcher |

The operator's stated requirement is **"I don't trust anyone but myself to verify transactions."** That eliminates federated multisig (multiple humans signing). ZK light client is out of scope. The only fit is **optimistic + bond + challenge with the operator as sole watcher**, paired with a cryptographically verifiable fallback path so the operator's role is bounded rather than unilateral.

### Why optimistic-veto is the right shape

In a federated multisig, validators **approve** withdrawals. Compromise = fake approvals = bridge drained. The trust surface is "all validators must be honest."

In an optimistic-veto bridge, the operator **rejects** withdrawals. There is no approve path; default is pass-through after the challenge window expires. Compromise of the operator's veto key produces denial-of-service (attacker spams vetoes), not theft. The trust surface is "operator watches the queue OR a community fraud-prover catches it OR the insurance fund auto-covers."

This inversion — from "approver" to "rejector" — is what makes a single-signer bridge defensible.

---

## 3. High-level architecture

```
┌──────────────────────────┐     ┌──────────────────────────┐
│      Etica chain         │     │   Ethereum + BNB Chain   │
│      (chain 61803)       │     │   (chain 1, chain 56)    │
├──────────────────────────┤     ├──────────────────────────┤
│  BridgeVault             │     │  WrappedETX (wETX)       │
│  ├─ locks ETX            │     │  ├─ ERC20Permit          │
│  ├─ emits Deposit event  │     │  └─ mint/burn restricted │
│  └─ lifts withdraw caps  │     │                          │
│                          │     │  BridgeMinter            │
│  BridgeInsuranceFund     │     │  ├─ optimistic veto      │
│  └─ 10M ETX, timelocked  │     │  ├─ 48h challenge window │
│                          │     │  ├─ bond: 25% of claim   │
│  FeeRouter               │     │  ├─ rate-limit ISM       │
│  └─ 0.1% fee → harvester │     │  └─ tvl-cap ISM          │
│                          │     │                          │
│  HyperlaneMailbox        │◄───►│  HyperlaneMailbox        │
│  └─ sends Etica deposit  │     │  └─ receives + verifies  │
│     receipts to dest     │     │     via configured ISM   │
└──────────────────────────┘     └──────────────────────────┘
            ▲                                 ▲
            │ Watcher bot                     │ Fraud-prover layer
            │ (operator's $20/mo VPS)         │ (anyone can submit)
            │ ├─ heartbeats every hour        │ Verifies Merkle proof
            │ ├─ vetoes fraudulent claims     │ against signed Etica root
            │ └─ veto-only sub-key            │ Bounty: 25% of slashed bond
            │                                 │
            └── Master key (hardware wallet) ─┘
                Master key can override bot,
                rotate veto sub-key, etc.
```

### Component summary

| Component | Chain | Responsibility | New code? |
|---|---|---|---|
| `BridgeVault` | Etica | Lock/unlock ETX; emit Deposit; enforce TVL cap | New, ~200 LOC |
| `BridgeMinter` | Eth, BNB | Mint/burn wETX; manage claim queue, bonds, vetoes | New, ~350 LOC |
| `WrappedETX` | Eth, BNB | ERC20Permit; mintable only by `BridgeMinter` | New, ~50 LOC |
| `BridgeInsuranceFund` | Etica | Hold 10M ETX; auto-payout on bad debt; timelocked withdrawals | New, ~100 LOC |
| `FeeRouter` | Etica | Route 0.1% bridge fee to harvester (10/10/40/40 split) | New, ~50 LOC |
| `OptimisticVetoModule` | Eth, BNB | 48h challenge window + bond accounting + 25/50/25 split | New, ~150 LOC |
| `FraudProverModule` | Eth, BNB | Verify Merkle proof against Hyperlane-validator-signed Etica root | New, ~200 LOC |
| `HyperlaneMailbox` + `MultisigISM` | All chains | Cross-chain message passing | Reused, audited |
| Watcher bot | Off-chain | Heartbeat; auto-veto on sanity-check failures | New, ~250 LOC TS |
| `/bridge` UI | Web | Deposit + claim flows, 48h pending visualization | New, ~600 LOC TS/React |

**Total new Solidity to audit: ~1,100 LOC.** Hyperlane reuse handles all message-passing cryptography.

---

## 4. Locked design parameters

These are the parameters as agreed during exploration. All are settable by owner up to the documented hard caps; values below are the v1 defaults.

| Parameter | Value | Hard cap (contract-enforced) | Notes |
|---|---|---|---|
| Asset | ETX | (not applicable) | Treasury-backed; matches operator's stated insurance posture |
| Destination chains | Eth + BNB at launch, Tron in 3c | (not applicable) | Hyperlane permissionless deploy on each |
| Challenge window | 48 hours | min 24h, max 168h | 48h gives operator + community ample time to react |
| Bond size | 25% of claim amount | min 5%, max 50% | Strong deterrent without discouraging legitimate use |
| Bond destination split | 25% prover / 50% treasury / 25% insurance | (not applicable) | Aligns incentives across all watchers |
| Community fraud-prover layer | Enabled in v1 | (not applicable) | Adds redundant fraud detection without adding trust |
| Initial TVL cap | 1M ETX | (governance-raisable) | Auto-raises after 30d clean ops via timelock |
| TVL cap raise mechanic | +1M every 30d if no fraud or veto activity | (governance-raisable) | Stops at 10M ETX without explicit governance |
| Per-claim cap | 1% of current vault TVL | min 0.1%, max 5% | Bounds single-claim damage |
| Per-day rate limit | 5% of current vault TVL | min 1%, max 10% | Bounds daily damage |
| Insurance fund | 10M ETX | (treasury discretion) | Pre-funded at deploy; replenished from slashed bonds |
| Successor-key timelock | 90 days | min 30d, max 365d | Activates if veto key shows no heartbeat for the duration |
| Bridge fee | 0.1% (10 bps) | min 0%, max 1% | Routed through `FeeRouter` to harvester |
| Audit | Self-audit at launch | (operator discretion) | Sherlock contest deferred |
| Watcher heartbeat interval | 1 hour | min 5min, max 24h | Bridge auto-pauses if no heartbeat for 4h |
| Auto-pause threshold | 4h without heartbeat | min 1h, max 24h | Conservative; rejects new claims, lets pending claims continue |

---

## 5. Money flow walkthrough

### 5.1 Etica → Ethereum (deposit and claim)

```
Step 1 (Etica): user calls BridgeVault.deposit(amount, destChain, destRecipient)
  - Contract pulls ETX from user (permit2 or approve+transferFrom)
  - 0.1% fee deducted, sent to FeeRouter → harvester
  - 99.9% locked in vault, depositCounter incremented
  - Emits Deposit(nonce, srcChain, destChain, recipient, amountNet)
  - Hyperlane mailbox dispatches the deposit message to destChain

Step 2 (off-chain): Hyperlane validators (run by operator on $20/mo VPS) attest 
  to the Etica block root containing the deposit. Standard Hyperlane operation.

Step 3 (Eth): anyone (commonly the user or a paid relayer) submits the claim 
  to BridgeMinter.submitClaim(nonce, recipient, amount, [hyperlane proof])
  - Submitter posts 25% of amount as bond (in destChain native gas, or wETH, or wETX)
  - Hyperlane MultisigISM verifies the Etica block root signature
  - Claim enters PENDING state with timestamp
  - Emits ClaimSubmitted(nonce, submitter, amount, bondPosted, expiresAt)

Step 4 (next 48 hours): challenge window
  - Watcher bot continuously checks: does the deposit really exist on Etica?
  - Bot signs heartbeats every hour to BridgeMinter.heartbeat()
  - If sanity check fails: bot signs OptimisticVetoModule.veto(nonce, reason)
  - OR community member submits FraudProverModule.proveAndVeto(nonce, merkleProof)
  - Either action cancels the claim
  - Slashed bond split 25% prover / 50% treasury / 25% insurance

Step 5a (no veto, 48h elapsed): claim auto-executes
  - Anyone calls BridgeMinter.executeClaim(nonce)
  - Mints wETX to recipient
  - Returns full bond to submitter
  - Emits ClaimExecuted(nonce, recipient, amount)

Step 5b (vetoed): claim cancelled
  - Bond slashed per split
  - Real depositor's ETX remains locked on Etica vault
  - Real depositor can re-claim with valid proof later
  - Emits ClaimVetoed(nonce, vetoer, reason)
```

### 5.2 Ethereum → Etica (burn and withdraw)

Symmetric:

```
Step 1 (Eth): user calls BridgeMinter.burn(amount, destChain=61803, destRecipient)
  - wETX burned
  - 0.1% fee deducted (destination-chain side; sent to harvester via remote message)
  - Hyperlane mailbox dispatches burn receipt to Etica

Step 2 (off-chain): Hyperlane validators attest to Eth block root containing burn.
  Same Hyperlane validator infrastructure as opposite direction.

Step 3 (Etica): anyone submits claim to BridgeVault.submitWithdrawClaim(nonce, ...)
  - Submitter posts 25% bond
  - Same 48h challenge window
  - Same fraud-prover and operator-veto paths
  - Slashed bond split same way

Step 4 (no veto, 48h elapsed): claim auto-executes
  - Vault releases ETX to recipient
  - Submitter bond returned
  - Insurance fund replenished from any 0.1% remaining fees

Step 5 (vetoed): cancelled, bond slashed.
```

### 5.3 Insurance fund auto-payout

```
Triggered when: vault detects bad debt (locked ETX < outstanding wETX on remote chain)

  bridgeVault.checkSolvency() → if (lockedETX < wETXOutstanding):
    delta = wETXOutstanding - lockedETX
    BridgeInsuranceFund.draw(delta)
      ├─ if InsuranceFund balance ≥ delta:
      │     transfers delta to BridgeVault, emits InsuranceDrawn(amount)
      │     vault re-collateralized, bridge continues operating
      └─ else:
            transfers full balance, emits InsuranceExhausted(deficit)
            BridgeVault auto-pauses
            Operator must manually top up insurance and unpause
```

The check runs on every withdrawal claim execution + every 24h via a cron-triggered call. Anyone can trigger the check (it's a permissionless function); a small EGAZ tip is offered to the caller as keeper compensation.

---

## 6. Threat model

### 6.1 Attack scenarios

| # | Scenario | Mitigation | Residual risk |
|---|---|---|---|
| 1 | Attacker submits fake claim, operator catches it | Bond slashed; operator profits | None |
| 2 | Attacker submits fake claim, operator MISSES it within 48h | Per-claim cap (1% of TVL) limits damage; insurance fund auto-covers | Bounded by insurance fund |
| 3 | Attacker submits multiple fake claims to drain rapidly | Per-day rate limit (5% TVL); insurance fund covers cumulative loss | Bounded |
| 4 | Operator's veto key is leaked | Veto-only key has zero approve authority; attacker can DoS only; rotate via master key | DoS until rotation |
| 5 | Operator's master key is leaked | Master key can rotate veto key, change contract owner, raise fees up to caps; treasury controls all assets directly | High — same as treasury key compromise (existing protocol risk) |
| 6 | Hyperlane mailbox compromised | Hyperlane uses MultisigISM; combined attack on multiple validators required; fraud-prover layer adds independent verification | Bounded by Hyperlane's own threat model |
| 7 | Watcher bot crashes / VPS down | Heartbeat fails after 4h → bridge auto-pauses → no new claims accepted | Pending claims still tick toward 48h; manual veto required if fraud is in flight |
| 8 | All operator infra is offline (sick, lost keys) | After 90d no heartbeat: successor-key timelock activates; bridge can be unpaused by successor | Up to 90d pause; users still hold locked ETX safely |
| 9 | Community fraud-prover submits FAKE proof | Cryptographic verification rejects invalid Merkle proof; prover loses bond | None |
| 10 | Reorg on Etica during deposit attack | Hyperlane validators wait for finality (configurable, default 12 confirmations on Etica); claims using sub-finality blocks rejected by ISM | Bounded by chosen confirmation depth |
| 11 | Reorg on destination chain after claim execution | wETX exists on remote chain regardless; reorg of mint tx is recoverable via Hyperlane retry | None |
| 12 | Replay attack on claim | Each claim uses globally-unique nonce; processed[nonce] set on execution | None |
| 13 | Front-running of legitimate claim by malicious submitter | Both submitters claim same nonce; first to land wins, second tx reverts (bond returned to second); legitimate user's funds unaffected | None |
| 14 | Cross-chain message fee griefing | Hyperlane IGP requires gas prepayment at submission; insufficient prepayment = message stalls but no funds lost | UX delay only |
| 15 | Hyperlane validators collude to attest fake Etica root | Fraud-prover layer can independently prove Etica block contents via second source (e.g., Etica RPC); operator veto remains; insurance fund backstop | Bounded by insurance fund |
| 16 | Attacker spams claim queue with valid-looking claims to overwhelm bot | Per-submitter rate limit (max N pending claims per address); bond requirement limits cost-of-attack | Bounded; financial cost to attacker |
| 17 | Token decimal mismatch between Etica ETX and remote wETX | Both are 18-decimal ERC-20s; conversion is 1:1; explicit assertion in BridgeVault and BridgeMinter constructors | None |
| 18 | Operator wants to upgrade contracts | Owner-gated `setVerifier()` and `setFee()` etc., but core vault/minter logic is non-upgradeable; major upgrades require new contract deploy + migration | Migration overhead |

### 6.2 Worst plausible compound attack

**Scenario:** operator is fully offline for 7 days (illness, travel, key issue), bot crashes, no community fraud-prover catches fraud in time.

```
Day 0:   bridge has 1M ETX TVL (initial cap), operator goes offline
Hour 1:  bot heartbeat fails
Hour 4:  bridge auto-pauses (no new claims accepted)
Hour 5+: existing pending claims continue counting toward 48h

If attacker submitted fake claims in the 5 hours before pause:
  - Max 1% per claim → 10K ETX
  - Max 5% per day → 50K ETX cumulative

If 50K ETX of fake claims slip through over the next 48h:
  - Insurance fund auto-pays 50K ETX to vault, restoring 1:1 backing
  - Insurance fund: 10M → 9.95M
  - Bridge remains paused (no heartbeat)
  
Day 7:   operator returns, restarts bot, manually unpauses
  - Insurance fund: 9.95M ETX (still 199x worst-case daily loss)
  - Vault: 950K ETX, wETX outstanding: 1M ETX (50K covered by insurance)
  - All users made whole
```

Worst-case outcome: **5% of TVL stolen, 100% of users made whole, bridge resumes.** Insurance can absorb ~200 such 7-day attacks before exhaustion. Compound risk requires `attacker has fraud opportunity AND operator offline AND no community watchers catch it AND it persists at the rate limit AND insurance is ultimately drained` — chain of failures that bounds the catastrophic case to a level the protocol can survive publicly.

### 6.3 What this is NOT defended against

Honest accounting of residual risks:

- **Master-key compromise** (item #5): same-tier risk as existing treasury-key compromise. Nothing the bridge can do about an attacker holding the operator's hardware wallet. Mitigations are operational (hardware wallet + offline backup + 2FA on all signing platforms), not architectural.
- **Hyperlane protocol-level vulnerability** (item #6, #15 partial): if Hyperlane's audited code has a critical bug we miss, fraud-prover layer + insurance reduce but don't eliminate exposure. Watching Hyperlane's CVE feed is part of the operational runbook.
- **Permanent operator disappearance** (item #8): up to 90d pause before successor activates. Mitigated by named successor configured at deploy.
- **Bug in our own contracts**: precisely why we self-audit thoroughly + offer Sherlock contest as future hardening.

---

## 7. Self-audit checklist

This is the audit framework before any mainnet deploy. The operator and assistant both work through this independently and document findings.

### 7.1 Bridge contracts

- [ ] `BridgeVault.deposit()`: cannot lock more ETX than transferred (use balance-delta accounting, not parameter-trust)
- [ ] `BridgeVault.deposit()`: fee deducted before locking, not after
- [ ] `BridgeVault.deposit()`: nonce uniqueness asserted via incrementing counter
- [ ] `BridgeVault.withdrawComplete()`: only callable through OptimisticVetoModule's executeClaim path
- [ ] `BridgeVault.withdrawComplete()`: amount cannot exceed locked balance
- [ ] `BridgeVault.withdrawComplete()`: TVL cap and per-day rate limit enforced before transfer
- [ ] `BridgeVault.checkSolvency()`: anyone can call; bad debt triggers `BridgeInsuranceFund.draw()`
- [ ] `BridgeMinter.submitClaim()`: bond must equal 25% of amount (use BPS check, not float)
- [ ] `BridgeMinter.submitClaim()`: nonce uniqueness checked before any state change
- [ ] `BridgeMinter.submitClaim()`: Hyperlane MultisigISM verification result checked before claim enters queue
- [ ] `BridgeMinter.executeClaim()`: only callable after `expiresAt`; uses `block.timestamp`, not external oracle
- [ ] `BridgeMinter.executeClaim()`: re-entry guarded; `processed[nonce] = true` set BEFORE external call
- [ ] `BridgeMinter.executeClaim()`: bond returned only on successful execution
- [ ] `OptimisticVetoModule.veto()`: only callable by veto key OR fraud-prover module
- [ ] `OptimisticVetoModule.veto()`: 25/50/25 split enforced via fixed BPS arithmetic (no rounding loss)
- [ ] `OptimisticVetoModule.veto()`: only callable while claim is PENDING (not after expiration)
- [ ] `FraudProverModule.proveAndVeto()`: Merkle proof verification matches Hyperlane root format exactly
- [ ] `FraudProverModule.proveAndVeto()`: prover bond cannot be reused for veto (separate pool)
- [ ] `FraudProverModule`: invalid proof reverts; doesn't slash prover (slash only on lying, not on insufficient evidence)
- [ ] `WrappedETX.mint()`: only callable by BridgeMinter
- [ ] `WrappedETX.burn()`: only callable by BridgeMinter
- [ ] `WrappedETX`: ERC20Permit nonces follow EIP-2612 standard
- [ ] `BridgeInsuranceFund`: timelocked withdrawal (any non-emergency-payout)
- [ ] `BridgeInsuranceFund.draw()`: only callable by BridgeVault on solvency failure
- [ ] `BridgeInsuranceFund.draw()`: cannot exceed available balance (no underflow / sentinel value abuse)
- [ ] `FeeRouter.routeFee()`: only callable by BridgeVault
- [ ] `FeeRouter.routeFee()`: fee BPS hardcoded into deployment; only owner can change up to 100 BPS cap
- [ ] All `Ownable` operations behind 24h timelock except emergency pause
- [ ] All `Pausable` operations: pause is permissionless via small bond; unpause requires 48h delay
- [ ] Heartbeat: bot key cannot signal heartbeat from cold (no replay across days)

### 7.2 Hyperlane integration

- [ ] Mailbox addresses on Eth + BNB + Etica are immutable in our contracts
- [ ] MultisigISM threshold matches our deployed validator set count
- [ ] Hyperlane validator daemon on operator VPS uses keys NOT shared with any bridge contract owner role
- [ ] IGP (Interchain Gas Paymaster) integrated for user-pays-destination-gas at deposit
- [ ] Claim message format includes (srcChain, destChain, nonce, recipient, amount) — minimum to prevent cross-chain replay

### 7.3 Watcher bot

- [ ] Bot's Etica RPC fallback list contains ≥3 independent providers
- [ ] Bot signs heartbeat with veto-only sub-key, never master key
- [ ] Bot's auto-veto rule set documented and unit-tested for each fraud scenario
- [ ] Bot deployed on VPS with 99.9% uptime SLA target
- [ ] Bot alerts (Telegram) wired to operator on heartbeat failure or veto event
- [ ] Bot can be replaced without downtime (key rotation + new instance startup tested)
- [ ] Bot logs are publicly mirrored (e.g., to a public S3 bucket) for audit transparency

### 7.4 UI

- [ ] `/bridge` deposit flow shows: 0.1% fee, 48h expected wait, claim instructions
- [ ] `/bridge` claim flow shows: nonce, bond required, expiration, current state
- [ ] Claim auto-execute "Execute" button appears at expiration, calls BridgeMinter
- [ ] Pending claims dashboard shows all in-flight claims with countdown timers
- [ ] Insurance fund balance displayed prominently on /bridge homepage
- [ ] Vault TVL + wETX outstanding cross-chain shown for transparency (via /api/v1/bridge endpoints)

---

## 8. Implementation phases

### Phase 3a: Eth-only launch

1. Deploy `WrappedETX` + `BridgeMinter` + `OptimisticVetoModule` + `FraudProverModule` on Ethereum
2. Deploy `BridgeVault` + `BridgeInsuranceFund` + `FeeRouter` on Etica
3. Deploy Hyperlane Mailbox on Etica (permissionless deployment per Hyperlane docs)
4. Configure Hyperlane MultisigISM with operator's validator set (default 1 validator at launch, expands to 3 in 30 days)
5. Pre-fund `BridgeInsuranceFund` with 10M ETX from treasury
6. Deploy + configure watcher bot on operator VPS
7. Self-audit checklist run by operator + assistant
8. Optional: Sherlock contest at this stage if operator opts in
9. Mainnet deploy with TVL cap = 100K ETX (10% of locked target) for first 7 days
10. Raise to 1M ETX cap after 7 days clean ops
11. Auto-raise mechanic kicks in: +1M every 30d if no fraud activity, capped at 10M

### Phase 3b: BNB simultaneous

Same contracts redeployed on BNB Chain. Same Hyperlane mailbox + ISM. Same watcher bot adds BNB Chain to its monitoring. UI adds BNB destination tab.

### Phase 3c: Tron addition

Separate UI path due to TronWeb SDK ≠ wagmi/viem. Same Solidity ports to TVM with minor adjustments. Adds ~30% UI complexity (deferred to post-launch).

---

## 9. UI specification (brief)

### `/bridge` page structure

```
┌──────────────────────────────────────────────────────┐
│ Bridge ETX                                           │
├──────────────────────────────────────────────────────┤
│ [From: Etica ▼]  [To: Ethereum ▼]                    │
│                                                       │
│ Amount: [        1000.00 ETX]                         │
│ Fee:                              1.00 ETX (0.1%)     │
│ You will receive:               999.00 wETX           │
│                                                       │
│ Estimated time: ~48 hours (challenge window)          │
│ Bond required (paid by claimer): 250 ETX equiv        │
│                                                       │
│ [Lock & Bridge]                                       │
└──────────────────────────────────────────────────────┘

[Pending claims]
┌──────────────────────────────────────────────────────┐
│ Nonce 0x...     1000 ETX → Eth     Expires in 47h    │
│ Status: PENDING — challenge window open               │
│ [Submit claim] (requires 250 ETX equiv as bond)       │
└──────────────────────────────────────────────────────┘

[Bridge metrics]
TVL: 950K ETX (cap: 1M ETX)
wETX outstanding (Eth + BNB): 950K
Insurance fund: 10M ETX (auto-payout to 9.95M before manual top-up)
Bot heartbeat: ✓ healthy (1m ago)
Public watcher logs: [link to S3]
```

### State machine for a single claim

```
[user deposits]
       │
       ▼
[NOT_SUBMITTED] ──────► [SUBMITTED] ──────► [PENDING for 48h]
                       (+25% bond)              │
                                                ├──► [VETOED] (bond slashed 25/50/25)
                                                │
                                                └──► [EXECUTED] (bond returned)
```

UI polls `BridgeMinter.getClaim(nonce)` for state; auto-shows "Execute" button at expiration.

---

## 10. Open questions (for review)

These are decisions still needing operator input or further analysis before contract specification begins:

1. **Validator set for Hyperlane mailbox**: 1 (operator only) at launch, 3 by day 30, 5 by day 90 — or different cadence? Current default in this doc: 1→3→5 expansion, all operator-controlled.
2. **Fraud-prover bond size**: 25% of claim (matches submitter bond) — but slashed only if proof fails verification. Should it be lower (since invalid proof is cryptographically obvious)? Suggestion: 5% prover bond, 25% submitter bond.
3. **Replay window for valid Etica deposits**: how long does a real depositor have to claim? Suggestion: 365 days (standard), then funds become "stuck deposits" recoverable via 2-year stale-deposit timelock.
4. **Bond denomination**: ETH/BNB native (most accessible to claimers) or wETX (aligns incentives)? Suggestion: native gas at launch, add wETX option later.
5. **Communications during incidents**: dedicated bridge-status Telegram channel + on-chain `BridgeStatus` event log. Operator commitment to public post-incident report within 72h of any veto.
6. **Sherlock contest window**: opt-in after self-audit? If yes, $25-30K and 2 weeks before mainnet deploy.
7. **Fee splits inside FeeRouter**: 0.1% → 100% to harvester via standard 10/10/40/40 split, OR carve out a portion to the bridge insurance fund directly (e.g., 20% of fees → insurance, 80% → harvester)? Suggestion: 20% to insurance, 80% to harvester; bridges have higher fraud risk than non-bridge protocol fees.
8. **Tron timeline**: target 60-90 days post-Eth+BNB launch? Or open-ended?

---

## 11. References

- Hyperlane docs: <https://docs.hyperlane.xyz>
- Hyperlane permissionless deployment: <https://docs.hyperlane.xyz/docs/deploy-hyperlane>
- Hyperlane audits: <https://github.com/hyperlane-xyz/audits>
- Across protocol (optimistic + bond reference design): <https://docs.across.to>
- Optimism withdrawal model (challenge window reference): <https://specs.optimism.io>
- Treasury harvester (fee distribution pattern reused): `0x9adc6298efdcc1604cb95daab33331f866ddbe76`
- ETX token: `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- Treasury wallet: `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`

---

## 12. Sign-off

This design represents the locked architecture as agreed during exploration. Before any contract code is written:

- [ ] Operator reviews this document end-to-end
- [ ] Open questions in §10 resolved or explicitly deferred
- [ ] Sherlock contest decision made (in or out)
- [ ] Threat model in §6 stress-tested with adversarial review
- [ ] Implementation phasing in §8 confirmed

After sign-off, contract specification (function signatures, storage layout, full event list, full revert reason list) becomes the next artifact, then implementation, then audit, then deploy.
