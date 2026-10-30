export type Status = {
  repo: string;
  known: boolean;
  workspace: { slug: string; name: string } | null;
  project: { slug: string; name: string } | null;
  projects: number;
  session: StatusSession | null;
  /**
   * The conversation, when it works as no live session (dc-t312): the mail
   * that waits for it, and what of it wakes it. Null with a session, whose
   * counts hold it, and absent from an older devcorner.
   */
  conversation?: StatusConversation | null;
  /**
   * This conversation (dc-t312, part 5), by its id and its name, with a
   * session or none: the row labels its session with the name, and /dc
   * opens with it. Absent from an older devcorner.
   */
  thisConversation?: { id: string; name: string | null } | null;
  /**
   * This conversation's chain of relays on the person's word, paused with
   * another conversation after that many wakes (dc-t312) until the person
   * types in either; null when not paused. Absent from an older devcorner.
   */
  paused?: { with: string; wakes: number } | null;
  /**
   * The newest paste a session of this conversation wrote, still kept
   * (dc-t490), which /dc names to copy; null when none is. Absent from an
   * older devcorner.
   */
  paste?: StatusPaste | null;
  /**
   * What waits on the person in the place the repo is in (its project, else
   * its workspace, else Personal), as that place's inbox lists it
   * (`links.inbox`); an older devcorner counts every place's.
   */
  waiting: number;
  /**
   * What waits on them in their other places (dc-t518): /dc's "(+N
   * elsewhere)". Absent from an older devcorner, which counts it in
   * `waiting`.
   */
  waitingElsewhere?: number;
  /**
   * The repo's work moving now, on every read (dc-t508): /dc's In flight.
   * Absent from an older devcorner, which says it only in `expanded`.
   */
  inFlight?: StatusInFlight;
  next: { id: string; title: string } | null;
  suggestWorkspace: { slug: string } | null;
  /** The person's own workspace of that slug, to add the repo to. */
  joinWorkspace?: { slug: string; name: string } | null;
  /** The board's page. */
  page: string;
  /** The pages the row above the prompt and /dc link to. Absent from an older devcorner. */
  links?: StatusLinks;
  /** The repo's Orchestrator Agent (OA), armed or paused (dc-t213); the field keeps its first name. Absent from an older devcorner. */
  overnight?: StatusOvernight | null;
  /**
   * The repo's picture for /dc and /dc waits (dc-t218), when the plugin
   * asked for it (`expanded: true`); null otherwise. Absent from an older
   * devcorner.
   */
  expanded?: StatusExpanded | null;
  /**
   * What the session the conversation works as is on and did lately
   * (dc-t489), when the plugin asked for it (`now: true`); null otherwise,
   * and with no session. Absent from an older devcorner.
   */
  now?: StatusNow | null;
  /**
   * The person's other live sessions, in every project and store (dc-t491),
   * when the plugin asked for them (`others: true`) or for the picture: those
   * that wait on them first, then the last alive first; `count` of them all,
   * `items` the first few. Null otherwise, and absent from an older devcorner.
   */
  others?: { count: number; items: StatusOther[] } | null;
  /**
   * What devcorner could not read of the registry for this answer (dc-t137),
   * each a sentence: with any, `waiting` counts only what it read. Absent
   * from an older devcorner.
   */
  couldNotRead?: string[];
  /**
   * The branch this Status said git is on (dc-t334), once devcorner took it;
   * null when it said none or devcorner could not take it now, and absent
   * from an older devcorner: either way the next Status says it again.
   */
  branch?: string | null;
  /**
   * What devcorner made of the session this Status stated the window runs
   * as (dc-t588); null when it stated none, and absent from an older
   * devcorner, which reads no claim.
   */
  claim?: StatusClaim | null;
};

/**
 * devcorner's word on the session a window stated it runs as (dc-t588):
 * `kept` when it works as it already, `repaired` when it does now, `refused`
 * with why.
 */
export type StatusClaim = {
  /** The session stated, as it was sent. */
  session: string;
  outcome: "kept" | "repaired" | "refused";
  /** What the window worked as before a repair; null for none, and otherwise. */
  was: string | null;
  why: string | null;
  /** It can never be taken (finished, a child's or another's, its connection moved on): the plugin forgets it. */
  final: boolean;
};

/** A ticket the picture names, with its page. */
export type StatusItem = { id: string; title: string; page: string | null };

/**
 * A paste of this conversation's sessions (dc-t490), as Status names it: its
 * head, never its text, which the plugin reads only to copy it (the hook
 * route's Paste).
 */
