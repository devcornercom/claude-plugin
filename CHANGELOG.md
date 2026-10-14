# Changelog

The devcorner plugin for Claude Code. A new version comes with a release of devcorner, tagged `plugin-vX.Y.Z`.

## 0.15.0 — 2026-10-14

- A wake says what came, by its sender and kind, on its toast and in its prompt: "GitHub — #210 conflicts with main", "run dc-r312 finished", "your answer to dc-q110". Only a message the person wrote says "your". It still holds no message's text.
- A wake goes only while the message is unread: when the held request hears of one, devcorner is asked again first, and a message a prompt's hook already handed over wakes nothing. No second wake goes before the first one's turn has begun.
- devcorner now wakes a coordinator when a run it asked for ends, and sends a run's pull request conflict to the live session on its ticket; with this version the wake names both.

## 0.14.0 — 2026-10-14

- With no `DEVCORNER_TOKEN`, as in a cloud session, the module writes the Claude account's capacity (the 5-hour and weekly percent, each with its reset time) to `capacity.json` in its state folder when a reading is due: ten minutes after the last, or when a window moved five points, crossed 80% or 95%, or began anew. The session's agent passes it to devcorner on a call it makes anyway. With a token nothing is written, and the capacity is posted as before.

## 0.13.0 — 2026-10-14

- The row above the prompt is closed by default to one short line, and opens to the project's picture by its own more and less button at the line's end: the project, what to open, this conversation's session and ticket, and the repo's live cloud sessions.
- The row above the prompt ends with the repo's overnight run while it is armed or paused, its id linking its page.
- The worker agent says a worker is told only of the sessions that overlap its work. (This was 0.11.1 and 0.12.0, which were never installed alone.)

## 0.11.0 — 2026-10-12

- The row above the prompt links to devcorner's pages: the workspace, the project, the session, its ticket and "N waiting on you", each to the page devcorner names for it. A part devcorner names no page for stays plain text.
- The marker the prompt hooks read has one writer, the module, so a message heard while a hook's ask was on its way is never taken as handed over. Each read of devcorner keeps its own answer, and the latest read wins.
- The manifest names its author.

## 0.10.0 — 2026-10-11

- The prompt hooks ask devcorner only when something waits, going by a marker the module keeps for the conversation, and at least every five minutes.
- While devcorner is updating after a deploy, the row above the prompt says "devcorner is updating, back in a moment", and the plugin asks again after the time devcorner named, with no failure counted. (This was 0.9.0, which was never installed alone.)

## 0.8.0 — 2026-10-09

- devcorner draws its own row above the prompt, in place of a status line with a warning sign in front.
- The held request asks devcorner to hold it 25 seconds.
- The worker agent reports the model and effort it runs with.

## 0.7.0 — 2026-10-09

- `/devcorner:cloud-agent` gives a new routine a fixed bootstrap prompt, and updates a routine still on the old one; a cloud run's steps come from devcorner.
- The module reports the account's capacity: the five-hour and seven-day windows' percentages and reset times, nothing else.
- The worker agent is handed only the run's id, and reads its task from devcorner.

## 0.6.0 — 2026-10-08

- An idle conversation wakes when its person writes to its session, such as an answer from the inbox, through a request devcorner holds open.
- `/devcorner:cloud-agent` handles a connector Claude Code hides because the plugin points at the same server.

## 0.5.0 — 2026-10-07

- A module beside the command hooks: a status line of where you are, a one-line offer to set up a repo devcorner does not know, and `/dc`.

## 0.4.0 — 2026-10-07

- `/devcorner:cloud-agent` sets up a Claude Code routine for cloud runs after one yes.

## 0.3.0 — 2026-10-05

- Sign-in from `/mcp`: the MCP connection sets no header of its own, and the hooks send the hook token in `DEVCORNER_TOKEN`, doing nothing without one.

## 0.2.0 — 2026-10-04

- Subagents are registered as child sessions and closed when they stop without finishing; new messages reach a session after a tool call, at a prompt and at a turn's end.

## 0.1.0 — 2026-10-04

- The MCP connection, a hook that records and briefs a conversation as it opens, and one that closes its session when Claude Code exits.
