#!/usr/bin/env node

import { readDiscordEnv } from "./env.mjs";

const apiBase = "https://discord.com/api/v10";
const tokenRaw = readDiscordEnv("DISCORD_BOT_TOKEN", ["DISCORD_TEST_BOT_TOKEN"]);
const channelId = readDiscordEnv("DISCORD_CHANNEL_ID", ["DISCORD_TEST_CHANNEL_ID"]);
const noticeUserId = readDiscordEnv("DISCORD_NOTICE_USER_ID", ["DISCORD_TEST_NOTICE_USER_ID"]);
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

  const base64Text = readDiscordEnv("DISCORD_NOTICE_B64", ["DISCORD_TEST_NOTICE_B64"])?.trim();
  if (base64Text) {
    return Buffer.from(base64Text, "base64").toString("utf8").trim();
  }

  return readDiscordEnv("DISCORD_NOTICE", ["DISCORD_TEST_NOTICE"])?.trim() ?? "";
}
