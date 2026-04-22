# OpenClaw LAI Plugin

This directory is an OpenClaw plugin marketplace containing the `lai` plugin.

The actual plugin package lives under `plugins/lai`.

## Install

```bash
openclaw plugins install lai --marketplace https://github.com/chana1024/openclaw-lai-plugin --dangerously-force-unsafe-install
```

Restart the Gateway after install.

For local development, you can install from the local marketplace root:

```bash
openclaw plugins install lai --marketplace /path/to/openclaw-lai-plugin --dangerously-force-unsafe-install
```

Or link the plugin package directly:

```bash
openclaw plugins install -l /path/to/openclaw-lai-plugin/plugins/lai --dangerously-force-unsafe-install
```

## Usage

Send `/lai` with no arguments to open the interactive menu:

- `Codex Usage --all`
- `Codex Switch`

Send `/lai <subcommand...>` to forward arguments directly to the local `lai` CLI.

Examples:

```text
/lai codex usage --all
/lai codex accounts list
/lai codex accounts switch <account-id>
/lai codex sync-auth <account-id>
```

## Requirements

- `lai` must be available on `PATH`, or installed at `~/.local/bin/lai`.
