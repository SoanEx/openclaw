import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { createDiscordRestClient } from "../client.js";
import type { Client } from "../internal/discord.js";
import {
  buildDiscordInboundReplayKey,
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordMessageRunQueue,
  type DiscordMessageRunQueueTestingHooks,
} from "./message-run-queue.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { sendTyping } from "./typing.js";

type PreflightDiscordMessage =
  typeof import("./message-handler.preflight.js").preflightDiscordMessage;

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  __testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
};

let messagePreflightRuntimePromise:
  | Promise<typeof import("./message-handler.preflight.js")>
  | undefined;

async function loadMessagePreflightRuntime() {
  messagePreflightRuntimePromise ??= import("./message-handler.preflight.js");
  return await messagePreflightRuntimePromise;
}

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function shouldSendAcceptedDiscordTypingCue(ctx: DiscordMessagePreflightContext): boolean {
  if (ctx.abortSignal?.aborted) {
    return false;
  }
  if (!ctx.isDirectMessage || ctx.isGuildMessage || ctx.isGroupDm) {
    return false;
  }
  if (!ctx.messageText.trim()) {
    return false;
  }
  const configuredTypingMode = ctx.cfg.session?.typingMode ?? ctx.cfg.agents?.defaults?.typingMode;
  return configuredTypingMode === undefined || configuredTypingMode === "instant";
}

function queueAcceptedDiscordTypingCue(ctx: DiscordMessagePreflightContext): void {
  if (!shouldSendAcceptedDiscordTypingCue(ctx)) {
    return;
  }
  const { rest } = createDiscordRestClient({
    cfg: ctx.cfg,
    token: ctx.token,
    accountId: ctx.accountId,
  });
  void sendTyping({ rest, channelId: ctx.messageChannelId }).catch((err) => {
    logVerbose(
      `discord early typing cue failed for channel ${ctx.messageChannelId}: ${String(err)}`,
    );
  });
}

function formatElapsedMs(startedAt: number): string {
  return ` durationMs=${Math.max(0, Date.now() - startedAt)}`;
}

function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeDiscordInboundEvent(params: {
  accountId: string;
  data: DiscordMessageEvent;
  replayKey?: string | null;
  replayKeys?: readonly string[];
}): string {
  const channelId =
    resolveDiscordMessageChannelId({
      message: params.data.message,
      eventChannelId: params.data.channel_id,
    }) ??
    params.data.channel_id ??
    "unknown";
  const messageId = params.data.message?.id ?? "unknown";
  const details = [`account=${params.accountId}`, `channel=${channelId}`, `message=${messageId}`];
  if (params.replayKey) {
    details.push(`replay=${params.replayKey}`);
  }
  if (params.replayKeys) {
    details.push(`replayKeys=${params.replayKeys.length}`);
  }
  return details.join(" ");
}

function logDiscordMessageDiagnostic(
  runtime: DiscordMessageHandlerParams["runtime"],
  event: string,
  details: string,
  extra = "",
) {
  try {
    runtime.log?.(`discord message ${event}: ${details}${extra}`);
  } catch {
    // Diagnostic logging must not affect message processing.
  }
}

async function runDiscordPreflightWithDiagnostics(params: {
  runtime: DiscordMessageHandlerParams["runtime"];
  accountId: string;
  data: DiscordMessageEvent;
  replayKeys: readonly string[];
  batchSize: number;
  run: () => Promise<DiscordMessagePreflightContext | null>;
}): Promise<DiscordMessagePreflightContext | null> {
  const startedAt = Date.now();
  const details = describeDiscordInboundEvent({
    accountId: params.accountId,
    data: params.data,
    replayKeys: params.replayKeys,
  });
  logDiscordMessageDiagnostic(
    params.runtime,
    "preflight start",
    details,
    ` batchSize=${params.batchSize}`,
  );
  try {
    const ctx = await params.run();
    logDiscordMessageDiagnostic(
      params.runtime,
      "preflight end",
      details,
      ` status=${ctx ? "accepted" : "dropped"}${ctx?.route.sessionKey ? ` session=${ctx.route.sessionKey}` : ""}${formatElapsedMs(startedAt)}`,
    );
    return ctx;
  } catch (error) {
    logDiscordMessageDiagnostic(
      params.runtime,
      "preflight end",
      details,
      ` status=error${formatElapsedMs(startedAt)} error=${formatDiagnosticError(error)}`,
    );
    throw error;
  }
}

async function commitDiscordInboundReplayWithDiagnostics(params: {
  runtime: DiscordMessageHandlerParams["runtime"];
  accountId: string;
  data: DiscordMessageEvent;
  replayKeys: readonly string[];
  replayGuard: ReturnType<typeof createDiscordInboundReplayGuard>;
  reason: string;
}) {
  const details = describeDiscordInboundEvent({
    accountId: params.accountId,
    data: params.data,
    replayKeys: params.replayKeys,
  });
  logDiscordMessageDiagnostic(
    params.runtime,
    "replay commit start",
    details,
    ` reason=${params.reason}`,
  );
  await commitDiscordInboundReplay({
    replayKeys: params.replayKeys,
    replayGuard: params.replayGuard,
  });
  logDiscordMessageDiagnostic(
    params.runtime,
    "replay commit end",
    details,
    ` reason=${params.reason}`,
  );
}