export type StatusPaste = {
  /** Such as me-p14. */
  id: string;
  title: string;
  /** Its text's length, in characters. */
  length: number;
  createdAt: number;
  expiresAt: number;
  /** How many pastes this conversation's sessions wrote are kept, this one among them. */
  count: number;
  /** Its page, whose Copy button is the way to copy where a terminal takes no copy. */
  page: string | null;
};

/** The repo's work moving now: live sessions, runs waiting or picked up, open pull requests of its tickets, and an armed OA; `count` adds them up. */
export type StatusInFlight = {
  count: number;
  sessions: number;
  runs: number;
  pulls: number;
  night: boolean;
};

/**
 * A topic that waits on the person (dc-t492), as Status lists it: a piece of
 * work by devcorner's one rule (a task's things under its initiative, a
 * ticket of none on its own, a session left unfinished or a run on no ticket
 * each its own, the setup one), with what it asks and its newest things.
 */
export type StatusWait = {
  /** A Work's or a ticket's id, a session's, a run's, or "setup". */
  id: string;
  /** Its title, else its newest line's words. */
  title: string;
  /** What it asks, in devcorner's words: "Decide 4 · Yours 1". */
  asks: string;
  /** How many things it asks. */
  count: number;
  /** When its newest ask began to wait (ms): the order, the newest first. */
  at: number;
  /** Its repo; null for none and for the setup. */
  repo: string | null;
  /** Its page, the inbox for the setup. */
  page: string | null;
  /** Its newest things, the newest first: each its id, its words ("Landed?", "Yours") and its page. */
  items: StatusItem[];
};

