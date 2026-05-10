#!/usr/bin/env node

const apiBase = "https://discord.com/api/v10";
const tokenRaw = process.env.DISCORD_TEST_BOT_TOKEN?.trim();
const channelId = process.env.DISCORD_TEST_CHANNEL_ID?.trim();
const openclawBotId = process.env.OPENCLAW_DISCORD_BOT_ID?.trim();
const timeoutMs = Number.parseInt(process.env.DISCORD_TEST_TIMEOUT_MS ?? "180000", 10);
const pollMs = Number.parseInt(process.env.DISCORD_TEST_POLL_MS ?? "5000", 10);
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
let reply = null;
while (Date.now() - startedAt < timeoutMs && !reply) {
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  const messages = await request("GET", `/channels/${channelId}/messages?limit=30`);
  reply = messages.find(
    (message) =>
      message.id !== sent.id &&
      message.author?.id !== testBotId &&
      typeof message.content === "string" &&
      message.content.includes(nonce),
  );
}

const result = reply
  ? {
      ok: true,
      nonce,
      sentMessageId: sent.id,
      replyMessageId: reply.id,
      replyAuthorId: reply.author?.id,
      replyAuthor: reply.author?.username,
      replyContent: reply.content,
      elapsedMs: Date.now() - startedAt,
    }
  : {
      ok: false,
      nonce,
      sentMessageId: sent.id,
      error: "No matching Discord reply before timeout.",
      elapsedMs: Date.now() - startedAt,
    };

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
