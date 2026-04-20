# EticaHub Bridge — Audit Request for Proposal

This document is the outreach packet for the EticaHub bridge audit. It has two
parts:

1. **Outreach email template** — copy/paste into your mail client, fill the
   two placeholders (`<RECIPIENT>` and `<YOUR NAME>`), and send to each firm.
2. **RFP body** — the technical scope attached or linked from the email.

The target firms, in rough order of fit for a small lock/mint bridge with a
multisig verifier:

- **Zellic** — https://www.zellic.io/contact (fast, good at cross-chain)
- **Cantina** (competitive bounty) — https://cantina.xyz/ (bid-based; best
  price discovery if you are OK with a 2–4 week public competition)
- **Spearbit** — https://spearbit.com/contact (strong for novel designs)
- **Trail of Bits** — https://www.trailofbits.com/contact (gold standard,
  longer lead time and higher cost)
- **Quantstamp** — https://quantstamp.com/request-proposal (broad, quicker)

Rule of thumb: get quotes from at least two firms. A small, well-scoped bridge
audit currently runs **2–4 engineer-weeks** and **$30k–$80k**. Cantina
competitions are typically cheaper but slower.

---

## 1. Outreach email

**Subject:** Audit request — EticaHub Bridge (lock/mint, ~1,200 LoC Solidity)

```
Hi <RECIPIENT>,

I'm <YOUR NAME>, founder of EticaHub — a DeFi + DeSci dapp suite being built
on the Etica Protocol (EVM-compatible chain, ID 61803). We are preparing to
deploy our cross-chain bridge and would like to commission an independent
security audit before mainnet.

Scope at a glance
- Two Solidity contracts (BridgeVault on Etica, BridgeMinter on Ethereum)
  plus a wrapped-asset ERC-20 (wETI) and a shared M-of-N ECDSA verifier.
- ~1,200 LoC Solidity total, Foundry-based, 21 in-repo unit tests plus a
  full round-trip invariant test.
- Off-chain: a stateless Express coordinator and per-validator signer process
  that produce EIP-191 personal_sign signatures over a canonical digest.
  Out-of-scope for the on-chain audit but reviewable if helpful.
- Trust model: 2-of-3 ECDSA multisig for the MVP, upgradeable validator set.
- Single-fee-point design (fees charged only on the destination side).

Repo: https://github.com/iamdexx/etica-hub (public)
Audit scope doc: https://github.com/iamdexx/etica-hub/blob/main/docs/BRIDGE_AUDIT_SCOPE.md
RFP (attached / below).

We'd like to lock in an engagement starting in the next 2–4 weeks. Could you
send availability, indicative pricing, and your standard engagement terms?

Happy to hop on a 20-minute call to walk through the architecture and answer
questions.

Thanks,
<YOUR NAME>
```

---

## 2. RFP body

### 2.1 Project summary

EticaHub is a three-phase dapp ecosystem on the Etica Protocol:

- **Phase 1 — EticaSwap V2**: a Uniswap V2 fork providing the first on-chain
  DEX on Etica.
- **Phase 2 — Research Hub**: a proposal reader + tipping + subscription
  layer for Etica's DeSci research corpus.
- **Phase 3 — Bridge** (this RFP): lock/mint bridge between Etica mainnet and
  Ethereum mainnet using a 2-of-3 ECDSA multisig verifier.

Only Phase 3 is in scope for this audit. Phases 1 and 2 are either already
shipped or will be audited separately.

### 2.2 Scope

**In scope (Solidity, `packages/contracts/`):**

| File | LoC (approx) | Purpose |
|---|---|---|
| `src/bridge/BridgeVault.sol` | 180 | Etica-side: locks ETI on deposit, releases on withdraw against valid multisig. |
| `src/bridge/BridgeMinter.sol` | 200 | Ethereum-side: mints wETI against valid multisig, burns wETI on user-initiated bridge-back. |
| `src/bridge/WETI.sol` | 90 | ERC-20 with `mint` / `burnFrom` gated to the minter. |
| `src/bridge/MultisigVerifier.sol` | 120 | M-of-N ECDSA signature aggregation over an EIP-191 digest. |
| `src/bridge/BridgeAdmin.sol` | 110 | Owner-gated validator rotation + fee treasury + pause controls. |
| Shared libs | 50 | `SafeERC20`, reentrancy guard, custom errors. |

**Out of scope:**

- EticaSwap V2 (`src/swap/`) — already code-reviewed, separate audit track.
- ETX reward stack (`src/token/`, `src/rewards/`) — held from deploy, separate track.
- Research Hub (`src/research/`) — not yet mainnet-bound.
- Off-chain coordinator and signer (`apps/relayer/`) — optional appendix review.
- Frontend (`apps/web/`) — not in scope.

### 2.3 Threat model

See `docs/BRIDGE_AUDIT_SCOPE.md` §3 for the full trust model. Briefly:

- **Trusted:** a 2-of-3 validator multisig controls mint authority. Validator
  keys are held by the founding team and an independent partner. Key rotation
  is on-chain via `BridgeAdmin.rotateValidator`.
- **Untrusted:** users (deposits, burns, claims), the coordinator (stateless
  relay, cannot forge sigs), the public RPC.
- **Known limitation:** no light-client verification, no slashing, no withdraw
  queue. All four are documented non-goals for MVP.

### 2.4 Invariants we want verified

1. **Solvency:** at all times, `BridgeVault.ETI.balanceOf(vault) ≥ wETI.totalSupply()` on the peer chain, minus in-flight deposits.
2. **Single fee point:** fees are charged only on the destination side. A
   round-trip deposit → mint → burn → withdraw must not double-fee.
3. **Replay protection:** a given `(srcChainId, nonce)` can only be consumed
   once per direction.
4. **Signature aggregation:** `MultisigVerifier` requires ≥ threshold unique
   validator signatures over the exact canonical digest; no signature
   malleability or order-dependence bypass.

### 2.5 Deliverables requested

- Findings report (critical / high / medium / low / informational), with
  reproduction steps for each finding.
- Verdict on each of the four invariants above.
- PR or patch suggestions for all fixes.
- Re-audit of the fix PRs.
- Final attestation for public publication alongside mainnet deploy.

### 2.6 Timeline

- **Week 0:** firm selected, engagement signed.
- **Week 1–2:** primary audit, daily async check-ins welcome.
- **Week 3:** draft findings, fix PRs submitted by our team.
- **Week 4:** re-audit of fixes, final report.
- **Week 4+:** mainnet deploy, final attestation published.

Flexible on this timeline — happy to match your calendar.

### 2.7 Technical environment

- **Toolchain:** Foundry (forge 0.2+), Solidity 0.8.26.
- **Tests:** `cd packages/contracts && forge test -vv` — 41 passing.
- **Running locally:** see `README.md` quick-start.
- **Repo:** https://github.com/iamdexx/etica-hub (public, MIT).
- **Commit range for audit:** will pin a specific SHA at engagement start.

### 2.8 Points of contact

- Primary: `<YOUR NAME>`, founder — `<YOUR EMAIL>`
- Technical: `<TECHNICAL CONTACT>`
- Slack / Discord / Telegram for async check-ins — your choice.

### 2.9 Budget

We are open to fixed-fee, time-and-materials, or Cantina-style competitive
bidding. Please send your standard terms with any quote. Typical range we
expect for this scope: $30k–$80k USD equivalent.
