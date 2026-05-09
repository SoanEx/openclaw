import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { sendMessageDiscord } from "../send.js";
import {
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS, mergeAbortSignals } from "./timeouts.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  replayGuard?: ClaimableDedupe;
  workerRunTimeoutMs?: number;
  __testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

let messageProcessRuntimePromise:
  | Promise<typeof import("./message-handler.process.js")>
  | undefined;

class DiscordMessageRunTimeoutError extends Error {
  constructor(timeoutMs: number, queueKey: string) {
    super(`discord message run timed out after ${timeoutMs}ms for ${queueKey}`);
    this.name = "DiscordMessageRunTimeoutError";
  }
}

const DISCORD_MESSAGE_TIMEOUT_NOTICE =
  "OpenClaw timed out while processing this Discord message. Please try again.";

async function loadMessageProcessRuntime() {
  messageProcessRuntimePromise ??= import("./message-handler.process.js");
  return await messageProcessRuntimePromise;
}

function resolveDiscordWorkerRunTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === 0) {
    return undefined;
  }
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.floor(timeoutMs);
  }
  return DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS;
}

function describeDiscordInboundJob(job: DiscordInboundJob): string {
  const details = [
    `account=${job.payload.accountId}`,
    `channel=${job.payload.messageChannelId}`,
    `message=${job.payload.message.id}`,
    `queue=${job.queueKey}`,
  ];
  const sessionKey = job.payload.route.sessionKey?.trim();
  if (sessionKey && sessionKey !== job.queueKey) {
    details.push(`session=${sessionKey}`);
  }
  return details.join(" ");
}

function logDiscordInboundJob(
  runtime: RuntimeEnv,
  job: DiscordInboundJob,
  event: string,
  extra?: string,
) {
  runtime.log?.(`discord message ${event}: ${describeDiscordInboundJob(job)}${extra ?? ""}`);
}

function isDiscordMessageRunTimeoutError(error: unknown): error is DiscordMessageRunTimeoutError {
  return error instanceof DiscordMessageRunTimeoutError;
}

async function sendDiscordMessageTimeoutNotice(params: {
  runtime: RuntimeEnv;
  job: DiscordInboundJob;
}) {
  const { job, runtime } = params;
  try {
    await sendMessageDiscord(
      `channel:${job.payload.messageChannelId}`,
      DISCORD_MESSAGE_TIMEOUT_NOTICE,
      {
        cfg: job.payload.cfg,
        token: job.payload.token,
        accountId: job.payload.accountId,
        replyTo: job.payload.message.id,
        textLimit: job.payload.textLimit,
      },
    );
    logDiscordInboundJob(runtime, job, "timeout notice sent");
  } catch (noticeError) {
    runtime.error?.(
      danger(
        `discord message timeout notice failed: ${describeDiscordInboundJob(job)} error=${String(
          noticeError,
        )}`,
      ),
    );
  }
}

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  replayGuard: ClaimableDedupe;
  workerRunTimeoutMs?: number;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const timeoutMs = resolveDiscordWorkerRunTimeoutMs(params.workerRunTimeoutMs);
  const timeoutController = timeoutMs ? new AbortController() : undefined;
  const abortSignal = mergeAbortSignals([
    params.job.runtime.abortSignal,
    params.lifecycleSignal,
    timeoutController?.signal,
  ]);
  const runtime = (params.job.runtime.runtime as RuntimeEnv | undefined) ?? params.runtime;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const processPromise = processDiscordMessageImpl(
      materializeDiscordInboundJob(params.job, abortSignal),
      {
        onModelCallStart: () => logDiscordInboundJob(runtime, params.job, "model call start"),
        onModelCallEnd: ({ status }) =>
          logDiscordInboundJob(runtime, params.job, "model call end", ` status=${status}`),
        onFinalReplyStart: () => logDiscordInboundJob(runtime, params.job, "reply send start"),
        onFinalReplyDelivered: () => logDiscordInboundJob(runtime, params.job, "reply send end"),
      },
    );
    processPromise.catch((error) => {
      if (timedOut) {
        runtime.error?.(
          danger(
            `discord message run settled after timeout: ${describeDiscordInboundJob(params.job)} error=${String(error)}`,
          ),
        );
      }
    });
    if (timeoutMs) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new DiscordMessageRunTimeoutError(timeoutMs, params.job.queueKey);
          timedOut = true;
          timeoutController?.abort(error);
          logDiscordInboundJob(runtime, params.job, "timeout", ` timeoutMs=${timeoutMs}`);
          reject(error);
        }, timeoutMs);
        timeoutHandle.unref?.();
      });
      await Promise.race([processPromise, timeoutPromise]);
    } else {
      await processPromise;
    }
    await commitDiscordInboundReplay({
      replayKeys: params.job.replayKeys,
      replayGuard: params.replayGuard,
    });
  } catch (error) {
    if (error instanceof DiscordRetryableInboundError) {
      releaseDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        error,
        replayGuard: params.replayGuard,
      });
    } else {
      if (isDiscordMessageRunTimeoutError(error)) {
        await sendDiscordMessageTimeoutNotice({ runtime, job: params.job });
      }
      await commitDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        replayGuard: params.replayGuard,
      });
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error?.(danger(`discord message run failed: ${String(error)}`));
    },
  });

  return {
    enqueue(job) {
      const timeoutMs = resolveDiscordWorkerRunTimeoutMs(params.workerRunTimeoutMs);
      logDiscordInboundJob(
        params.runtime,
        job,
        "accepted",
        timeoutMs ? ` timeoutMs=${timeoutMs}` : " timeout=disabled",
      );
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        await processDiscordQueuedMessage({
          job,
          runtime: params.runtime,
          lifecycleSignal,
          replayGuard,
          workerRunTimeoutMs: params.workerRunTimeoutMs,
          testing: params.__testing,
        });
      });
    },
    deactivate: runQueue.deactivate,
  };
}
