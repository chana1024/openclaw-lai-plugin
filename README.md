# OpenClaw LAI Plugin

This repository is an OpenClaw plugin marketplace containing the `lai` plugin.

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
