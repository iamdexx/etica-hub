# Vercel preview deploys — setup

One-time setup to get a live preview URL on every PR. ~3 minutes of clicks.

## What you get

- Every open PR automatically builds `apps/web` and comments a live URL on
  the PR.
- `main` auto-deploys to your production URL (e.g. `etica-hub.vercel.app` or
  a custom domain).
- Zero cost on Vercel's Hobby tier for this repo size.

## Setup steps (on your side)

1. Go to https://vercel.com/new and sign in with your GitHub account
   (`iamdexx`).
2. Click **Import Git Repository** → select **`iamdexx/etica-hub`**.
   - If you don't see it listed, click **Adjust GitHub App Permissions** and
     grant Vercel access to the repo.
3. On the **Configure Project** screen:
   - **Framework Preset:** Next.js (auto-detected)
   - **Root Directory:** click **Edit** → set to `apps/web`
   - **Build Command:** leave default (`next build`)
   - **Install Command:** `cd ../.. && pnpm install --frozen-lockfile`
   - **Output Directory:** leave default (`.next`)
   - **Node.js Version:** 20.x
4. Click **Deploy**. First build takes ~2 minutes.
5. Once deployed, go to **Project Settings → Git** and verify:
   - **Production Branch:** `main`
   - **Preview Deployments:** `Enabled for all branches`

That's it. Next PR you open (or rebase) will get a Vercel comment with the
preview URL.

## Env vars (if/when needed)

The current `apps/web` has no required env vars — it only talks to public
RPCs and reads deployed contract addresses from `packages/shared`. No setup
needed at first.

When the bridge UI ships with a live coordinator, add:

- `NEXT_PUBLIC_BRIDGE_COORDINATOR_URL` — your coordinator's public URL
  (HTTPS).

Set it in **Project Settings → Environment Variables** for both Production
and Preview.

## Custom domain (optional)

Once comfortable:

1. Project Settings → Domains → **Add** → `app.eticahub.xyz` (or whichever
   you own).
2. Vercel shows DNS records to add at your registrar. Add them.
3. Cert provisioning takes ~1 minute.

## Notes

- `vercel.json` at the repo root is committed for pnpm monorepo hints. You
  should not need to edit it.
- If a preview build fails with `forge: command not found`, that's expected:
  Vercel only builds the web app, not the contracts. The `package.json`
  `build` script for `apps/web` already avoids invoking forge.
