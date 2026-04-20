# EticaHub — your operator checklist

This is the short, human-sized version of what's on your plate. Work through
it in order. Everything marked 🟢 is safe / reversible. 🟡 burns gas. 🔴 is
irreversible and touches real value.

---

## 1. Merge the safe PRs 🟢 (~5 min)

Open each PR, click **Merge pull request** → **Confirm merge**. They don't
conflict with each other in the intended merge order:

| # | Title | Why safe | Merge order |
|---|---|---|---|
| [#1](https://github.com/iamdexx/etica-hub/pull/1) | scaffold monorepo | no deploys, CI green | 1st |
| [#3](https://github.com/iamdexx/etica-hub/pull/3) | live swap UI + anvil fork | no deploys, tested end-to-end | 2nd |
| [#4](https://github.com/iamdexx/etica-hub/pull/4) | Research Hub | no deploys, CI green | 3rd |
| [#8](https://github.com/iamdexx/etica-hub/pull/8) | docs (audit + runbook + FAQ) | pure docs | 4th |

After each merge, GitHub will auto-close the others' rebase lines; no action
needed.

## 2. Hold these until you're ready 🟡🔴

| # | Title | Holds until |
|---|---|---|
| [#2](https://github.com/iamdexx/etica-hub/pull/2) | ETX reward stack | you want to flip rewards on + have liquidity |
| [#5](https://github.com/iamdexx/etica-hub/pull/5) | bridge contracts | 🔴 **audit complete** |
| [#6](https://github.com/iamdexx/etica-hub/pull/6) | bridge relayer | 🔴 **audit complete** |
| [#7](https://github.com/iamdexx/etica-hub/pull/7) | bridge UI | 🔴 **audit complete** |

Do **not** merge #5–#7 to `main` before audit sign-off. If you want the code
visible on a long-lived branch for auditors, rebase them onto a
`bridge-audit` branch and link that SHA in the audit engagement.

## 3. Wire up Vercel preview deploys 🟢 (~3 min)

Follow `docs/VERCEL_SETUP.md`. Single-use; next PR gets a live URL.

## 4. Send the audit outreach 🟢 (~10 min)

1. Open `docs/AUDIT_RFP.md`.
2. Fill `<YOUR NAME>`, `<YOUR EMAIL>`, `<TECHNICAL CONTACT>`.
3. Send to at least two firms (recommended: Zellic + Cantina competition, or
   Zellic + Spearbit).
4. Collect quotes, pick one, sign engagement.
5. Ping me when you want to pin the commit SHA and hand off to the auditor.

## 5. Deploy EticaSwap to Etica mainnet 🔴 (after #1 + #3 merged)

Follow `docs/DEPLOYMENT_RUNBOOK.md` §1 exactly. TL;DR of the commands you'll
run on **your machine** with **your key** (not mine):

```bash
git clone https://github.com/iamdexx/etica-hub && cd etica-hub
pnpm install
cd packages/contracts
forge install

export DEPLOYER_PRIVATE_KEY=0x<your_key>
export TREASURY_ADDRESS=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
export RPC_URL=https://eticamainnet.eticascan.org

forge script script/DeploySwap.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --legacy \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Paste the three deployed addresses (Factory / Router / WEGAZ) into a reply to
me. I open a follow-up PR wiring them into `packages/shared/src/addresses.ts`
and turning the live swap UI on for chain 61803.

### Budget

- Gas: estimate **~0.05–0.15 EGAZ** for all three contracts at Etica's
  current gas prices. Have at least **0.25 EGAZ** in the deployer wallet to
  be safe.
- If the deployer wallet runs out mid-deploy, `forge script --resume` picks
  up where it left off.

### After deploy

- Seed the first ETI/EGAZ pool with a **small amount first** (e.g. $100 each
  side) to verify the swap math live before you commit serious liquidity.
- Update the README's "Phase status" table — I can do that in the same
  follow-up PR.

## 6. Decide on ETX and launch cadence (no rush)

After #5 is stable, tell me when you want to:

- Deploy ETX + MasterChef + xETXVault on mainnet.
- Seed the initial gauge (which pools earn ETX, at what weight).
- Announce publicly.

I'll prep the coordinated release — scripts + UI flip + announcement blurb —
and you run the deploy when ready.

## 7. Safety reminders 🔴

- **Never paste your private key into chat, any file, or any cloud tool.**
  Keys stay in your local shell env or (better) a hardware wallet.
- **Never use the VM-side deployer key for real funds.** It's a dev artifact
  and has been shredded; don't re-fund it.
- **Always test promotions on a fork or Crucible first** when feasible.
- **If anything feels wrong during a mainnet deploy, Ctrl+C immediately.**
  `forge script` without `--broadcast` is a dry-run; when in doubt, dry-run.
