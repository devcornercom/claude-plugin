# devcorner for Claude Code

The Claude Code plugin for [devcorner](https://devcorner.devcorner.workers.dev). It connects Claude Code to devcorner, opens and closes a devcorner session with each conversation, registers each subagent as a child session, and puts new messages in front of the model while it works.

## Install

```sh
claude plugin marketplace add devcornercom/claude-plugin
claude plugin install devcorner@devcorner --scope user
```

Then, in Claude Code, run `/mcp`, choose devcorner and sign in.

## Signing the plugin in

The plugin's hooks run outside Claude Code's own sign-in, so they need a token of their own. From version 0.17.0 the plugin gets one by itself. Run `/dc login` in Claude Code: it shows a code and a link, you approve the code in your browser, and the plugin keeps the token it is given, with none to copy by hand. Or ask Claude to sign the plugin in. `/dc logout` signs it out.

The other way is a hook token from devcorner's connections page, [https://devcorner.devcorner.workers.dev/settings/connections](https://devcorner.devcorner.workers.dev/settings/connections). It wins over a sign-in. Set it in the shell that starts Claude Code:

```sh
export DEVCORNER_TOKEN=<your hook token>
```

or under `env` in `~/.claude/settings.json`, which the desktop app reads too. Without a token or a sign-in the hooks do nothing.

## The line above the prompt

devcorner's line above the prompt is a line of links, with nothing to press (from version 0.24.0): `devcorner · s7 reviewer · waiting 2`. The project's name opens its home, `s7` the session this conversation works as, and `waiting 2` the project's inbox. `/dc` says in the transcript what the line leaves out, and `/dc login` signs the machine in when the line says it is not.

## Another devcorner

The plugin connects to the hosted devcorner, https://devcorner.devcorner.workers.dev. For a devcorner of your own, set `DEVCORNER_URL` to its address in the same place:

```sh
export DEVCORNER_URL=https://devcorner.example.com
```

## Versions

A new version comes with a release of devcorner, tagged `plugin-vX.Y.Z`; [CHANGELOG.md](CHANGELOG.md) says what changed. `claude plugin marketplace update devcorner` picks it up.

## Licence

MIT: see [LICENSE](LICENSE).
