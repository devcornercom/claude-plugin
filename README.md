# devcorner for Claude Code

The Claude Code plugin for [devcorner](https://devcorner.devcorner.workers.dev). It connects Claude Code to devcorner, opens and closes a devcorner session with each conversation, registers each subagent as a child session, and puts new messages in front of the model while it works.

## Install

```sh
claude plugin marketplace add devcornercom/claude-plugin
claude plugin install devcorner@devcorner --scope user
```

Then, in Claude Code, run `/mcp`, choose devcorner and sign in.

## The hook token

The plugin's hooks run outside Claude Code's own sign-in, so they need a token of their own: a hook token from devcorner's connections page, [https://devcorner.devcorner.workers.dev/settings/connections](https://devcorner.devcorner.workers.dev/settings/connections). Set it in the shell that starts Claude Code:

```sh
export DEVCORNER_TOKEN=<your hook token>
```

or under `env` in `~/.claude/settings.json`, which the desktop app reads too. Without it the hooks do nothing.

## In VS Code's terminal

devcorner's line above the prompt opens with its more button, and closes with less. VS Code's integrated terminal may pass the line no click, and it keeps ctrl+x for itself. There, `/dc more` and `/dc less` open and close the line (from version 0.16.0). To have ctrl+x reach Claude Code instead, set `"terminal.integrated.sendKeybindingsToShell": true` in VS Code's settings.

## Another devcorner

The plugin connects to the hosted devcorner, https://devcorner.devcorner.workers.dev. For a devcorner of your own, set `DEVCORNER_URL` to its address in the same place:

```sh
export DEVCORNER_URL=https://devcorner.example.com
```

## Versions

A new version comes with a release of devcorner, tagged `plugin-vX.Y.Z`; [CHANGELOG.md](CHANGELOG.md) says what changed. `claude plugin marketplace update devcorner` picks it up.

## Licence

MIT: see [LICENSE](LICENSE).
