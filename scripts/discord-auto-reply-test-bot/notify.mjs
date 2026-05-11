#!/usr/bin/env node

import "dotenv/config";

const apiBase = "https://discord.com/api/v10";
const tokenRaw = (process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TEST_BOT_TOKEN)?.trim();
const channelId = (process.env.DISCORD_CHANNEL_ID ?? process.env.DISCORD_TEST_CHANNEL_ID)?.trim();
const noticeUserId = (
  process.env.DISCORD_NOTICE_USER_ID ?? process.env.DISCORD_TEST_NOTICE_USER_ID
)?.trim();
const noticeText = resolveNoticeText();

if (!tokenRaw) {
  console.error("Missing DISCORD_BOT_TOKEN.");
  process.exit(1);
}
if (!channelId) {
  console.error("Missing DISCORD_CHANNEL_ID.");
  process.exit(1);
}
if (!noticeText) {
  console.error("Pass notice text as argv, DISCORD_NOTICE, or DISCORD_NOTICE_B64.");
  process.exit(1);
}

const token = tokenRaw.replace(/^Bot\s+/i, "");
const content = noticeUserId
  ? noticeText.replaceAll("@boww8234", `<@${noticeUserId}>`)
  : noticeText;
const allowedMentions = noticeUserId ? { users: [noticeUserId] } : { parse: [] };

const response = await fetch(`${apiBase}/channels/${channelId}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content,
    allowed_mentions: allowedMentions,
  }),
});

const text = await response.text();
if (!response.ok) {
  console.error(`Discord REST ${response.status}: ${text}`);
  process.exit(1);
}

const data = JSON.parse(text);
console.log(
  JSON.stringify(
    {
      ok: true,
      messageId: data.id,
      channelId: data.channel_id,
      timestamp: data.timestamp,
    },
    null,
    2,
  ),
);

function resolveNoticeText() {
  const argvText = process.argv.slice(2).join(" ").trim();
  if (argvText) {
    return argvText;
  }

  const base64Text = (
    process.env.DISCORD_NOTICE_B64 ?? process.env.DISCORD_TEST_NOTICE_B64
  )?.trim();
  if (base64Text) {
    return Buffer.from(base64Text, "base64").toString("utf8").trim();
  }

  return (process.env.DISCORD_NOTICE ?? process.env.DISCORD_TEST_NOTICE)?.trim() ?? "";
}
