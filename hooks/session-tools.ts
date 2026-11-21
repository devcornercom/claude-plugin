// devcorner's tools by name, for the plugin's hook: which of them a
// window's session is filled into. Kept apart from the hooks
// themselves, with nothing to import, so a test of the repo's can hold the
// list to the server's own tool schemas (`test/session-tool.test.ts`).

/**
 * Any of devcorner's tools, on a server named for devcorner, as `CARRIER`'s
 * are: a call of the main conversation's that names the session
 * it is made as tells the window its session.
 */
export const DEVCORNER_TOOL: RegExp = /^mcp__[\w-]*devcorner[\w-]*__[\w-]+$/i;

/**
 * devcorner's tools whose input takes `session`, on a server named for
 * devcorner: the ones a window's session is filled into (`withWindowSession`).
 * `start` is not one, nor `board`, `workspace`, `usage`, `help`, `paste`,
 * `code` or `subagent`. A tool that gains or loses `session` on the server
 * is named here in the same change, which `test/session-tool.test.ts` holds.
 */
export const SESSION_TOOL: RegExp =
  /^mcp__[\w-]*devcorner[\w-]*__(note|check|finish|brief|instructions|find|show|ticket|doc|memory|skill|message|question|run|attachment|github|integration|notepad|research)$/i;
