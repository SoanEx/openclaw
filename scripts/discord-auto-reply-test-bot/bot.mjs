#!/usr/bin/env node

const apiBase = "https://discord.com/api/v10";
const gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
const rawToken = (process.env.DISCORD_TEST_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN)?.trim();
const channelFilter = process.env.DISCORD_TEST_CHANNEL_ID?.trim();
const guildFilter = process.env.DISCORD_TEST_GUILD_ID?.trim();
const prefix = process.env.DISCORD_TEST_PREFIX ?? "!oc-ping";
const replyText = process.env.DISCORD_TEST_REPLY ?? "test-bot-ok";

if (!rawToken) {
  console.error("Set DISCORD_TEST_BOT_TOKEN before starting the test bot.");
  process.exit(1);
}

const token = rawToken.replace(/^Bot\s+/i, "");
const authHeader = `Bot ${token}`;
const intents = 512 | 4096 | 32768; // GuildMessages, DirectMessages, MessageContent
let sequence = null;
let heartbeatTimer = null;
let socket = null;

function log(message) {
  console.log(`[discord-test-bot] ${message}`);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function discordRequest(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Discord REST ${response.status}: ${text}`);
  }
  return await response.json();
}

function shouldReply(message) {
  if (!message || message.author?.bot) {
    return false;
  }
  if (channelFilter && message.channel_id !== channelFilter) {
    return false;
  }
  if (guildFilter && message.guild_id !== guildFilter) {
    return false;
  }
  if (prefix === "") {
    return true;
  }
  return typeof message.content === "string" && message.content.includes(prefix);
}

async function replyToMessage(message) {
  await discordRequest(`/channels/${message.channel_id}/messages`, {
    content: `${replyText} (${message.id})`,
    message_reference: {
      message_id: message.id,
      channel_id: message.channel_id,
      guild_id: message.guild_id,
      fail_if_not_exists: false,
    },
    allowed_mentions: { parse: [] },
  });
  log(`replied channel=${message.channel_id} message=${message.id}`);
}

function identify() {
  send({
    op: 2,
    d: {
      token,
      intents,
      properties: {
        os: process.platform,
        browser: "openclaw-discord-test-bot",
        device: "openclaw-discord-test-bot",
      },
    },
  });
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({ op: 1, d: sequence });
  }, intervalMs);
}

function connect() {
  socket = new WebSocket(gatewayUrl);

  socket.addEventListener("open", () => {
    log("gateway connected");
  });

  socket.addEventListener("message", (event) => {
    void (async () => {
      const packet = JSON.parse(String(event.data));
      if (typeof packet.s === "number") {
        sequence = packet.s;
      }

      if (packet.op === 10) {
        startHeartbeat(packet.d.heartbeat_interval);
        identify();
        return;
      }

      if (packet.op === 1) {
        send({ op: 1, d: sequence });
        return;
      }

      if (packet.t === "READY") {
        log(`ready as ${packet.d.user.username}#${packet.d.user.discriminator}`);
        return;
      }

      if (packet.t === "MESSAGE_CREATE" && shouldReply(packet.d)) {
        await replyToMessage(packet.d);
      }
    })().catch((error) => {
      console.error(`[discord-test-bot] ${String(error)}`);
    });
  });

  socket.addEventListener("close", (event) => {
    stopHeartbeat();
    log(`gateway closed code=${event.code} reason=${event.reason || "none"}`);
    setTimeout(connect, 5000).unref?.();
  });

  socket.addEventListener("error", () => {
    log("gateway socket error");
  });
}

process.on("SIGINT", () => {
  stopHeartbeat();
  socket?.close(1000, "shutdown");
  process.exit(0);
});

connect();
