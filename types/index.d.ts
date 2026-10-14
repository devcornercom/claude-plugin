export type Status = {
  repo: string;
  known: boolean;
  workspace: { slug: string; name: string } | null;
  project: { slug: string; name: string } | null;
  projects: number;
  session: StatusSession | null;
  waiting: number;
  next: { id: string; title: string } | null;
  suggestWorkspace: { slug: string } | null;
  /** The person's own workspace of that slug, to add the repo to. */
  joinWorkspace?: { slug: string; name: string } | null;
  /** The board's page. */
  page: string;
  /** The pages the row above the prompt links to. Absent from an older devcorner. */
  links?: StatusLinks;
  /** The overnight orchestrator's night for the repo, armed or paused (dc-t213). Absent from an older devcorner. */
  overnight?: StatusOvernight | null;
  /**
   * The repo's picture for the row's open block (dc-t218), when the plugin
   * asked for it (`expanded: true`); null otherwise. Absent from an older
   * devcorner.
   */
  expanded?: StatusExpanded | null;
};

/** A ticket the open block names, with its page. */
export type StatusItem = { id: string; title: string; page: string | null };

/** The repo's picture: what waits first, the work in flight, the cloud sessions, Next's first three and the code. */
export type StatusExpanded = {
  firstWaiting: StatusItem | null;
  /** Live sessions, runs waiting or picked up, open pull requests of its tickets, and the armed night. */
  inFlight: {
    count: number;
    sessions: number;
    runs: number;
    pulls: number;
    night: boolean;
  };
  /** The live cloud sessions (dc-t214): its routine, and how full ("3 of 5 runs"). */
  cloud: {
    id: string;
    page: string | null;
    routine: string;
    held: string;
    workers: number;
  }[];
  next: StatusItem[];
  /** "main at a1b2c3d · deployed 9f8e7d6 3 h ago · 2 commits on main not deployed yet" (dc-t215). */
  code: string | null;
};

/** The repo's night: its id, how it stands, what it did, and its page. */
export type StatusOvernight = {
  id: string;
  /** "Working (lands)". */
  state: string;
  /** "3 acts, 1 wait on you". */
  counts: string;
  page: string | null;
};

/**
 * The pages the row links to, each an absolute address on the devcorner that
 * answered, so the plugin builds none. A page that is not there is null, and
 * its part of the row stays plain text.
 */
export type StatusLinks = {
  /** The workspace's place, or Personal's when the repo is in no workspace. */
  place: string;
  /** The project's place, when the repo is in exactly one. */
  project: string | null;
  /** The page of the session the conversation works as. */
  session: string | null;
  /** The page of that session's ticket. */
  ticket: string | null;
  /** What waits on the person, the open block's "Active actions" too. */
  inbox: string;
  /** The open block's "In flight": the Work tab of the project's place, else the workspace's or Personal's. Its "Project home" is `project`, else `place`. Absent from an older devcorner. */
  work?: string;
};

/**
 * One message that wakes the session (devcorner's `StatusWake`): who it is
 * from and what it is, in ids, a branch and a login, never anyone's text.
 */
export type StatusWake = {
  /** The message, such as dc-m42. */
  id: string;
  /** Its own person's word, another member's, devcorner's GitHub App's notice, or a run it asked for. */
  from: "person" | "member" | "github" | "run" | (string & {});
  /** "message", "answer", "comment", a question's event, "github-comment", "conflict", or what a run ended as. */
  what: string;
  /** A run (dc-r3), a question, a ticket, or a pull request (owner/name#3); null when about none. */
  item: string | null;
  /** A conflict's base branch, or a GitHub comment's author by login; null otherwise. */
  detail: string | null;
};

/** The live session the conversation works as. */
export type StatusSession = {
  id: string;
  ticket: string | null;
  /** Its question waits on its person. These three are absent from an older devcorner. */
  waitingOnPerson?: boolean;
  /** Messages that wake it, such as its person's answer, not yet handed over. */
  wakeMessages?: number;
  /** The newest of them, such as dc-m42: the conversation wakes once for each. */
  wakeMessageId?: string | null;
  /**
   * What the newest of them are, oldest first (dc-t204), so a wake names what
   * came. Absent from an older devcorner.
   */
  wakes?: StatusWake[];
  /**
   * How many messages a prompt's hook would hand it now, of any kind (dc-t173).
   * The module writes it to the marker the hooks read. Absent from an older
   * devcorner.
   */
  pending?: number;
};

declare module "claude-code" {
  interface PluginState {
    devcorner: {
      /** The last good answer from devcorner; never holds the token. */
      status: Status | null;
      /** Repos whose nudge the person dismissed (mirrors $.store). */
      dismissed: string[];
      /** The turn running in the main conversation, or null while it is idle. */
      turn: string | null;
      /** The message the conversation last woke for, so it wakes once for each. */
      woke: string | null;
      /**
       * Until when (ms) devcorner, updating after a deploy, asked to be left
       * alone, which the row says; null when it answered as usual.
       */
      updating: number | null;
      /**
       * The row is open to the project's picture (dc-t218): devcorner's own
       * more and less, since Claude Code tells a plugin nothing of its [-].
       * Closed in a new session; a reload keeps it.
       */
      expanded: boolean;
    };
  }
}
