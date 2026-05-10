# Discord Auto Reply Test Bot

Small standalone Discord bot for manual response testing. It connects directly
to the Discord Gateway, listens for messages, and replies in the same channel.

It is intentionally separate from OpenClaw so it can prove whether Discord
delivery and bot permissions are working outside the OpenClaw gateway.

## Run on Windows PowerShell

```powershell
$env:DISCORD_TEST_BOT_TOKEN = "YOUR_TEST_BOT_TOKEN"
$env:DISCORD_TEST_CHANNEL_ID = "123456789012345678"
$env:DISCORD_TEST_PREFIX = "!oc-ping"
$env:DISCORD_TEST_REPLY = "test-bot-ok"
node scripts/discord-auto-reply-test-bot/bot.mjs
```

Then send this in the configured Discord channel:

```text
!oc-ping
```

The bot replies to the triggering message. Leave `DISCORD_TEST_CHANNEL_ID`
unset to allow any channel the bot can read. Set `DISCORD_TEST_PREFIX` to an
empty string to reply to every non-bot message.

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
$env:DISCORD_TEST_BOT_TOKEN = "YOUR_TEST_BOT_TOKEN"
$env:DISCORD_TEST_CHANNEL_ID = "123456789012345678"
$env:OPENCLAW_DISCORD_BOT_ID = "234567890123456789"
node --use-system-ca scripts/discord-auto-reply-test-bot/roundtrip.mjs "Reply exactly {nonce}"
```

Optional settings:

- `DISCORD_TEST_TIMEOUT_MS` default `180000`
- `DISCORD_TEST_POLL_MS` default `5000`

On Windows networks with custom certificate inspection, prefer
`node --use-system-ca` so Node trusts the system certificate store.
