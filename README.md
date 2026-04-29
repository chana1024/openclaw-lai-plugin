# OpenClaw Plugins

This repository is an OpenClaw plugin marketplace containing:

- `lai`: runtime slash command bridge for the local `lai` CLI.
- `newapi-codex`: provider plugin for routing Codex-style OpenClaw model calls to a local new-api `/v1/responses` endpoint.

## LAI

The plugin registers a runtime slash command:

```text
/lai <subcommand...>
```

It runs the local `lai` CLI directly from an authorized OpenClaw chat session.

## Requirements

- OpenClaw `2026.4.20` or newer.
- The `lai` binary installed on the Gateway host.
- `lai` available on `PATH` or at `~/.local/bin/lai`.

## Install

```bash
openclaw plugins install lai --marketplace https://github.com/chana1024/openclaw-lai-plugin --dangerously-force-unsafe-install
openclaw plugins enable lai
openclaw gateway restart
```

The install command needs `--dangerously-force-unsafe-install` because this
plugin intentionally launches the local `lai` executable. Only install it on a
Gateway host where you trust this repository and the local `lai` binary.

Then verify:

```bash
openclaw plugins inspect lai
```

## Use

Send a slash command from an authorized OpenClaw conversation:

```text
/lai codex usage --all
/lai codex accounts list
/lai codex accounts switch 2
/lai codex sync-auth 2
```

If OpenClaw replies that `lai` is not available, install `lai` on the Gateway
host or expose it in the Gateway process `PATH`, then restart the Gateway.

## New API Codex

Install:

```bash
openclaw plugins install newapi-codex --marketplace https://github.com/chana1024/openclaw-lai-plugin
openclaw plugins enable newapi-codex
```

Configure the plugin with your local new-api endpoint and API key:

```bash
openclaw config set plugins.entries.newapi-codex.config.baseUrl '"http://127.0.0.1:3000/v1"' --strict-json
openclaw config set plugins.entries.newapi-codex.config.apiKey '"<your-api-key>"' --strict-json
```

Add the provider model catalog and set the default model:

```bash
openclaw config set models.providers.newapi-codex '{
  "baseUrl": "http://127.0.0.1:3000/v1",
  "apiKey": "<your-api-key>",
  "auth": "api-key",
  "api": "openai-codex-responses",
  "models": [
    { "id": "gpt-5.5", "name": "gpt-5.5 (new-api Codex)", "api": "openai-codex-responses", "reasoning": true, "input": ["text", "image"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 400000, "maxTokens": 128000 },
    { "id": "gpt-5.4", "name": "gpt-5.4 (new-api Codex)", "api": "openai-codex-responses", "reasoning": true, "input": ["text", "image"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 400000, "maxTokens": 128000 },
    { "id": "gpt-5.4-mini", "name": "gpt-5.4-mini (new-api Codex)", "api": "openai-codex-responses", "reasoning": true, "input": ["text", "image"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 400000, "maxTokens": 128000 },
    { "id": "gpt-5.3-codex", "name": "gpt-5.3-codex (new-api Codex)", "api": "openai-codex-responses", "reasoning": true, "input": ["text", "image"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 400000, "maxTokens": 128000 }
  ]
}' --strict-json
openclaw config set agents.defaults.model '"newapi-codex/gpt-5.4"' --strict-json
openclaw gateway restart
```

Verify:

```bash
openclaw plugins inspect newapi-codex
openclaw agent --agent main --message '只回复 ok' --json
```

This plugin intentionally uses OpenClaw provider hooks to bypass the built-in `openai-codex-responses` account-token extraction path for custom new-api endpoints.
