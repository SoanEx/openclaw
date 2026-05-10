#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const apiBase = "https://discord.com/api/v10";
const tokenRaw = process.env.DISCORD_TEST_BOT_TOKEN?.trim();
const channelId = process.env.DISCORD_TEST_CHANNEL_ID?.trim();
const openclawBotId = process.env.OPENCLAW_DISCORD_BOT_ID?.trim();
const timeoutMs = Number.parseInt(process.env.DISCORD_TEST_TIMEOUT_MS ?? "180000", 10);
const pollMs = Number.parseInt(process.env.DISCORD_TEST_POLL_MS ?? "5000", 10);
const logDir =
  process.env.DISCORD_TEST_LOG_DIR?.trim() ||
  path.join(".artifacts", "discord-auto-reply-test-bot");
const shouldWriteLog = process.env.DISCORD_TEST_LOG !== "0";
const prompt =
  process.argv.slice(2).join(" ").trim() ||
  process.env.DISCORD_TEST_PROMPT?.trim() ||
  "Reply exactly {nonce}";

if (!tokenRaw) {
  console.error("Set DISCORD_TEST_BOT_TOKEN.");
  process.exit(1);
}
if (!channelId) {
  console.error("Set DISCORD_TEST_CHANNEL_ID.");
  process.exit(1);
}
if (!openclawBotId) {
  console.error("Set OPENCLAW_DISCORD_BOT_ID.");
  process.exit(1);
}

const token = tokenRaw.replace(/^Bot\s+/i, "");
const headers = { Authorization: `Bot ${token}` };
const nonce = `OC_TEST_OK_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const testBotId = await resolveCurrentBotId();
const content = `<@${openclawBotId}> ${prompt.replaceAll("{nonce}", nonce)}`;
const createdAt = new Date().toISOString();

async function request(method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw body in the thrown error.
  }
  if (!response.ok) {
    throw new Error(`Discord REST ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function resolveCurrentBotId() {
  const me = await request("GET", "/users/@me");
  return me.id;
}

const sent = await request("POST", `/channels/${channelId}/messages`, {
  content,
  allowed_mentions: { users: [openclawBotId] },
});

const startedAt = Date.now();
let polls = 0;
let reply = null;
while (Date.now() - startedAt < timeoutMs && !reply) {
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  polls += 1;
  const messages = await request("GET", `/channels/${channelId}/messages?limit=30`);
  reply = messages.find(
    (message) =>
      message.id !== sent.id &&
      message.author?.id !== testBotId &&
      typeof message.content === "string" &&
      message.content.includes(nonce),
  );
}

async function writeTranscript(record) {
  if (!shouldWriteLog) {
    return undefined;
  }
  const resolvedLogDir = path.resolve(logDir);
  await fs.mkdir(resolvedLogDir, { recursive: true });
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const logPath = path.join(resolvedLogDir, `roundtrip-${safeTimestamp}-${nonce}.json`);
  await fs.writeFile(logPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path.relative(process.cwd(), logPath) || logPath;
}

const elapsedMs = Date.now() - startedAt;
const transcript = {
  version: 1,
  createdAt,
  completedAt: new Date().toISOString(),
  channelId,
  openclawBotId,
  testBotId,
  nonce,
  promptTemplate: prompt,
  sent: {
    id: sent.id,
    content: sent.content ?? content,
    authorId: sent.author?.id,
    author: sent.author?.username,
    timestamp: sent.timestamp,
  },
  reply: reply
    ? {
        id: reply.id,
        content: reply.content,
        authorId: reply.author?.id,
        author: reply.author?.username,
        timestamp: reply.timestamp,
      }
    : null,
  polls,
  elapsedMs,
};
const logPath = await writeTranscript(transcript);

const result = reply
  ? {
      ok: true,
      nonce,
      sentMessageId: sent.id,
      replyMessageId: reply.id,
      replyAuthorId: reply.author?.id,
      replyAuthor: reply.author?.username,
      replyContent: reply.content,
      elapsedMs,
      ...(logPath ? { logPath } : {}),
    }
  : {
      ok: false,
      nonce,
      sentMessageId: sent.id,
      error: "No matching Discord reply before timeout.",
      elapsedMs,
      ...(logPath ? { logPath } : {}),
    };

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
