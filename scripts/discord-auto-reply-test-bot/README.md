# Discord Auto Reply Test Bot

Small standalone Discord bot for manual response testing. It connects directly
to the Discord Gateway, listens for messages, and replies in the same channel.

It is intentionally separate from OpenClaw so it can prove whether Discord
delivery and bot permissions are working outside the OpenClaw gateway.

## Run on Windows PowerShell

The scripts prefer repo-root `.env` values over inherited shell environment
variables, then fall back to process env. Use these generic names in `.env`:

```text
DISCORD_BOT_TOKEN=YOUR_TEST_BOT_TOKEN
DISCORD_CHANNEL_ID=123456789012345678
```

```powershell
$env:DISCORD_TEST_PREFIX = "!oc-ping"
$env:DISCORD_TEST_REPLY = "test-bot-ok"
node scripts/discord-auto-reply-test-bot/bot.mjs
```

Then send this in the configured Discord channel:

```text
!oc-ping
```

The bot replies to the triggering message. Leave `DISCORD_CHANNEL_ID` and
`DISCORD_TEST_CHANNEL_ID` unset to allow any channel the bot can read. Set
`DISCORD_TEST_PREFIX` to an empty string to reply to every non-bot message.

## Required Discord Settings

- Bot token from a separate test Discord application.
- Message Content Intent enabled for the test bot.
- Channel permissions: View Channel, Send Messages, Read Message History.

Do not commit real bot tokens.

## OpenClaw roundtrip smoke

Use `roundtrip.mjs` when the test bot should act as the sender and wait for an
OpenClaw reply in Discord. The script posts a mention, injects a unique nonce
into the prompt, polls recent channel messages, and exits non-zero if OpenClaw
does not reply with the nonce before the timeout.

```powershell
$env:OPENCLAW_DISCORD_BOT_ID = "234567890123456789"
node --use-system-ca scripts/discord-auto-reply-test-bot/roundtrip.mjs "Reply exactly {nonce}"
```

Optional settings:

- `DISCORD_TEST_TIMEOUT_MS` default `180000`
- `DISCORD_TEST_POLL_MS` default `5000`
- `DISCORD_TEST_LOG_DIR` default `.artifacts/discord-auto-reply-test-bot`
- `DISCORD_TEST_LOG=0` disables transcript writing

On Windows networks with custom certificate inspection, prefer
`node --use-system-ca` so Node trusts the system certificate store.

The roundtrip smoke writes a JSON transcript by default. It records the test bot
message, the matched OpenClaw reply text, message IDs, nonce, and timing. It
does not write the bot token or unrelated channel history.

## Local completion notices

For this Windows OpenClaw test setup, future Discord/OpenClaw live tests should
use this test bot when feasible. After a task completes, send a short test-bot
notice that includes `@boww8234`. If the Discord user ID is known, prefer the
resolved mention form so Discord sends an actual notification; otherwise include
the handle text. Write completion notices in Traditional Chinese.

Use `notify.mjs` for completion notices:

```powershell
$env:DISCORD_NOTICE = "@boww8234 done"
node --use-system-ca scripts/discord-auto-reply-test-bot/notify.mjs
```

For Traditional Chinese or other non-ASCII text from Windows automation, prefer
UTF-8 base64 input so PowerShell pipeline encoding cannot replace characters
with question marks:

```powershell
$env:DISCORD_NOTICE_B64 = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("@boww8234 測試通知完成")
)
node --use-system-ca scripts/discord-auto-reply-test-bot/notify.mjs
```

Do not pipe non-ASCII here-strings into `node --input-type=module` on Windows
PowerShell; the native process pipeline can be lossy depending on the active
code page.

Keep the test bot token in `.env`, an environment variable, or a local
credential store. Do not write real bot tokens to git, docs, transcripts, or
logs.