/** The repo's picture: what waits, the work in flight, the cloud sessions, Next's first three and the code. */
export type StatusExpanded = {
  /** The newest topic that waits, the repo's own first: /dc's first line from a devcorner that lists no waits. */
  firstWaiting: StatusItem | null;
  /**
   * What waits on the person by work stream (dc-t492), in any repo, the
   * newest first, the first few; `Status.waiting` counts them all. Absent
   * from an older devcorner.
   */
  waits?: StatusWait[];
  /**
   * How many things wait on the person over every stream, listed or not
   * (dc-t492): /dc counts those in the streams it does not name. Absent from an older devcorner.
   */
  waitingThings?: number;
  /** The work in flight, as `Status.inFlight` says it; the only place an older devcorner says it. */
  inFlight: StatusInFlight;
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

/** One of the person's other live sessions, as devcorner names it (dc-t491). */
export type StatusOther = {
  /** Such as acme-s4. */
  id: string;
  /** Its page; null where none opens. */
  page: string | null;
  /** The conversation it works in, such as me-h3, and that conversation's name. */
  conversation: string;
  name: string | null;
  repo: string | null;
  /** The ticket it works on, with its page; null on none. */
  ticket: { id: string; title: string; page: string | null } | null;
  /** How it stands, in devcorner's words: "waits on you", "idle 2 h", "working". */
  state: string;
};

/**
 * What the conversation's session is on and did lately (dc-t489), in
 * devcorner's words (`sessionNow`, the rule `show(<session>:now)` writes
 * too), each item with its page.
 */
export type StatusNow = {
  id: string;
  /** The session's page. */
  page: string | null;
  /** "live 3 h", "live 3 h, waiting on a person". */
  state: string;
  /** The ticket it is on; null on none. */
  ticket: StatusItem | null;
  /** Its latest note, which wins over its goal; its goal while it noted nothing. `when`: "12 min ago". */
  doing: { text: string; from: "note" | "goal"; when: string };
  /** Its last moves before that note, newest first: "commit 1a2b3c4: Fix the row". */
  lately: { when: string; text: string }[];
  /** The questions it asked that are open: how many, and the first few, each by its header or its text. */
  asked: { count: number; items: StatusItem[] };
  /** Its runs out: how many, and the first few, each its ticket and goal, and its state. */
  runs: { count: number; items: (StatusItem & { state: string })[] };
};

/** The repo's OA: its id, how it stands, what it did, and its page. */
export type StatusOvernight = {
  id: string;
  /** "Working (lands)". */
  state: string;
  /** "3 acts, 1 wait on you". */
  counts: string;
  /** "waits for room until 01:00 18 Oct (UTC)" while a run of its waits for room on its accounts; null otherwise, and absent from an older devcorner. */
  room?: string | null;
  /** Its tasks in one short piece (dc-t248): "2/7 landed". Absent from an older devcorner. */
  tasks?: string;
  /** Its questions that wait on the person. Absent from an older devcorner. */
  waits?: number;
  /** What of it waits on its coordinator that no live session hears (dc-t536): "nobody hears its local e2e run dc-r3"; null when every one is heard, and absent from an older devcorner. */
  unheard?: string | null;
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
  /** What waits on the person: the row's "waiting N", and /dc's "Active actions". */
  inbox: string;
  /** /dc's "In flight": the Work tab of the project's place, else the workspace's or Personal's. The row's "devcorner" and /dc's "Project home" are `project`, else `place`. Absent from an older devcorner. */
  work?: string;
};

/**
 * One message that wakes the session (devcorner's `StatusWake`): who it is
 * from and what it is, in ids, a branch and a login, never anyone's text.
 */
export type StatusWake = {
  /** The message, such as acme-m42 or me-m42. */
  id: string;
  /** Its own person's word, another member's, devcorner's GitHub App's notice, a run it asked for or an OA it gave sent or one dispatched to it, another of its person's sessions on their word ("relay", dc-t312, `item` the conversation it was sent from), another of its person's sessions replying to what woke it ("reply", dc-t585, `item` the conversation it was sent from), or an OA it gave with news it must act on ("oa": asking its person, dc-t576, `item` the question; its mind's stop, its end or a checkpoint, dc-t536, `item` the OA). */
  from:
    | "person"
    | "member"
    | "github"
    | "run"
    | "relay"
    | "reply"
    | "oa"
    | (string & {});
  /** "message", "answer", "comment", a question's event, "github-comment", "conflict", what a run ended as, "held" for an OA's run that waits for room, "dispatch" for a run dispatched to it, or from an OA "asked", "mind-stopped", "ended" or "checkpoint". */
  what: string;
  /** A run (dc-r3), a question, a ticket, or a pull request (owner/name#3); null when about none. */
  item: string | null;
  /** A conflict's base branch, or a GitHub comment's author by login; null otherwise. */
  detail: string | null;
  /** When it was sent (ms). Absent from an older devcorner. */
  at?: number;
  /** A relay's or a reply's place in its chain of wakes (dc-t312, dc-t585); 0 for any other. Absent from an older devcorner. */
  hops?: number;
};

/**
 * A conversation that works as no session (dc-t312), as `Status` gives it:
 * its person's word to it wakes it as a session's wake does, and its next
 * prompt's hook hands it all its mail.
 */
export type StatusConversation = {
  /** Such as me-h3. */
  id: string;
  /** Its person's messages to it, not yet handed over. */
  wakeMessages?: number;
  /** The newest of them: the conversation wakes once for each. */
  wakeMessageId?: string | null;
  /** What the newest of them are, oldest first. */
  wakes?: StatusWake[];
  /** How many messages its next prompt's hook would hand it. */
  pending?: number;
};

/** The live session the conversation works as. */
export type StatusSession = {
  id: string;
  ticket: string | null;
  /** Its question waits on its person. These three are absent from an older devcorner. */
  waitingOnPerson?: boolean;
  /** Messages that wake it, such as its person's answer, not yet handed over. */
  wakeMessages?: number;
  /** The newest of them, such as me-m42: the conversation wakes once for each. */
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
       * The newest message woken for in each store (dc-t312), one id a store
       * (me-m9 the person's own, acme-m9 a workspace's), sent with the
       * held request so each store it holds on reads its own cursor.
       */
      cursors: string[];
      /**
       * Until when (ms) devcorner, updating after a deploy, asked to be left
       * alone, which the row says; null when it answered as usual.
       */
      updating: number | null;
      /**
       * Where signing this machine in stands (dc-t224), which the row draws
       * in place of devcorner's line: signed out, asking for a code, or the
       * code to enter. Null while the machine has a token. Never the token,
       * and never the secret a sign-in polls with.
       */
      signIn: SignIn | null;
    };
  }
}

/** Where signing this machine in stands (dc-t224). */
export type SignIn =
  | {
      step: "out";
      why?: "denied" | "expired" | "revoked" | "failed";
      /** What went wrong, for a failure. */
      detail?: string;
    }
  | { step: "asking" }
  | {
      step: "code";
      /** "KQ4F-9XZT". */
      code: string;
      /** The page to open. */
      page: string;
      /** The same with the code filled in, which the row links. */
      link: string;
      expiresAt: number;
    };