function releaseDiscordInboundReplayWithDiagnostics(params: {
  runtime: DiscordMessageHandlerParams["runtime"];
  accountId: string;
  data: DiscordMessageEvent;
  replayKeys: readonly string[];
  replayGuard: ReturnType<typeof createDiscordInboundReplayGuard>;
  error?: unknown;
  reason: string;
}) {
  const details = describeDiscordInboundEvent({
    accountId: params.accountId,
    data: params.data,
    replayKeys: params.replayKeys,
  });
  logDiscordMessageDiagnostic(
    params.runtime,
    "replay release start",
    details,
    ` reason=${params.reason}`,
  );
  releaseDiscordInboundReplay({
    replayKeys: params.replayKeys,
    error: params.error,
    replayGuard: params.replayGuard,
  });
  logDiscordMessageDiagnostic(
    params.runtime,
    "replay release end",
    details,
    ` reason=${params.reason}`,
  );
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl = params.__testing?.preflightDiscordMessage;
  const replayGuard = createDiscordInboundReplayGuard();
  const messageRunQueue = createDiscordMessageRunQueue({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    replayGuard,
    __testing: params.__testing,
  });

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    replayKey?: string;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia:
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        releaseDiscordInboundReplayWithDiagnostics({
          runtime: params.runtime,
          accountId: params.accountId,
          data: last.data,
          replayKeys,
          error: abortSignal.reason,
          replayGuard,
          reason: "flush-aborted",
        });
        return;
      }
      try {
        if (entries.length === 1) {
          const preflight =
            preflightDiscordMessageImpl ??
            (await loadMessagePreflightRuntime()).preflightDiscordMessage;
          const ctx = await runDiscordPreflightWithDiagnostics({
            runtime: params.runtime,
            accountId: params.accountId,
            data: last.data,
            replayKeys,
            batchSize: entries.length,
            run: async () =>
              await preflight({
                ...params,
                ackReactionScope,
                groupPolicy,
                abortSignal,
                data: last.data,
                client: last.client,
              }),
          });
          if (!ctx) {
            await commitDiscordInboundReplayWithDiagnostics({
              runtime: params.runtime,
              accountId: params.accountId,
              data: last.data,
              replayKeys,
              replayGuard,
              reason: "preflight-dropped",
            });
            return;
          }
          applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
          queueAcceptedDiscordTypingCue(ctx);
          messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
          return;
        }
        const combinedBaseText = entries
          .map((entry) =>
            resolveDiscordMessageText(entry.data.message, { includeForwarded: false }),
          )
          .filter(Boolean)
          .join("\n");
        const syntheticMessage = Object.create(Object.getPrototypeOf(last.data.message), {
          ...Object.getOwnPropertyDescriptors(last.data.message),
          content: { value: combinedBaseText, enumerable: true, configurable: true },
          attachments: { value: [], enumerable: true, configurable: true },
          message_snapshots: {
            value: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
            enumerable: true,
            configurable: true,
          },
          messageSnapshots: {
            value: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
            enumerable: true,
            configurable: true,
          },
          rawData: {
            value: { ...(last.data.message as { rawData?: Record<string, unknown> }).rawData },
            enumerable: true,
            configurable: true,
          },
        }) as DiscordMessageEvent["message"];
        const syntheticData: DiscordMessageEvent = {
          ...last.data,
          message: syntheticMessage,
        };
        const preflight =
          preflightDiscordMessageImpl ??
          (await loadMessagePreflightRuntime()).preflightDiscordMessage;
        const ctx = await runDiscordPreflightWithDiagnostics({
          runtime: params.runtime,
          accountId: params.accountId,
          data: syntheticData,
          replayKeys,
          batchSize: entries.length,
          run: async () =>
            await preflight({
              ...params,
              ackReactionScope,
              groupPolicy,
              abortSignal,
              data: syntheticData,
              client: last.client,
            }),
        });
        if (!ctx) {
          await commitDiscordInboundReplayWithDiagnostics({
            runtime: params.runtime,
            accountId: params.accountId,
            data: syntheticData,
            replayKeys,
            replayGuard,
            reason: "preflight-dropped",
          });
          return;
        }
        applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
        if (entries.length > 1) {
          const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
          if (ids.length > 0) {
            const ctxBatch = ctx as typeof ctx & {
              MessageSids?: string[];
              MessageSidFirst?: string;
              MessageSidLast?: string;
            };
            ctxBatch.MessageSids = ids;
            ctxBatch.MessageSidFirst = ids[0];
            ctxBatch.MessageSidLast = ids[ids.length - 1];
          }
        }
        queueAcceptedDiscordTypingCue(ctx);
        messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      } catch (error) {
        if (error instanceof DiscordRetryableInboundError) {
          releaseDiscordInboundReplayWithDiagnostics({
            runtime: params.runtime,
            accountId: params.accountId,
            data: last.data,
            replayKeys,
            error,
            replayGuard,
            reason: "preflight-retryable-error",
          });
        } else {
          await commitDiscordInboundReplayWithDiagnostics({
            runtime: params.runtime,
            accountId: params.accountId,
            data: last.data,
            replayKeys,
            replayGuard,
            reason: "preflight-nonretryable-error",
          });
        }
        throw error;
      }
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      const replayKey = buildDiscordInboundReplayKey({
        accountId: params.accountId,
        data,
      });
      const claimDetails = describeDiscordInboundEvent({
        accountId: params.accountId,
        data,
        replayKey,
      });
      logDiscordMessageDiagnostic(params.runtime, "replay claim start", claimDetails);
      const replayClaimed = await claimDiscordInboundReplay({
        replayKey,
        replayGuard,
      });
      logDiscordMessageDiagnostic(
        params.runtime,
        "replay claim end",
        claimDetails,
        ` status=${replayClaimed ? "claimed" : "duplicate"}`,
      );
      if (!replayClaimed) {
        return;
      }

      await debouncer.enqueue({
        data,
        client,
        abortSignal: options?.abortSignal,
        replayKey: replayKey ?? undefined,
      });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };

  handler.deactivate = messageRunQueue.deactivate;

  return handler;
}
