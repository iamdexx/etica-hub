# Etica AI Telegram bot — setup runbook

A webhook-driven Q&A assistant for the Etica community Telegram group.
The bot only responds when:

1. **Directly @-mentioned** in a message (`@<bot-username> what's the TVL?`), or
2. The message is a **direct reply** to one of the bot's previous messages.

It works as either an **admin** or a **regular non-admin** member of a group.

This document covers the infra setup. The PR sequence is:

- **PR A** *(this PR)* — webhook scaffold, mention/reply triggers, allowlist,
  canned response. No LLM cost.
- **PR B** — wire OpenAI `gpt-4o-mini` + live context from
  `/api/v1/*` + global per-chat daily cap + global daily USD cap.
- **PR C** — short conversation memory + admin commands (`/stats`, `/clear`).

---

## 1. Create the bot with BotFather

1. Open Telegram → DM [@BotFather](https://t.me/BotFather).
2. `/newbot`.
3. Pick a name (e.g. `EticaBot`) and a username (must end in `bot`, e.g.
   `EticaProtocolBot`).
4. **Save the HTTP token** BotFather gives you — this becomes
   `AIBOT_TELEGRAM_BOT_TOKEN`.
5. **Leave `/setprivacy` set to its default (`Enabled`).** Telegram's
   privacy mode restricts non-admin bots to only seeing messages that
   already match our trigger criteria (mentions + replies + commands),
   which is exactly what we want. Disabling it is unnecessary and would
   leak unrelated chatter to the webhook.
6. *(Optional)* `/setdescription`, `/setabouttext`, `/setuserpic` — purely
   cosmetic.

---

## 2. Add the bot to the group

You can add it as a regular member **or** an admin — it works either way.

- **Non-admin path (recommended for the main community group):** simply
  add the bot to the group. Privacy mode keeps it from seeing anything
  except mentions and replies, which is what it should respond to anyway.
- **Admin path:** promote the bot. With privacy mode still enabled,
  Telegram will deliver every message in the group, but our trigger
  detector still gates responses to mentions and replies only.

To find the chat id, send any message in the group, then visit:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Look for `result[*].message.chat.id` — supergroup ids are large negative
numbers like `-1001234567890`. Save this as `AIBOT_ALLOWED_CHAT_IDS`
(comma-separated if you want multiple groups).

---

## 3. Configure environment variables

In Vercel (Project Settings → Environment Variables), add:

| Variable | Required | Value |
|---|---|---|
| `AIBOT_TELEGRAM_BOT_TOKEN` | yes | the BotFather token |
| `AIBOT_ALLOWED_CHAT_IDS` | yes | comma-separated chat ids the bot may answer in |
| `AIBOT_WEBHOOK_SECRET_TOKEN` | recommended | a long random string used to authenticate Telegram → our webhook |
| `AIBOT_USERNAME` | optional | the bot's `@username` (without `@`); auto-detected from `getMe` if unset |
| `AIBOT_CHAT_DAILY_CAP` | optional | max LLM-backed replies per chat per UTC day (default `1000`) — wired in PR B |
| `AIBOT_DAILY_USD_CAP` | optional | max LLM USD spend per UTC day (default `5`) — wired in PR B |

Redeploy after setting these so the new envs are baked into the build.

---

## 4. Register the webhook

Once Vercel has the envs, point Telegram at the webhook URL.

```bash
TOKEN="<AIBOT_TELEGRAM_BOT_TOKEN>"
SECRET="<AIBOT_WEBHOOK_SECRET_TOKEN>"
URL="https://eticahub.com/api/telegram/webhook"

curl -sS "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${URL}" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode "allowed_updates=[\"message\"]"
```

Expected response:

```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

Verify it's live:

```bash
curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
```

You should see the URL you set, `pending_update_count: 0`, and no
`last_error_message`.

---

## 5. Smoke-test it

In the allowlisted Telegram group, post:

```
@EticaProtocolBot hello
```

The bot should reply (in PR A) with the canned scaffold message
acknowledging it's wired up. If nothing happens:

1. Check `getWebhookInfo` for `last_error_message`.
2. Check Vercel function logs for `/api/telegram/webhook` — the response
   payload includes `triggered`, `reason`, and `send.status` for
   debugging.
3. Confirm the chat id you sent from is on `AIBOT_ALLOWED_CHAT_IDS`.

---

## 6. Rolling the secret token (or rotating bot tokens)

To rotate the webhook secret:

1. Generate a new long random string.
2. Update `AIBOT_WEBHOOK_SECRET_TOKEN` in Vercel and redeploy.
3. Re-run `setWebhook` with the new `secret_token`.

To revoke a leaked bot token entirely: BotFather → `/revoke` → choose
the bot. BotFather gives you a new token; update it in Vercel and
re-register the webhook.

---

## 7. Disabling the bot

Set `AIBOT_TELEGRAM_BOT_TOKEN=` (empty) **or** remove
`AIBOT_ALLOWED_CHAT_IDS`. Either makes `loadAiBotConfig().enabled` false
and the webhook short-circuits to a no-op without contacting Telegram.
The bot will simply stop replying; nothing else in the app is affected.
