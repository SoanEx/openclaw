---
name: discord-model-router
description: Route Discord sessions across nano, mini, and GPT for task difficulty using session model overrides.
allowed-tools: ["session_status"]
---

# Discord Model Router

Use this skill only for Discord channel conversations.

## Goal

Pick one of three OpenAI models for the Discord session based on task difficulty:

- `openai/gpt-5-nano` for tiny, low-risk replies.
- `openai/gpt-5-mini` for normal Discord help.
- `openai/gpt-5.5` for hard, risky, or multi-step work.

## Routing

Use `openai/gpt-5-nano` when the request is a greeting, ping, short status check,
simple yes/no question, tiny rewrite, or simple translation that does not need
tools, files, logs, configuration, or multi-step reasoning.

Use `openai/gpt-5-mini` when the request is ordinary Q&A, short explanation,
summarization, light planning, or a safe text transformation.

Use `openai/gpt-5.5` when the request involves code, debugging, OpenClaw
configuration, Discord operations, logs, credentials, security, ambiguous
instructions, multi-step diagnosis, tool use, file edits, Git, deployment, or
anything where a wrong answer would be costly.

When unsure, choose `openai/gpt-5.5`.

## Model Switching

If the desired model differs from the current session model, call
`session_status` with `sessionKey: "current"` and the desired `model`. This sets
a per-session model override for subsequent turns. If the current turn is
already running on a model strong enough for the task, continue normally after
setting the future override.

Do not use `model: "default"` unless the user explicitly asks to clear the model
override.

Do not invent or manually add a model label to the reply. OpenClaw's configured
reply prefix is responsible for showing the actual runtime model.

## Safety

Never print secrets, tokens, API keys, or credential file contents. For
credential work, give redacted status and actionable next steps.
