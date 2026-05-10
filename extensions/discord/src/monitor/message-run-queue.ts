import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { mergeAbortSignals } from "./timeouts.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  replayGuard?: ClaimableDedupe;
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

async function loadMessageProcessRuntime() {
  messageProcessRuntimePromise ??= import("./message-handler.process.js");
  return await messageProcessRuntimePromise;
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

function formatElapsedMs(startedAt: number): string {
  return ` durationMs=${Math.max(0, Date.now() - startedAt)}`;
}

function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function logDiscordInboundJob(
  runtime: RuntimeEnv,
  job: DiscordInboundJob,
  event: string,
  extra = "",
) {
  try {
    runtime.log?.(`discord message ${event}: ${describeDiscordInboundJob(job)}${extra}`);
  } catch {
    // Diagnostic logging must not affect message processing.
  }
}

async function commitDiscordInboundReplayWithDiagnostics(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  replayGuard: ClaimableDedupe;
  reason: string;
}) {
  logDiscordInboundJob(
    params.runtime,
    params.job,
    "replay commit start",
    ` reason=${params.reason}`,
  );
  await commitDiscordInboundReplay({
    replayKeys: params.job.replayKeys,
    replayGuard: params.replayGuard,
  });
  logDiscordInboundJob(params.runtime, params.job, "replay commit end", ` reason=${params.reason}`);
}

function releaseDiscordInboundReplayWithDiagnostics(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  replayGuard: ClaimableDedupe;
  error?: unknown;
  reason: string;
}) {
  logDiscordInboundJob(
    params.runtime,
    params.job,
    "replay release start",
    ` reason=${params.reason}`,
  );
  releaseDiscordInboundReplay({
    replayKeys: params.job.replayKeys,
    error: params.error,
    replayGuard: params.replayGuard,
  });
  logDiscordInboundJob(
    params.runtime,
    params.job,
    "replay release end",
    ` reason=${params.reason}`,
  );
}

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  replayGuard: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal = mergeAbortSignals([params.job.runtime.abortSignal, params.lifecycleSignal]);
  const runtime = (params.job.runtime.runtime as RuntimeEnv | undefined) ?? params.runtime;
  const processStartedAt = Date.now();
  logDiscordInboundJob(runtime, params.job, "processDiscordMessage start");
  try {
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal), {
      onModelCallStart: () => logDiscordInboundJob(runtime, params.job, "model call start"),
      onModelCallEnd: ({ status }) =>
        logDiscordInboundJob(runtime, params.job, "model call end", ` status=${status}`),
      onFinalReplyStart: () => logDiscordInboundJob(runtime, params.job, "final reply start"),
      onFinalReplyDelivered: () => logDiscordInboundJob(runtime, params.job, "final reply end"),
      onReplyPlanResolved: ({ createdThreadId, sessionKey }) =>
        logDiscordInboundJob(
          runtime,
          params.job,
          "reply plan resolved",
          `${sessionKey ? ` session=${sessionKey}` : ""}${createdThreadId ? ` thread=${createdThreadId}` : ""}`,
        ),
    });
    logDiscordInboundJob(
      runtime,
      params.job,
      "processDiscordMessage end",
      ` status=success${formatElapsedMs(processStartedAt)}`,
    );
    await commitDiscordInboundReplayWithDiagnostics({
      job: params.job,
      runtime,
      replayGuard: params.replayGuard,
      reason: "process-success",
    });
  } catch (error) {
    logDiscordInboundJob(
      runtime,
      params.job,
      "processDiscordMessage end",
      ` status=error${formatElapsedMs(processStartedAt)} error=${formatDiagnosticError(error)}`,
    );
    if (error instanceof DiscordRetryableInboundError) {
      releaseDiscordInboundReplayWithDiagnostics({
        job: params.job,
        runtime,
        error,
        replayGuard: params.replayGuard,
        reason: "retryable-error",
      });
    } else {
      await commitDiscordInboundReplayWithDiagnostics({
        job: params.job,
        runtime,
        replayGuard: params.replayGuard,
        reason: "nonretryable-error",
      });
    }
    throw error;
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
      logDiscordInboundJob(params.runtime, job, "accepted");
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        const queueStartedAt = Date.now();
        logDiscordInboundJob(params.runtime, job, "queue run start");
        try {
          await processDiscordQueuedMessage({
            job,
            runtime: params.runtime,
            lifecycleSignal,
            replayGuard,
            testing: params.__testing,
          });
        } finally {
          logDiscordInboundJob(
            params.runtime,
            job,
            "queue run finally",
            formatElapsedMs(queueStartedAt),
          );
        }
      });
    },
    deactivate: runQueue.deactivate,
  };
}
