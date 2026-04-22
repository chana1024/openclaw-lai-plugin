# @openclaw/lai

OpenClaw plugin that runs the local `lai` CLI directly as a runtime slash command.

## Install

```bash
openclaw plugins install lai --marketplace https://github.com/chana1024/openclaw-lai-plugin --dangerously-force-unsafe-install
```

Restart the Gateway after install.

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
