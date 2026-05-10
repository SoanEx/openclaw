# Discord Windows Recovery Runbook

This note records the recovery flow used for a Windows OpenClaw Discord
non-response case. It is intentionally sanitized: do not add real tokens,
personal server names, raw logs, or full local state paths.

## Symptoms

- Discord gateway connects and channel probes pass.
- Direct Discord REST checks can work, but channel messages do not visibly
  receive OpenClaw replies.
- Runs may show `processing,q=1`, `event_loop_delay`, or model completion with
  no Discord delivery.
- Earlier experimental timeout patches can leave stale compiled Discord plugin
  output in `extensions/discord/dist` even after source files are reverted.

## Recovery Steps

1. Confirm the running gateway entrypoint and plugin runtime.
   - On Windows source runs, verify the Scheduled Task command points at
     `dist/index.js` in this checkout.
   - Check channel status with `openclaw channels status --deep --probe`.
2. Verify Discord config is channel-scoped.
   - Keep only the intended guild/channel allowlist entry.
   - Use `messages.groupChat.visibleReplies = "automatic"` when normal final
     replies should be posted without requiring the model to call the message
     tool.
   - To make visible replies show the actual runtime model, set
     `messages.responsePrefix = "[model: {modelFull}]"`. The `{modelFull}`
     template is resolved after model selection, including fallback selection.
3. Verify provider auth for both regular OpenAI and Codex runtime profiles.
   - `openclaw models status --json` should show usable auth for the selected
     provider/runtime.
4. Rebuild stale Discord plugin output if source and runtime behavior diverge.
   - Use the repo plugin runtime build script for `extensions/discord`.
   - Restart the gateway after rebuilding.
5. On Windows, make sure native hook relay bridge permission checks do not
   enforce POSIX mode bits. Windows ACLs do not map cleanly to POSIX `0o700`
   tests.
6. Add diagnostic-only Discord lifecycle logs before changing behavior:
   - replay claim start/end
   - preflight start/end
   - queue accepted/run start/finally
   - process start/end
   - model call start/end
   - final reply start/end
   - replay commit/release start/end
7. Use a separate Discord test bot for live proof.
   - Store the token outside git, for example in the user environment.
   - Set `channels.discord.allowBots = "mentions"` only when using a bot as the
     test sender, then mention the OpenClaw bot explicitly.
   - Run the roundtrip smoke with `node --use-system-ca` and a prompt such as
     `Reply exactly {nonce}`.

## Expected Healthy Evidence

- Discord status reports enabled, configured, running, connected, and probe OK.
- A roundtrip smoke receives an OpenClaw Discord reply containing the nonce.
- Gateway logs show:
  - `discord message preflight end ... status=accepted`
  - `discord message queue run start`
  - `discord message model call start`
  - `discord message final reply start`
  - `discord message final reply end`
  - `discord message replay commit end ... reason=process-success`
  - `discord message queue run finally`

## Model Selection Note

OpenClaw does not automatically choose a cheaper or stronger chat model based on
natural-language task difficulty. The selected model follows explicit
configuration and overrides: default model, session `/model` or CLI `--model`,
per-agent settings, and configured fallback after failures. An allowlist entry
only makes a model selectable; it does not make the runtime route simple tasks
to that model.

## Verification Performed

- `pnpm.cmd test extensions/discord/src/monitor/message-handler.queue.test.ts extensions/discord/src/monitor/provider.test.ts src/agents/harness/native-hook-relay.test.ts -- --reporter=verbose`
  passed.
- `pnpm.cmd check:changed` passed.
- `pnpm.cmd build` passed.
- `git diff HEAD --check` passed.
- Discord roundtrip smoke passed with nonce `OC_TEST_OK_044641`; OpenClaw replied
  in Discord after about 10.9 seconds.
- Model difficulty check used one short prompt and one harder diagnostic prompt;
  both sessions selected `openai/gpt-5.5` from the current default config.
- Visible reply model labels use `messages.responsePrefix = "[model:
{modelFull}]"` and should be verified with a live Discord roundtrip.
- After setting that prefix and restarting the gateway, Discord roundtrip smoke
  passed with nonce `OC_TEST_OK_050153`; the visible reply was `[model:
openai/gpt-5.5] OC_TEST_OK_050153`. The session transcript and trajectory for
  the same nonce recorded provider `openai` and model `gpt-5.5`.
- The roundtrip smoke now writes a local JSON transcript under `.artifacts` with
  the sent test text, matched OpenClaw reply text, nonce, message IDs, and
  timing. It does not write bot tokens or unrelated channel history.
