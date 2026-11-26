import { atom, read, update } from "claude-code";
import type {
  Register,
  CommandInfo,
  CommandRunResult,
  EngineInterface as Engine,
  PromptMedia,
  PromptSubmitAttachment,
  Timer,
  TurnStepChunk,
} from "claude-code";

import type {
  LaptopLine,
  SignIn,
  Status,
  StatusConversation,
  StatusInFlight,
  StatusLight,
  StatusOvernight,
  StatusPaste,
  StatusOther,
  StatusSession,
  StatusWindow,
  StatusWait,
  StatusWake,
} from "../types";
import { DEVCORNER_TOOL, SESSION_TOOL } from "./session-tools";
import {
  PAGE_FILE_SCRIPT,
  PAGE_FILE_SECONDS,
  pageFileProblem,
} from "./page-file";

const status = atom({ plugin: "devcorner", key: "status" } as const, null);
const dismissed = atom({ plugin: "devcorner", key: "dismissed" } as const, []);
const turn = atom({ plugin: "devcorner", key: "turn" } as const, null);
const woke = atom({ plugin: "devcorner", key: "woke" } as const, null);
const cursors = atom({ plugin: "devcorner", key: "cursors" } as const, []);
const updating = atom({ plugin: "devcorner", key: "updating" } as const, null);
const signIn = atom({ plugin: "devcorner", key: "signIn" } as const, null);
const laptop = atom({ plugin: "devcorner", key: "laptop" } as const, null);
const generation = atom(
  { plugin: "devcorner", key: "generation" } as const,
  null,
);
const windowKey = atom(
  { plugin: "devcorner", key: "windowKey" } as const,
  null,
);
const rejoining = atom(
  { plugin: "devcorner", key: "rejoining" } as const,
  null,
);

/** A key no other window or copy of the plugin has: a UUID where the runtime gives one. */
function randomKey(): string {
  const made = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  return (
    made?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * This copy of the plugin: a new one each time the plugin loads in a window,
 * a reload's too. A window chat is bound to the copy that opened or rejoined
 * it, and devcorner counts no other copy's post or held request for it, so
 * a copy a reload left running never keeps the chat online.
 */
const GENERATION = randomKey();

const EVERY_MS = 30_000;
const DEFAULT_URL = "https://devcorner.devcorner.workers.dev";

/**
 * This plugin's version, its manifest's (test/plugin-version.test.ts holds
 * the two the same): each Status says it until devcorner says it back,
 * so devcorner shows which windows run a plugin behind the one
 * on disk, and a reload's new copy confirms the version it loaded.
 */
export const PLUGIN_VERSION = "0.91.0";

/** How often an idle conversation asks devcorner while its session waits on its person. */
export const WAITING_MS = 15_000;
/** And while it waits on nobody: its person may still write to it. */
export const IDLE_MS = 60_000;
/** After a failed ask: a minute, as the hook script waits, doubling up to ten. */
export const DOWN_MS = 60_000;
export const MAX_DOWN_MS = 10 * 60_000;
/** After a held request fails, the poll has the conversation to itself this long. */
export const WAIT_RETRY_MS = 5 * 60_000;
/**
 * How long the held request asks devcorner to hold it. Claude Code's
 * $.http.fetch gives up on an answer not complete within 30 s (measured:
 * aborted at 30,002 ms on 2.1.330), so the hold stays under it with 5 s to
 * spare. devcorner's own longer limit (`WAIT_MS`, 50 s) is one no plugin's
 * fetch can wait out: a longer hold would be cut by the client every time.
 */
export const HOLD_MS = 25_000;
/** A held request answered sooner than this is "quick": the server is not holding it. */
export const QUICK_MS = 2_000;
/** This many quick answers in a row, and the poll takes over. */
export const QUICK_MAX = 3;

/**
 * After a wake is submitted, the conversation waits this long for the turn it
 * starts before it may wake again (dc-t204): that turn's prompt hook hands
 * over every message waiting then, so a second wake before it would find
 * nothing. A turn's start ends the wait at once.
 */
export const WAKE_SETTLE_MS = 2 * 60_000;

/** What a run ended as, or that it waits for room, in the words a wake says it: "run dc-r3 finished". */
const RUN_NEWS: Record<string, string> = {
  done: "finished",
  partial: "finished as partial",
  abandoned: "finished as abandoned",
  expired: "expired",
  lost: "ended without finishing",
  cancelled: "was cancelled",
  // Not an end: an OA's run that waits for room on its accounts (dc-t254).
  held: "waits for room",
  // Not an end: a run dispatched to the session, the person's own request
  // (dc-t576).
  dispatch: "was dispatched here",
};

/**
 * A devcorner id in any form devcorner gives one: in a key (ra-r3, me-t5,
 * ra-t5-q2, ra-t5@rangojs), or as an older devcorner wrote it (dc-r3,
 * dc-q3@acme).
 */
const ID =
  /^[a-z][a-z0-9]{0,9}-[a-z]\d{1,9}(?:-[a-z]\d{1,9})?(?:@[a-z0-9-]{1,40})?$/;

/** A conversation's id, in a key (me-h3) or as an older devcorner wrote it (dc-h3). */
const CONVERSATION = /^(?:me|dc)-h\d{1,12}$/;

/** A message's id, in any form (`ID`): me-m9, ra-m9, dc-m9@acme. */
const MESSAGE = /^[a-z][a-z0-9]{0,9}-m\d{1,12}(?:@[a-z0-9-]{1,40})?$/i;

/**
 * A paste's id: always the person's own store's, in its key (me-p4) or as an
 * older devcorner wrote it (dc-p4).
 */
const PASTE_ID = /^(?:me|dc)-p\d{1,12}$/i;

/**
 * What a wake names an item by: a pull request as #210, a devcorner id as it
 * is (ra-r3, ra-t3-q2, me-t5). Null for anything of another shape, so nothing but
 * an id or a number reaches a wake's words.
 */
function itemName(item: string | null): string | null {
  if (item === null) return null;
  const pull = /^[\w.-]{1,100}\/[\w.-]{1,100}#(\d{1,9})$/.exec(item);
  if (pull) return `#${pull[1]}`;
  return ID.test(item) ? item : null;
}

/** A plain branch name, as devcorner gives one (`refName`), else null. */
const branchName = (name: string | null) =>
  name !== null && /^[\w.][\w./-]{0,199}$/.test(name) ? name : null;

/** A GitHub login, as GitHub allows one, else null. */
const loginName = (name: string | null) =>
  name !== null && /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(name)
    ? name
    : null;

/**
 * What one message that wakes the session is, in a few words (dc-t204):
 * "GitHub — #210 conflicts with main", "run dc-r312 finished", "your answer
 * to dc-q110". Built from devcorner's `wakes` alone, its kinds and ids, never
 * from a message's text, so the words may stand in the wake's prompt. Only a
 * message the person wrote says "your": to them on the toast, and "your
 * user's" to the agent in the prompt. Null for what this version cannot name.
 */
export function wakeWords(
  w: StatusWake,
  reader: "person" | "agent",
): string | null {
  const item = itemName(w.item);
  const your = reader === "person" ? "your" : "your user's";
  const you = reader === "person" ? "you" : "your user";
  if (w.from === "run") {
    const news = RUN_NEWS[w.what];
    return item && news ? `run ${item} ${news}` : null;
  }
  if (w.from === "github") {
    if (w.what !== "conflict" || !item) return null;
    return `GitHub — ${item} conflicts with ${branchName(w.detail) ?? "its base branch"}`;
  }
  // Another of the person's sessions on their word (dc-t312), named by the
  // conversation it was sent from.
  if (w.from === "relay") {
    const from = item && CONVERSATION.test(item) ? item : null;
    if (reader === "person") {
      return `${from ?? "another conversation"} sent this on your word`;
    }
    return `a message ${from ? `${from} sent` : "sent"} on your user's word`;
  }
  // Another of the person's sessions answering what woke it (dc-t585): on
  // nobody's word, so it never says "your". An answer to the person's own
  // ask (dc-t611) says whose ask it answers.
  if (w.from === "reply") {
    const from = item && CONVERSATION.test(item) ? item : null;
    return w.what === "answer"
      ? `${from ?? "another conversation"} answered ${your} ask`
      : `${from ?? "another conversation"} replied`;
  }
  // Another of the person's sessions on its own, not on their word: named
  // by the conversation it was sent from, as a reply is.
  if (w.from === "agent") {
    const from = item && CONVERSATION.test(item) ? item : null;
    return reader === "person"
      ? `${from ?? "another conversation"} sent this`
      : `a message ${from ? `${from} sent` : "sent"} on its own, not on ${your} word`;
  }
  // A project chat of the person's, its coordinator on its own: named by
  // the chat's conversation, never on the person's word.
  if (w.from === "chat") {
    const from = item && CONVERSATION.test(item) ? item : null;
    return reader === "person"
      ? `${from ?? "a project chat"} (chat) sent this`
      : `a message ${from ? `${from}, a project chat,` : "a project chat"} sent on its own, not on ${your} word`;
  }
  // An OA the session gave, with news it must act on: asking its person a
  // question (dc-t576), named by the question; its mind's stop, its end or a
  // checkpoint that waits on the person's go (dc-t536), named by the OA.
  if (w.from === "oa") {
    if (!item) return null;
    switch (w.what) {
      case "asked":
        return `an OA asks ${you} ${item}`;
      case "mind-stopped":
        return `${item}'s mind stopped`;
      case "ended":
        return `${item} ended`;
      case "checkpoint":
        return `${item} waits on ${your} go`;
      default:
        return null;
    }
  }
  if (w.from !== "person" && w.from !== "member") return null;
  const own = w.from === "person";
  if (w.what === "github-comment") {
    if (!item) return null;
    if (own) return `GitHub — ${your} comment on ${item}`;
    const login = loginName(w.detail);
    return `GitHub — ${login ? `@${login}` : "a comment"} on ${item}`;
  }
  if (own && w.what === "message") return `${your} message`;
  if (own && w.what === "answer") return `${your} answer`;
  if (!item) return null;
  switch (w.what) {
    case "comment":
      return own ? `${your} comment on ${item}` : null;
    case "decided":
      return `${own ? your : "an"} answer to ${item}`;
    case "changed":
      return `${own ? your : "a"} changed answer to ${item}`;
    case "reopened":
      return own ? `${you} reopened ${item}` : `${item} reopened`;
    case "post":
      return `${own ? your : "a"} post on ${item}`;
    default:
      return null;
  }
}

/**
 * What a wake is for: the live session the conversation works as, or the
 * conversation itself when it works as none (dc-t312), whose own mail wakes
 * it as a session's does.
 */
type Woken = StatusSession | StatusConversation;

/**
 * What a read says of the session a conversation works as: a full Status, or
 * the light one a read on a timer takes.
 */
type WokenStatus = {
  session: StatusSession | null;
  conversation?: StatusConversation | null;
};

/** What a wake goes by: the session, else the conversation with no session; null with neither. */
export function wokenOf(s: WokenStatus): Woken | null {
  return s.session ?? s.conversation ?? null;
}

/** Whether a wake is for a conversation with no session (dc-h3), not a session. */
const isConversation = (w: Woken) => CONVERSATION.test(w.id);

/** How many stores' cursors are kept: the person's own, and the workspaces' a session may be kept in. */
const CURSORS_KEPT = 8;

/**
 * The held request's cursors with `id` woken for (dc-t312): the newest id of
 * each store, by the label it is written with (dc-m9@acme is acme's, dc-m9
 * the person's own), since each store numbers its own messages and the held
 * request holds on two. Only message ids are kept.
 */
export function withCursor(kept: readonly string[], id: string): string[] {
  if (!MESSAGE.test(id)) return [...kept];
  // The store an id is of: what is left of it without its number, its key
  // and any @slug (me, ra, ra@rangojs; dc and dc@acme as an older devcorner
  // wrote them).
  const store = (c: string) => c.toLowerCase().replace(/-m\d+/, "");
  const others = kept.filter((c) => !MESSAGE.test(c) || store(c) !== store(id));
  return [...others, id].slice(-CURSORS_KEPT);
}

/** How many messages wake the session: at least the one a wake is for. */
const wakeCount = (session: Woken) => Math.max(1, session.wakeMessages ?? 1);

/**
 * What came, for a wake (dc-t204): "GitHub — #210 conflicts with main", or
 * "run dc-r3 finished; your answer to dc-q4; and 1 more" for several. Null
 * from an older devcorner, or when this version can name none of them.
 */
export function wakeLine(
  session: Woken,
  reader: "person" | "agent",
): string | null {
  const words = (session.wakes ?? [])
    .map((w) => wakeWords(w, reader))
    .filter((w) => w !== null);
  if (words.length === 0) return null;
  const more = wakeCount(session) - words.length;
  return `${words.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** The toast a wake shows its person: "dc: run dc-r3 finished", "dc: 2 messages: …". */
export function wakeToast(session: Woken): string {
  const count = wakeCount(session);
  const line = wakeLine(session, "person");
  const many = `${count} messages`;
  if (line === null) {
    return `dc: ${count === 1 ? "a message" : many} woke ${session.id}`;
  }
  return `dc: ${count === 1 ? line : `${many}: ${line}`}`;
}

/**
 * The prompt a wake submits, naming what came (`wakeLine`). It never holds a
 * message's text: the hook on this prompt hands the messages over, fenced as
 * someone else's text, so no text from devcorner becomes a turn of its own.
 */
export function wakePrompt(session: Woken): string {
  const count = wakeCount(session);
  const line = wakeLine(session, "agent");
  const what = line === null ? "" : `: ${line}`;
  // A conversation with no session is handed its mail by this prompt's hook,
  // and starts a session before it replies (dc-t312).
  const alone = isConversation(session);
  const idle = alone
    ? "this conversation, which works as no devcorner session,"
    : "this session";
  const missing = alone ? "call start, then check" : "call check";
  return count === 1
    ? `While ${idle} was idle, a devcorner message woke it${what}. It comes with this prompt as a devcorner message: read it and carry on from it, and if it ends with "…", read it whole with show(its id) first. If it is not there, ${missing}.`
    : `While ${idle} was idle, ${count} devcorner messages woke it${what}. They come with this prompt as devcorner messages: read them and carry on from them, and if one ends with "…", read it whole with show(its id) first. If they are not there, ${missing}.`;
}

/**
 * The toast for mail the conversation is told of without a turn (dc-t312):
 * the held request's `notice`, which carries the message's id alone. The
 * next prompt's hook hands it over.
 */
export function noticeToast(id: string): string {
  const named = MESSAGE.test(id) ? ` (${id})` : "";
  return `dc: a message waits for this conversation${named}; your next prompt hands it over`;
}

/**
 * A line of a hand-over of messages, as devcorner writes one for the hook
 * script (`formatDelivery` in src/hub/format.ts), that names the messages or
 * the work the person sent. A hand-over opens with one; two the script joins
 * (what an ask in the background kept, and the hook's own) have one each.
 */
const HAND_OVER =
  /^devcorner: (?:\d+ new messages? for |your user sent work to )/;

/** How many messages a hand-over's line names. */
const HANDED_COUNT = /^devcorner: (\d+) new messages? for /;

/** A fence's head, on a line of its own, its attributes between. */
const FENCE_HEAD = /^<devcorner-message (.*)>$/;

/** How many characters of the first message's words a hand-over's toast shows. */
export const HANDED_WORDS = 60;

/** Whether a hook's text is devcorner's hand-over of messages. */
export function isHandOver(text: string): boolean {
  return HAND_OVER.test(text);
}

/** Attribute `name` of a fence's head, or "" when it has none. */
const fenceAttr = (head: string, name: string) =>
  new RegExp(` ${name}="([^"]*)"`).exec(` ${head}`)?.[1] ?? "";

/**
 * What a hand-over says: its lines that name the messages and the work sent,
 * and each fence's kind, sender and first line of words. Only lines outside
 * the fences are read as devcorner's own: devcorner escapes a fence's tags in
 * a message's words, so none can open or close one, but a message may hold a
 * line that reads like a hand-over's.
 */
function handOverParts(text: string): {
  heads: string[];
  fences: { kind: string; from: string; first: string }[];
} {
  const heads: string[] = [];
  const fences: { kind: string; from: string; first: string }[] = [];
  let open: { kind: string; from: string; first: string | null } | null = null;
  for (const line of text.split("\n")) {
    if (open !== null) {
      if (line === "</devcorner-message>") {
        fences.push({ ...open, first: open.first ?? "" });
        open = null;
      } else if (open.first === null) {
        open.first = line;
      }
      continue;
    }
    const head = FENCE_HEAD.exec(line)?.[1];
    if (head !== undefined) {
      open = {
        kind: fenceAttr(head, "kind"),
        from: fenceAttr(head, "from"),
        first: null,
      };
    } else if (HAND_OVER.test(line)) {
      heads.push(line);
    }
  }
  return { heads, fences };
}

/**
 * The toast for a hand-over of messages: how many, from whom and the first
 * words of the first, on one line, as `dc: question from dc-s3: eu or us?` or
 * `dc: 3 messages from dc-s3, your user +1: Rebase on main first.` The person
 * sees this and never the text, which goes to the model whole. A sender is
 * named up to its first comma (`dc-s3, your child session` is dc-s3).
 */
export function handOverToast(text: string): string {
  const { heads, fences } = handOverParts(text);
  // A dispatch's line gives no count: its fence counts it.
  const count =
    heads.reduce(
      (n, line) => n + Number(HANDED_COUNT.exec(line)?.[1] ?? 0),
      0,
    ) + fences.filter((f) => f.kind === "dispatch").length;
  const first = fences[0];
  if (first === undefined) {
    const line = (heads[0] ?? text.split("\n", 1)[0]!).replace(
      /^devcorner: /,
      "",
    );
    return `dc: ${cutAtWord(line, 100) ?? line.slice(0, 100)}`;
  }
  const senders = [...new Set(fences.map((f) => f.from.split(", ")[0]!))];
  const who =
    senders.length > 2
      ? `${senders.slice(0, 2).join(", ")} +${senders.length - 2}`
      : senders.join(", ");
  const said = first.first.replace(/\s+/g, " ").trim();
  const words =
    cutAtWord(said, HANDED_WORDS) ?? `${said.slice(0, HANDED_WORDS - 1)}…`;
  const what =
    count <= 1
      ? first.kind === "chat"
        ? "message"
        : first.kind
      : `${count} messages`;
  return `dc: ${what} from ${who}${words ? `: ${words}` : ""}`;
}

/**
 * What the person reads of a hand-over the model was given whole just before
 * it: its lines that name the messages and the work sent, each to the end of
 * its first sentence, which names them (what follows is for the model: how to
 * weigh them, what to do with a dispatch), and where their text is.
 */
export function handOverLine(text: string): string {
  const { heads } = handOverParts(text);
  const named = heads.map((line) => {
    const end = line.indexOf(". ");
    return end === -1 ? line : line.slice(0, end + 1);
  });
  return `${named.join(" ")} Their whole text came just before this line.`;
}

/**
 * The marker the prompt hooks read (dc-t173): how many messages a prompt's
 * hook would hand the conversation's session now, as devcorner's Status last
 * said, and when (unix seconds), on one line: "2 1760000000". "unknown" when
 * the module could not tell: no answer, or a devcorner too old to count them,
 * and the hooks then ask as before. While it says 0 the hooks stay quiet, and
 * ask anyway once it and their own last ask are five minutes old
 * (DEVCORNER_HOOK_FALLBACK in hooks/devcorner.sh).
 */
export function markerText(pending: number | null, nowMs: number): string {
  const at = Math.floor(nowMs / 1000);
  return `${pending === null ? "unknown" : Math.max(0, Math.floor(pending))} ${at}\n`;
}

/**
 * Where the marker for conversation `id` goes: where the hook script reads
 * it (`markers` in hooks/devcorner.sh), named from the same variables. The
 * module cannot read the CLAUDE_PLUGIN_DATA a command hook is given, so the
 * marker is not kept beside the script's stamps there. Undefined with no
 * home to keep it in, or an id the hook would not read.
 */
export function markerFile(id: string, env: StateEnv): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const base = stateDir(env);
  return base ? `${base}/waiting/${id}.waiting` : undefined;
}

/** The variables the plugin's folder is named from. */
type StateEnv = { state?: string; cache?: string; home?: string };

/**
 * The folder the plugin keeps its files in, named as the hook script names it
 * (`markers` in hooks/devcorner.sh): DEVCORNER_HOOK_STATE, else
 * $XDG_CACHE_HOME/devcorner, else ~/.cache/devcorner. Undefined with no home.
 */
export function stateDir(env: StateEnv): string | undefined {
  return (
    env.state ||
    (env.cache
      ? `${env.cache}/devcorner`
      : env.home
        ? `${env.home}/.cache/devcorner`
        : undefined)
  );
}

/** The hooks' folder's variables, as this Claude Code has them. */
async function stateEnvOf($: Engine): Promise<StateEnv> {
  return {
    state: await $.env.get("DEVCORNER_HOOK_STATE"),
    cache: await $.env.get("XDG_CACHE_HOME"),
    home: await $.env.get("HOME"),
  };
}

/** What the row says while devcorner is updating, after a deploy. */
export const UPDATING_LINE = "devcorner is updating, back in a moment";
/** The longest a "try again in" from devcorner is waited, in case one is wrong. */
export const MAX_UPDATING_MS = 5 * 60_000;
/** How long past that wait the row still says devcorner is updating, unless it answers again. */
export const UPDATING_GRACE_MS = 15_000;

/**
 * How long devcorner asked to be left alone, in ms, when it answered that it
 * is updating: for about a minute after a deploy that changed what it and its
 * stores say to each other, every call is answered 503 with Retry-After and
 * `{ "error": "updating", "retryAfter": N }` (devcorner's src/hub/updating.ts).
 * Null for any other answer, which is a failure as before.
 */
export function updatingFor(res: {
  status: number;
  headers: Record<string, string>;
  text: string;
}): number | null {
  if (res.status !== 503) return null;
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    return null;
  }
  if ((body as { error?: unknown } | null)?.error !== "updating") return null;
  const said = Number(
    res.headers["retry-after"] ?? (body as { retryAfter?: unknown }).retryAfter,
  );
  const seconds = Number.isFinite(said) && said > 0 ? said : 5;
  return Math.min(seconds * 1000, MAX_UPDATING_MS);
}

/**
 * The remote git prints for origin (dc-t565): devcorner folds it into the
 * repo's name, owner/name on GitHub and with its host on another, as
 * bitbucket.org/acme/shop, so the plugin never drops the host. A user or a
 * token an https remote holds is left out, as the hook script leaves it
 * out. Undefined when git printed none.
 */
export function remoteOf(printed: string): string | undefined {
  const remote = printed
    .trim()
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, "$1");
  return remote && !/\s/.test(remote) ? remote : undefined;
}

/** How many folders a remote that is a folder is followed through to the remote its repo came from. */
const FOLDER_HOPS = 3;

/**
 * The folder a remote names when it is one on this machine, as git prints
 * it: an absolute path, as a clone of a folder keeps, or a file:/// URL
 * (dc-t565). devcorner names no repo for it, so the plugin reads the remote
 * that folder's repo came from in its place, as the hook script does.
 * Undefined for a remote on a host, and for a relative path, which git
 * reads from the repo's own top folder, not the conversation's.
 */
export function folderOf(printed: string): string | undefined {
  const remote = printed.trim();
  const file = /^file:\/\/(\/.+)$/i.exec(remote);
  if (file) return file[1];
  return /^(?:\/|[a-z]:[\\/])./i.test(remote) ? remote : undefined;
}

/**
 * A piece of the row above the prompt (dc-t533): its words, and the page it
 * links to when devcorner named one.
 */
type Segment = { text: string; href?: string };

/** A piece of the row, linked when devcorner named a page for it. */
const piece = (text: string, href?: string | null): Segment =>
  href ? { text, href } : { text };

/** A row's words, links or not. */
export const lineText = (line: Segment[]) =>
  line.map((segment) => segment.text).join("");

/**
 * Characters a terminal draws two cells wide (Unicode's East Asian Wide and
 * Full-width, emoji presented as emoji): Hangul, CJK, full-width and vertical
 * forms, and every symbol and pictograph plane, its few narrow ones counted
 * wide too, since a line counted too wide is only cut sooner.
 */
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x1b2ff],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

/** A character's cells: two when wide, else one. */
const cellsOf = (c: number) =>
  WIDE.some(([from, to]) => c >= from && c <= to) ? 2 : 1;

/**
 * How many terminal cells a text takes (dc-t487): two for a wide character,
 * none for a combining mark or a joiner, else one; a narrow symbol that a
 * variation selector shows as an emoji (❤️) takes two.
 */
export function cells(text: string): number {
  let n = 0;
  let last = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfe0f) {
      if (last === 1) n += 1;
      last = 2;
      continue;
    }
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || c === 0xfe0e) continue;
    last = cellsOf(c);
    n += last;
  }
  return n;
}

/**
 * Text from devcorner as the row draws it, on one line: control characters
 * (a newline, a tab, an escape) and runs of spaces become one space, so no
 * title breaks the row or is measured short.
 */
const oneLine = (text: string) =>
  Array.from(text, (ch) => {
    const c = ch.codePointAt(0)!;
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** What a text cut short ends with before its "…": spaces and separators. */
const TRAILING = /[\s,;:·]+$/u;

/**
 * A text cut at a word to fit `room` cells (dc-t533): whole when it fits,
 * else the words that fit with "…" after them, the spaces and separators
 * before it trimmed; null when not even its first word fits so.
 */
export function cutAtWord(text: string, room: number): string | null {
  if (cells(text) <= room) return text;
  for (
    let end = text.lastIndexOf(" ");
    end > 0;
    end = text.lastIndexOf(" ", end - 1)
  ) {
    const kept = text.slice(0, end).replace(TRAILING, "");
    if (kept && cells(kept) + cells("…") <= room) return `${kept}…`;
  }
  return null;
}

/** A size Claude Code gave, when it is one. */
const sizeOf = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

/** An id without its store's tail: dc-s7@acme as dc-s7; null for an id with none. */
const shortId = (id: string) => (id.includes("@") ? id.split("@")[0]! : null);

/** What devcorner could not read for the answer (dc-t137); none from an older devcorner. */
const unreadOf = (s: Status) => s.couldNotRead ?? [];

/**
 * How many things wait on the person, as the row says it: the count, or with
 * a part of devcorner unread (dc-t137) "2+", or "?" for none of what it read,
 * since what it could not read may hold some.
 */
function waitingCount(s: Status): string {
  if (unreadOf(s).length === 0) return String(s.waiting);
  return s.waiting > 0 ? `${s.waiting}+` : "?";
}

/** The page "devcorner" opens: the project's place, else the workspace's or Personal's, as devcorner named them. */
const projectHome = (s: Status) => s.links?.project ?? s.links?.place;

/** What the row draws before its words. */
const BULLET = "● ";

/**
 * The short id of the session the conversation works as (dc-t533): s7, of
 * dc-s7@acme, acme-s7 or me-s7; an id of another shape without its store's
 * tail.
 */
export function shortSession(id: string): string {
  return /-(s\d+)(?:@|$)/.exec(id)?.[1] ?? shortId(id) ?? id;
}

/**
 * The window's name as /dc and /dc sessions say it (dc-t589): devcorner's
 * label for it, else, from an older devcorner, which gives none, the
 * conversation's own name; null for neither.
 */
const windowName = (s: Status): string | null =>
  s.label ?? s.thisConversation?.name ?? null;

/**
 * The row above the prompt (dc-t533): one line of links, and nothing to
 * press. "devcorner" opens the project's home (else the workspace's place,
 * or Personal's for a repo in none); the short id of the session the
 * conversation works as opens that session's page; and "waiting N" opens the
 * inbox of the repo's place, said only while something waits there, "2+" or
 * "?" with a part of devcorner unread (dc-t137). A part devcorner named no
 * page for is plain. A message the loop cap holds for this conversation
 * comes last, in plain text (`heldLine`), until a typed turn releases it.
 *
 * The window's label (dc-t589), the conversation's `/dc name` else its
 * machine and place, comes first, in plain text, then the id: "devcorner ·
 * MacBook Air 1 (Web) · s213 · waiting 2", and with no session the label
 * alone, since it names the window. With none, as from an older devcorner or
 * on a token that names no machine, the row is as it was: the id with the
 * conversation's name after it, "devcorner · s7 reviewer · waiting 2", and
 * with no session neither. Given the cells Claude Code lays the row out in,
 * the label or the name is cut at a word, "(Web)" first, else left out, so
 * the line never wraps; nothing else is cut, the id never.
 */
export function rowSegments(
  s: Status,
  columns?: number,
  chat: LaptopLine | null = null,
): Segment[] {
  const head = piece("devcorner", projectHome(s));
  const id = s.session
    ? [piece(" · "), piece(shortSession(s.session.id), s.links?.session)]
    : [];
  const held = heldLine(s);
  const turned = turnedDownLine(s);
  const waiting = [
    ...(s.waiting > 0 || unreadOf(s).length > 0
      ? [piece(" · "), piece(`waiting ${waitingCount(s)}`, s.links?.inbox)]
      : []),
    ...(held === null ? [] : [piece(" · "), piece(held)]),
    ...(turned === null ? [] : [piece(" · "), piece(turned)]),
    ...(chat === null
      ? []
      : [piece(" · "), piece(laptopLineText(chat), chat.url ?? undefined)]),
  ];
  const room = sizeOf(columns);
  const fixed = cells(BULLET) + cells(lineText([head, ...id, ...waiting]));
  /** The words cut to the room left after the rest and `before`, which comes before them. */
  const fitted = (words: string, before: string) =>
    room === undefined ? words : cutAtWord(words, room - fixed - cells(before));
  const label = s.label ? oneLine(s.label) : "";
  if (label) {
    const cut = fitted(label, " · ");
    return [
      head,
      ...(cut ? [piece(" · "), piece(cut)] : []),
      ...id,
      ...waiting,
    ];
  }
  const name =
    s.session && s.thisConversation?.name
      ? oneLine(s.thisConversation.name)
      : "";
  const cut = name ? fitted(name, " ") : null;
  return [head, ...id, ...(cut ? [piece(` ${cut}`)] : []), ...waiting];
}

/** What the row says of the window chat this window mirrors: its id, and whether it reaches devcorner now. */
export function laptopLineText(chat: LaptopLine): string {
  return `window chat ${chat.thread} ${chat.reconnecting ? "reconnecting…" : "live"}`;
}

/**
 * The row in a repo devcorner does not know (dc-t533): what sets it up and
 * what hides this, as commands, since the row has nothing to press, and
 * "devcorner" linked as the row's own is.
 */
export function nudgeSegments(s: Status): Segment[] {
  return [
    piece("devcorner", projectHome(s)),
    piece(" · new project here · /dc setup sets it up · /dc hide hides this"),
  ];
}

/**
 * The environment variables Claude Code reads to decide whether its terminal
 * draws links (dc-t577), each undefined while unset.
 */
export type LinkEnv = Readonly<Record<string, string | undefined>>;

/** The terminals Claude Code takes to draw links by their name alone. */
const LINK_TERMINALS = [
  "ghostty",
  "Hyper",
  "kitty",
  "alacritty",
  "iTerm.app",
  "iTerm2",
  "WarpTerminal",
];

/** CI services whose logs draw colour, as Claude Code's colour check names them. */
const COLOUR_CI = [
  "TRAVIS",
  "CIRCLECI",
  "APPVEYOR",
  "GITLAB_CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
];

/**
 * A terminal's version as Claude Code's link check reads it: "3.5.0" as
 * 3 and 5, and VTE's "6003" as 0 and 60. A part it cannot read is NaN, which
 * no comparison holds.
 */
function versionOf(text: string): { major: number; minor: number } {
  const vte = /^\d{3,4}$/.test(text) ? /(\d{1,2})(\d{2})/.exec(text) : null;
  if (vte) return { major: 0, minor: parseInt(vte[1]!, 10) };
  const [major, minor] = text.split(".").map((part) => parseInt(part, 10));
  return { major: major ?? NaN, minor: minor ?? NaN };
}

/**
 * Whether Claude Code draws colour on its terminal (the `supports-color`
 * package it bundles, for a TTY): links are drawn only where colour is.
 */
function coloursIn(env: LinkEnv): boolean {
  const force = env.FORCE_COLOR;
  const forced =
    force === undefined
      ? undefined
      : force === "true" || force === ""
        ? 1
        : force === "false"
          ? 0
          : Math.min(parseInt(force, 10), 3);
  if (forced === 0) return false;
  const floor = Boolean(forced);
  const term = env.TERM ?? "";
  if (term === "dumb") return floor;
  if (env.CI !== undefined) {
    return (
      COLOUR_CI.some((name) => env[name] !== undefined) ||
      env.CI_NAME === "codeship" ||
      floor
    );
  }
  if (env.TEAMCITY_VERSION !== undefined) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION);
  }
  return (
    env.COLORTERM !== undefined ||
    env.TERM_PROGRAM === "iTerm.app" ||
    env.TERM_PROGRAM === "Apple_Terminal" ||
    /-256(color)?$/i.test(term) ||
    /^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term) ||
    floor
  );
}

/**
 * The `supports-hyperlinks` package's answer for Claude Code's terminal, a
 * TTY, as Claude Code bundles it: FORCE_HYPERLINK first, then colour, then
 * the terminal's name and version.
 */
function hyperlinkPackage(env: LinkEnv): boolean {
  if (env.FORCE_HYPERLINK) return parseInt(env.FORCE_HYPERLINK, 10) !== 0;
  if (env.NETLIFY) return true;
  if (!coloursIn(env)) return false;
  if (env.WT_SESSION !== undefined) return true;
  if (env.CI || env.TEAMCITY_VERSION) return false;
  const version = versionOf(env.TERM_PROGRAM_VERSION ?? "");
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      return version.major === 3 ? version.minor >= 1 : version.major > 3;
    case "WezTerm":
      return version.major >= 20200620;
    case "vscode":
      return version.major > 1 || (version.major === 1 && version.minor >= 72);
    case "ghostty":
      return true;
  }
  if (env.VTE_VERSION) {
    if (env.VTE_VERSION === "0.50.0") return false;
    const vte = versionOf(env.VTE_VERSION);
    return vte.major > 0 || vte.minor >= 50;
  }
  return env.TERM === "alacritty";
}

/**
 * Whether Claude Code draws a `Link` on its terminal as a link (dc-t577), by
 * its own rule (Claude Code 2.1.312), which the plugin API does not expose:
 * where it does not, a `Link` is drawn as its words then its whole address,
 * so the row draws plain words there. The rule's parts a plugin cannot read
 * are left out: what an attached client says it draws, which comes first,
 * and the command-line flags it reads from Claude Code's own (such as
 * `--no-hyperlink`, `--hyperlink=never` and `--no-color`).
 */
export function hyperlinksIn(env: LinkEnv): boolean {
  if (env.FORCE_HYPERLINK !== undefined) return hyperlinkPackage(env);
  if (hyperlinkPackage(env)) return true;
  const program = env.TERM_PROGRAM;
  if (program && LINK_TERMINALS.includes(program)) return true;
  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (env.WT_SESSION && program !== "tmux" && !env.TMUX) return true;
  if (program === "tmux") {
    const { major, minor } = versionOf(env.TERM_PROGRAM_VERSION ?? "");
    if (major > 3 || (major === 3 && minor >= 4)) return true;
  }
  if (env.LC_TERMINAL && LINK_TERMINALS.includes(env.LC_TERMINAL)) return true;
  return env.TERM?.includes("kitty") ?? false;
}

/** The variables `hyperlinksIn` reads, from Claude Code's environment, each named as written so `claude plugin validate` lists it. */
async function linkEnv($: Engine): Promise<LinkEnv> {
  const read = {
    FORCE_HYPERLINK: $.env.get("FORCE_HYPERLINK"),
    NETLIFY: $.env.get("NETLIFY"),
    FORCE_COLOR: $.env.get("FORCE_COLOR"),
    TERM: $.env.get("TERM"),
    COLORTERM: $.env.get("COLORTERM"),
    CI: $.env.get("CI"),
    CI_NAME: $.env.get("CI_NAME"),
    TRAVIS: $.env.get("TRAVIS"),
    CIRCLECI: $.env.get("CIRCLECI"),
    APPVEYOR: $.env.get("APPVEYOR"),
    GITLAB_CI: $.env.get("GITLAB_CI"),
    GITHUB_ACTIONS: $.env.get("GITHUB_ACTIONS"),
    BUILDKITE: $.env.get("BUILDKITE"),
    TEAMCITY_VERSION: $.env.get("TEAMCITY_VERSION"),
    TERM_PROGRAM: $.env.get("TERM_PROGRAM"),
    TERM_PROGRAM_VERSION: $.env.get("TERM_PROGRAM_VERSION"),
    VTE_VERSION: $.env.get("VTE_VERSION"),
    WT_SESSION: $.env.get("WT_SESSION"),
    TMUX: $.env.get("TMUX"),
    TERMINAL_EMULATOR: $.env.get("TERMINAL_EMULATOR"),
    LC_TERMINAL: $.env.get("LC_TERMINAL"),
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(read).map(async ([name, value]) => [name, await value]),
    ),
  );
}

/** Whether the terminal draws links, once read (dc-t577). */
type LinksRead = { read?: Promise<boolean> };

/**
 * Whether the terminal draws links, by Claude Code's rule, read once into
 * `kept`. A read that failed is not kept, so the next draw reads again;
 * till then, links, as the row drew before.
 */
function terminalLinks($: Engine, kept: LinksRead): Promise<boolean> {
  const read = (kept.read ??= linkEnv($).then(hyperlinksIn));
  return read.catch(() => {
    if (kept.read === read) delete kept.read;
    return true;
  });
}

/** The width of the label column in /dc's text (dc-t313): one lower-case label a line, its value after it. */
export const LABEL_WIDTH = 8;

/** A label in the label column; "" for a line that goes on from the one above. */
const labelled = (name: string) => name.padEnd(LABEL_WIDTH);

/** "3 sessions", "1 run": a count and its noun. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The longest of some ids. */
const widest = (ids: string[]) => Math.max(0, ...ids.map((id) => id.length));

/** A paste's size in a few characters (dc-t490): "840 chars", "1.2k chars". */
export function sizeText(length: number): string {
  const n = Math.max(0, Math.floor(length));
  if (n < 1000) return `${n} char${n === 1 ? "" : "s"}`;
  const k = (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "");
  return `${k}k chars`;
}

const DAY_MS = 24 * 60 * 60_000;

/** How long until a paste expires (dc-t490): "expires in 6 d", "expires today". */
export function expiresText(expiresAt: number, now: number): string {
  const days = Math.floor((expiresAt - now) / DAY_MS);
  return days >= 1 ? `expires in ${days} d` : "expires today";
}

/**
 * How many things wait on the person in their other places (dc-t518), as
 * /dc says it after what waits here: " (+3 elsewhere)"; empty when none
 * does, and from an older devcorner, whose `waiting` counts every place's.
 */
function elsewhereText(s: Status): string {
  const n = s.waitingElsewhere ?? 0;
  return n > 0 ? ` (+${n} elsewhere)` : "";
}

/**
 * The work in flight /dc says (In flight, its moving line): what every read
 * says (dc-t508), else its picture's, which is all an older devcorner says.
 */
const inFlightIn = (s: Status): StatusInFlight | null =>
  s.inFlight ?? s.expanded?.inFlight ?? null;

/**
 * Who this conversation is, as /dc and /dc now open with it: "devcorner",
 * the session it works as, else the conversation's own id (dc-t312, part 5),
 * with the window's label (dc-t589, `windowName`), then the pause of its
 * relays on the person's word when there is one: "devcorner · dc-s7@acme
 * MacBook Air 1 (Web)".
 */
function whoHead(s: Status): string {
  const here = s.thisConversation;
  const id = s.session?.id ?? here?.id ?? null;
  const label = windowName(s);
  const name = label ? ` ${oneLine(label)}` : "";
  const paused = pausedLine(s);
  return [
    "devcorner",
    ...(id === null ? [] : [`${id}${name}`]),
    ...(paused === null ? [] : [paused]),
  ].join(" · ");
}

/**
 * The pause of this conversation's chain of relays on the person's word
 * (dc-t312): "dc-h3 ↔ dc-h4 paused after 4 wakes, type to continue", from
 * devcorner's `paused`, ids of a conversation's shape alone. Null when it is
 * not paused, or an older devcorner says nothing of it.
 */
export function pausedLine(s: Status): string | null {
  const here = s.thisConversation?.id;
  const paused = s.paused;
  const shape = CONVERSATION;
  if (!here || !paused || !shape.test(here) || !shape.test(paused.with)) {
    return null;
  }
  const wakes =
    Number.isInteger(paused.wakes) && paused.wakes > 0 ? paused.wakes : null;
  return `${here} ↔ ${paused.with} paused${wakes === null ? "" : ` after ${wakes} wakes`}, type to continue`;
}

/**
 * What waits without waking this conversation, as the row says it: the
 * messages held past the hour's wakes, "3 held · hour's wakes spent · type
 * to release", which its person's next typed turn hands. An older devcorner
 * said the loop cap's held message instead: "me-m9 from me-h4 held after 4
 * wakes · type to release", with "(+1)" for each other held. Ids of a
 * message's and a conversation's shape alone; null when none is held.
 */
export function heldLine(s: Status): string | null {
  // A session's count holds its conversation's too; a conversation with no
  // session says its own.
  const over = (s.session?.overBudget ?? s.conversation?.overBudget)?.count;
  if (Number.isInteger(over) && over! > 0)
    return `${over} held · hour's wakes spent · type to release`;
  const held = (s.held ?? []).filter(
    (h) => MESSAGE.test(h.message) && CONVERSATION.test(h.from),
  );
  const last = held.at(-1);
  if (last === undefined) return null;
  const wakes =
    Number.isInteger(last.wakes) && last.wakes > 0
      ? ` after ${last.wakes} wakes`
      : "";
  const more = held.length > 1 ? ` (+${held.length - 1})` : "";
  return `${last.message} from ${last.from} held${wakes}${more} · type to release`;
}

/**
 * What this conversation turned down, as the row says it, by short id:
 * "muted s12, r3 · quiet s9", a family's with a "+" ("muted s12+"), every
 * sender as "all". Null when nothing is, or from an older devcorner.
 */
export function turnedDownLine(s: Status): string | null {
  const on = (s.turnedDown ?? []).filter(
    (v) =>
      typeof v.from === "string" && (v.level === "mute" || v.level === "quiet"),
  );
  const named = (level: "mute" | "quiet") =>
    on
      .filter((v) => v.level === level)
      .map((v) =>
        v.from === "all"
          ? "all"
          : `${/-([srh]\d+)(?:@|$)/.exec(v.from)?.[1] ?? v.from}${v.family === true ? "+" : ""}`,
      );
  const muted = named("mute");
  const quiet = named("quiet");
  const parts = [
    ...(muted.length > 0 ? [`muted ${muted.join(", ")}`] : []),
    ...(quiet.length > 0 ? [`quiet ${quiet.join(", ")}`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A sender as the person types it back: the row shows short ids ("muted
 * s12+, r3"), so "s12" is dc-s12. A whole id, a run, a conversation or
 * "all" goes as it is.
 */
export function senderId(word: string): string {
  const typed = word.trim();
  return /^[srh]\d+$/.test(typed) ? `dc-${typed}` : typed;
}

/**
 * What /dc mute and /dc quiet are given: the sender (a session, a run, a
 * conversation or "all"), then a time ("30m", "2h", "1h30m", or minutes
 * alone), then "family" for the sessions below a session too, in any order
 * after the sender. A refusal's words when there is no sender or a word is
 * neither.
 */
export function muteArgs(
  words: string,
): { from: string; minutes?: number; family: boolean } | string {
  const [from, ...rest] = words.trim().split(/\s+/).filter(Boolean);
  if (from === undefined) {
    return "Name who to turn down: /dc mute <session, run, conversation or all> [30m] [family].";
  }
  // No time typed is no time sent: devcorner's own default lasts (MUTE_MINUTES_DEFAULT).
  let minutes: number | undefined = undefined;
  let family = false;
  for (const word of rest) {
    if (word === "family") {
      family = true;
      continue;
    }
    const time = /^(?:(\d+)h)?(?:(\d+)m?)?$/.exec(word);
    if (time === null || (time[1] === undefined && time[2] === undefined)) {
      return `"${word}" is neither a time (30m, 2h, 1h30m) nor "family". Nothing was changed.`;
    }
    minutes = Number(time[1] ?? 0) * 60 + Number(time[2] ?? 0);
  }
  return { from, ...(minutes === undefined ? {} : { minutes }), family };
}

/**
 * What /dc mute, /dc quiet, /dc unmute and /dc mutes answer, from devcorner's
 * answer to Mute: its words, what it did and what is on, or that nothing is.
 * An older devcorner knows no Mute, and answers 204.
 */
export function mutedText(status: number, body: unknown): string {
  const answer = (body ?? {}) as {
    ok?: unknown;
    text?: unknown;
    error?: unknown;
  };
  if (status === 200 && answer.ok === true) {
    return typeof answer.text === "string" && answer.text
      ? answer.text
      : "Nothing is turned down in this conversation. /dc mute <id> [30m] or /dc quiet <id> turns a sender down.";
  }
  if (status === 204 || status === 404) {
    return "This devcorner does not take /dc mute yet, so nothing was changed.";
  }
  const why = typeof answer.error === "string" ? answer.error : null;
  return why
    ? `devcorner did not change it: ${why}`
    : `devcorner did not change it (HTTP ${status}), so nothing was changed.`;
}

/**
 * /dc mute, /dc quiet, /dc unmute and /dc mutes: turns a sender down for
 * this conversation and its session, the person's own word, posted as the
 * hook route's Mute with the machine's token; lifts it ("all" every one);
 * or says what is on. The row reads the status again to show it.
 */
async function muteHere(
  $: Engine,
  change: "mute" | "quiet" | "unmute" | "mutes",
  words: string,
): Promise<string> {
  let event: Record<string, unknown> = { hook_event_name: "Mute" };
  if (change === "mute" || change === "quiet") {
    const args = muteArgs(words);
    if (typeof args === "string") return args;
    event = { ...event, ...args, from: senderId(args.from), level: change };
  } else if (change === "unmute") {
    event = { ...event, lift: senderId(words) || "all" };
  }
  const posted = await postAsYou($, event, {
    command: `/dc ${change}`,
    nothing: "nothing was changed",
  });
  if (typeof posted === "string") return posted;
  if (posted.status === 200 && change !== "mutes") {
    await refresh($, true).catch(() => undefined);
  }
  return mutedText(posted.status, posted.body);
}

/** A ticket after its label: its id, as wide as `width`, then its title. */
const ticketText = (t: { id: string; title: string }, width: number) =>
  `${t.id.padEnd(width)} ${oneLine(t.title)}`;

/**
 * The newest paste of this conversation's sessions (dc-t490), as /dc says
 * it: its id and title, its size, when it expires (given the time) and how
 * many more of theirs are kept.
 */
function pasteText(paste: StatusPaste, time?: number): string {
  const more = Math.max(0, paste.count - 1);
  return [
    `${paste.id} ${oneLine(paste.title)}`,
    sizeText(paste.length),
    ...(time === undefined ? [] : [expiresText(paste.expiresAt, time)]),
    ...(more > 0 ? [`${more} more`] : []),
  ].join(" · ");
}

/** An other session's facts after its id, as devcorner words them (dc-t491): "acme/shop, waits on you". */
const otherFacts = (o: StatusOther) =>
  [o.repo, o.state].filter((fact) => fact).map((fact) => oneLine(fact!));

/**
 * The person's other live sessions (dc-t491), as /dc says them: each its id,
 * its conversation's name, its repo and how it stands, "acme-s4 reviewer
 * acme/shop, waits on you · me-s9 a/notes, idle 2 h", then how many more
 * devcorner counted than it named.
 */
function othersText(items: StatusOther[], total: number): string {
  const after = (o: StatusOther) =>
    [o.name ? oneLine(o.name) : "", otherFacts(o).join(", ")]
      .filter((words) => words)
      .map((words) => ` ${words}`)
      .join("");
  return [
    ...items.map((o) => `${o.id}${after(o)}`),
    ...(total > items.length ? [`${total - items.length} more`] : []),
  ].join(" · ");
}

/**
 * The repo's OA (dc-t213), as /dc says it: "dc-o3 Working (lands), 2/7
 * landed, 3 acts, 1 wait on you", and what of it nobody hears (dc-t536).
 */
function oaText(night: StatusOvernight): string {
  const facts = [
    night.room ? oneLine(night.room) : "",
    night.tasks ? oneLine(night.tasks) : "",
    ...oneLine(night.counts).split(", "),
    night.unheard ? oneLine(night.unheard) : "",
  ].filter((fact) => fact);
  return [`${night.id} ${oneLine(night.state)}`, ...facts].join(", ");
}

/** How many work streams /dc names before saying how many more things wait (dc-t492). */
export const WAITS_SHOWN = 4;

/**
 * What /dc says after the streams it names (dc-t492): the things waiting in
 * the streams it does not name, which `/dc waits` lists as far as devcorner
 * lists them, and the inbox whole.
 */
const WAITS_MORE_TEXT = (n: number) => `${n} more, in /dc waits and the inbox`;

/** How many things wait in these streams (dc-t492). */
const thingsIn = (streams: StatusWait[]) =>
  streams.reduce((n, w) => n + w.count, 0);

/**
 * How many things wait on the person over every stream (dc-t492), listed or
 * not, as devcorner counts them; from a devcorner that does not count them,
 * those of the streams it lists.
 */
const waitingThings = (s: Status, waits: StatusWait[]) =>
  Math.max(s.expanded?.waitingThings ?? 0, thingsIn(waits));

/**
 * How a work stream's thing is named under it (dc-t492): by what of its id
 * the stream's does not say ("q4" for dc-t423-q4 under dc-t423), by its id
 * without its store's tail when it is on another ticket (dc-t237-q1 under
 * dc-t206, the stream's id saying the store), and by nothing when it is the
 * stream's own ticket, session or run, or no devcorner id (a routine's, an
 * alert's), whose words alone say it.
 */
export function waitItemName(item: string, stream: string): string | null {
  if (!ID.test(item)) return null;
  const own = shortId(item) ?? item;
  const home = shortId(stream) ?? stream;
  if (own === home) return null;
  return own.startsWith(`${home}-`) ? own.slice(home.length + 1) : own;
}

/**
 * A work stream (dc-t492): its id, as wide as `width`, its title, what it
 * asks, how long ago its newest ask began (given the time), and its repo
 * when it is another's. A stream named by a word, not an id (the setup), is
 * said by it: its title would say it again.
 */
function streamText(
  w: StatusWait,
  width: number,
  s: Status,
  time: number | undefined,
): string {
  const titled = ID.test(w.id);
  const facts = [
    oneLine(w.asks),
    time === undefined ? "" : agoText(w.at, time),
    w.repo && w.repo !== s.repo ? oneLine(w.repo) : "",
  ].filter((fact) => fact);
  return [
    w.id.padEnd(width),
    ...(titled ? [` ${oneLine(w.title)}`] : []),
    ...facts.map((fact, i) => `${i === 0 && !titled ? " " : " · "}${fact}`),
  ].join("");
}

/**
 * A work stream's things, for the line under it (dc-t492), from its title's
 * column: each named (`waitItemName`) and said in its words, the newest
 * first, then how many more it asks than devcorner named. Null for a stream
 * devcorner named no thing of.
 */
function itemsText(w: StatusWait, width: number): string | null {
  if (w.items.length === 0) return null;
  const more = w.count - w.items.length;
  const said = w.items.map((item) => {
    const name = waitItemName(item.id, w.id);
    const words = oneLine(item.title);
    return name ? `${name} ${words}` : words;
  });
  return `${" ".repeat(width + 1)}${[...said, ...(more > 0 ? [`${more} more`] : [])].join(" · ")}`;
}

/**
 * What /dc says (dc-t218, dc-t533): the project's picture as text, then the
 * pages its lead items open, since a command's answer draws no links. Also
 * where the picture is when Claude Code's [-] hides the row. Its first line
 * names who this is, the workspace and the project; then Project home,
 * Active actions (what waits on the person, the row's count) and In flight
 * (the work moving now); then one fact a line under its label:
 *
 *   here    ticket dc-t10
 *   paste   me-p14 Reply to the reviewer · 1.2k chars · expires in 6 d
 *   others  acme-s4 acme/shop, waits on you · me-s9 a/notes, idle 2 h
 *   waits   dc-t4 Rate limits · Decide 2 · 2 d ago
 *           dc-t9 Tidy the docs · Yours 1 · 3 d ago
 *           5 more, in /dc waits and the inbox
 *   oa      dc-o3 Working (lands), 2/7 landed, 3 acts, 1 wait on you
 *   moving  3 live sessions · 1 run · 1 pull request
 *   cloud   dc-s9 Max · 3 of 5 runs · 2 workers
 *   next    dc-t5 Export
 *   code    main at ccccccc · deployed bbbbbbb 3 h ago
 *
 * Each fact is said once: next leaves out a ticket whose stream the waits
 * lines name, or the first of what waits from an older devcorner, which
 * lists no streams. A fact devcorner said nothing of is left out; the
 * picture's come only from a read that asked for it.
 */
export function dcText(s: Status, time?: number): string {
  const links = s.links;
  const more = s.expanded ?? null;
  const flight = inFlightIn(s);
  const lines = [
    `repo: ${s.repo}${s.known ? "" : " (new to devcorner)"}`,
    [
      whoHead(s),
      oneLine(s.workspace?.name ?? "personal"),
      ...(s.project ? [oneLine(s.project.name)] : []),
    ].join(" · "),
    [
      "Project home",
      `Active actions: ${waitingCount(s)}${elsewhereText(s)}`,
      flight ? `In flight: ${flight.count}` : "In flight",
    ].join(" · "),
  ];
  if (s.session?.ticket) {
    lines.push(`${labelled("here")}ticket ${s.session.ticket}`);
  }
  if (s.paste) lines.push(`${labelled("paste")}${pasteText(s.paste, time)}`);
  const others = s.others ?? null;
  if (others && others.items.length > 0) {
    lines.push(
      `${labelled("others")}${othersText(others.items, others.count)}`,
    );
  }
  // What waits by work stream (dc-t492), in place of the first of it, which
  // is all an older devcorner names.
  const listed = more?.waits;
  const first = listed === undefined ? (more?.firstWaiting ?? null) : null;
  const streams = (listed ?? []).slice(0, WAITS_SHOWN);
  const named = new Set([
    ...(first ? [first.id] : []),
    ...streams.map((w) => w.id),
  ]);
  const next = (more ? more.next : s.next ? [s.next] : []).filter(
    (t) => !named.has(t.id),
  );
  // What waits and Next share the tickets' column.
  const tickets = widest([...named, ...next.map((t) => t.id)]);
  if (first) lines.push(`${labelled("first")}${ticketText(first, tickets)}`);
  streams.forEach((w, i) => {
    lines.push(
      `${labelled(i === 0 ? "waits" : "")}${streamText(w, tickets, s, time)}`,
    );
  });
  const rest = waitingThings(s, listed ?? []) - thingsIn(streams);
  if (streams.length > 0 && rest > 0) {
    lines.push(`${labelled("")}${WAITS_MORE_TEXT(rest)}`);
  }
  const night = s.overnight;
  if (night) lines.push(`${labelled("oa")}${oaText(night)}`);
  const moving = flight
    ? [
        flight.sessions > 0 ? count(flight.sessions, "live session") : null,
        flight.runs > 0 ? count(flight.runs, "run") : null,
        flight.pulls > 0 ? count(flight.pulls, "pull request") : null,
        // The oa line says it.
        flight.night && !night ? "an OA" : null,
      ].filter((fact) => fact !== null)
    : [];
  if (moving.length > 0) {
    lines.push(`${labelled("moving")}${moving.join(" · ")}`);
  }
  const cloud = widest((more?.cloud ?? []).map((c) => c.id));
  (more?.cloud ?? []).forEach((c, i) => {
    lines.push(
      `${labelled(i === 0 ? "cloud" : "")}${[
        `${c.id.padEnd(cloud)} ${oneLine(c.routine)}`,
        oneLine(c.held),
        count(c.workers, "worker"),
      ].join(" · ")}`,
    );
  });
  next.forEach((t, i) => {
    lines.push(`${labelled(i === 0 ? "next" : "")}${ticketText(t, tickets)}`);
  });
  if (more?.code) lines.push(`${labelled("code")}${oneLine(more.code)}`);
  // Why a count is a part, in devcorner's words (dc-t137).
  lines.push(...unreadOf(s));
  const pages = [
    projectHome(s) ? `project home: ${projectHome(s)}` : null,
    links?.inbox ? `active actions: ${links.inbox}` : null,
    links?.work ? `in flight: ${links.work}` : null,
    s.paste
      ? `paste: ${s.paste.page ? `${s.paste.page} · ` : ""}/dc paste copies it`
      : null,
    `board: ${s.page}`,
  ].filter((line) => line !== null);
  return [...lines, ...pages].join("\n");
}

/** What /dc waits says from a devcorner that lists no work streams (dc-t492). */
export const WAITS_OLDER =
  "This devcorner does not list what waits on you by work stream yet; /dc says the first of it.";

/**
 * What /dc waits says (dc-t492): what waits on the person by work stream,
 * the newest first, every stream devcorner listed with its things on the
 * line under it; then how many more the inbox holds, why a count is a part
 * (dc-t137), and the inbox's page, since a command's answer draws no links.
 */
export function waitsText(s: Status, time?: number): string {
  const waits = s.expanded?.waits;
  if (waits === undefined) return WAITS_OLDER;
  const inbox = s.links?.inbox ? [`inbox: ${s.links.inbox}`] : [];
  if (waits.length === 0 && s.waiting === 0 && unreadOf(s).length === 0) {
    return [`${labelled("waits")}nothing waits on you`, ...inbox].join("\n");
  }
  const width = widest(waits.map((w) => w.id));
  const lines = waits.flatMap((w) => {
    const things = itemsText(w, width);
    return [
      `${labelled("")}${streamText(w, width, s, time)}`,
      ...(things === null ? [] : [`${labelled("")}${things}`]),
    ];
  });
  // Things, as /dc counts them; a part when some of devcorner was not read
  // (dc-t137).
  const things = waitingThings(s, waits);
  const rest = things - thingsIn(waits);
  const counted =
    unreadOf(s).length === 0 ? String(things) : things > 0 ? `${things}+` : "?";
  return [
    `${labelled("waits")}${counted} on you, by work stream, latest first`,
    ...lines,
    ...(rest > 0 ? [`${labelled("")}and ${rest} more, in the inbox`] : []),
    ...unreadOf(s),
    ...inbox,
  ].join("\n");
}

/**
 * Why /dc now has nothing of the session to say (dc-t489): the conversation
 * works as no session, devcorner is too old to say it, or it did not say it
 * this time.
 */
function nowMissing(s: Status): string {
  if (!s.session) return "this conversation works as no devcorner session";
  return s.now === undefined
    ? "this devcorner does not say what a session is on yet"
    : "devcorner did not say what this session is on this time";
}

/**
 * What /dc now says (dc-t489): who this is with how the session stands, then
 * one fact a line under its label, in devcorner's words (`Status.now`, the
 * rule `show(<session>:now)` writes too), then the session's page, since a
 * command's answer draws no links:
 *
 *   on      dc-t9 Export the row
 *   doing   Wiring the plugin row · noted 5 min ago
 *   lately  6 min ago  commit a1b2c3d: Status gives the now
 *           7 min ago  Drew the row
 *   asked   2 open · Label · Width
 *   runs    dc-r5 dc-t8 Review the row · picked up by dc-s9
 *
 * A fact it has none of is left out; with nothing of the session, a line
 * says why (`nowMissing`).
 */
export function nowText(s: Status): string {
  const now = s.now ?? null;
  const lines = [
    [whoHead(s), ...(now ? [oneLine(now.state)] : [])].join(" · "),
  ];
  if (!now) {
    lines.push(`${labelled("now")}${nowMissing(s)}`);
    return lines.join("\n");
  }
  lines.push(
    `${labelled("on")}${now.ticket ? ticketText(now.ticket, 0) : "no ticket"}`,
    `${labelled("doing")}${oneLine(now.doing.text)} · ${
      now.doing.from === "note"
        ? `noted ${now.doing.when}`
        : "its goal, no note yet"
    }`,
  );
  now.lately.forEach((move, i) => {
    lines.push(
      `${labelled(i === 0 ? "lately" : "")}${oneLine(move.when)}  ${oneLine(move.text)}`,
    );
  });
  const more = (shown: number, total: number) =>
    total > shown ? [`${total - shown} more`] : [];
  if (now.asked.count > 0) {
    lines.push(
      `${labelled("asked")}${[
        `${now.asked.count} open`,
        ...now.asked.items.map((q) => oneLine(q.title)),
        ...more(now.asked.items.length, now.asked.count),
      ].join(" · ")}`,
    );
  }
  const runs = widest(now.runs.items.map((r) => r.id));
  now.runs.items.forEach((run, i, all) => {
    lines.push(
      `${labelled(i === 0 ? "runs" : "")}${[
        ticketText(run, runs),
        oneLine(run.state),
        ...(i === all.length - 1 ? more(all.length, now.runs.count) : []),
      ].join(" · ")}`,
    );
  });
  if (now.page) lines.push(`session page: ${now.page}`);
  return lines.join("\n");
}

/** What /dc sessions ends with: how to message one of them (dc-t491), or have one do something and answer here (dc-t611). */
export const SESSIONS_SEND =
  "message one: /dc send <id> <text>; have one do something and answer here: /dc ask <id> <task>";

/**
 * What /dc sessions says (dc-t491): this conversation's session with the
 * window's label (dc-t589, `windowName`), then every other live session of
 * the person's, in every project, one a line under the labels, each with
 * where it runs (its cloud routine, else its conversation's name, then "this
 * machine" for one on this machine), its title
 * (dc-t627), its repo, how it stands, its ticket and whether a
 * /dc send wakes it (dc-t610), in devcorner's words; then their other
 * windows that work as no session; then how to message one. Or why
 * devcorner listed none: an older one lists no sessions, and a read that
 * could not list them says so.
 */
export function sessionsText(s: Status): string {
  const hereId = s.session?.id ?? s.thisConversation?.id ?? null;
  const label = windowName(s);
  const hereName = label ? ` ${oneLine(label)}` : "";
  const here =
    hereId === null
      ? `${labelled("here")}this conversation, unknown to devcorner yet`
      : `${labelled("here")}${hereId}${hereName}  ${[
          s.repo,
          s.session ? null : "no session",
          s.session?.ticket ? `on ${s.session.ticket}` : null,
        ]
          .filter((fact) => fact !== null)
          .join(" · ")}`;
  if (s.others === undefined) {
    return `${here}\nThis devcorner does not list your other sessions yet.`;
  }
  if (s.others === null) {
    return `${here}\ndevcorner did not list your other sessions this time.`;
  }
  const { items, count: total } = s.others;
  // A devcorner before dc-t610 names no windows.
  const windows = s.others.windows ?? [];
  const idle = windowLines(windows);
  if (items.length === 0) {
    const none = `${here}\n${labelled("others")}none live, in any project`;
    return idle.length === 0 ? none : [none, ...idle, SESSIONS_SEND].join("\n");
  }
  const width = widest(items.map((o) => o.id));
  const lines = items.map((o, i) => {
    const facts = [
      ...otherFacts(o),
      ...(o.ticket ? [`on ${o.ticket.id}`] : []),
      // The plugin its window runs; a devcorner before it says none.
      ...(o.plugin ? [oneLine(o.plugin)] : []),
      ...(o.reach ? [oneLine(o.reach)] : []),
    ].join(" · ");
    // Where it runs (dc-t627): its cloud routine, else its conversation's
    // name; a devcorner before it names the conversation only.
    const where = o.where === undefined ? o.name : o.where;
    const name = where ? ` ${oneLine(where)}` : "";
    // Its title (dc-t627); a devcorner before it names none.
    const title = o.title ? `"${oneLine(o.title)}" · ` : "";
    return `${labelled(i === 0 ? "others" : "")}${o.id.padEnd(width)}${name}  ${title}${facts}`;
  });
  const rest =
    total > items.length
      ? [`${labelled("")}and ${total - items.length} more`]
      : [];
  return [here, ...lines, ...rest, ...idle, SESSIONS_SEND].join("\n");
}

/**
 * The person's other windows that work as no session (dc-t610), as /dc
 * sessions says them under `windows`: each its id, where it runs (its name,
 * then "this machine" when it runs on this one; from a devcorner
 * before it, its name), its repo, when it was last heard from and that a
 * /dc send wakes it, in devcorner's words.
 */
function windowLines(windows: StatusWindow[]): string[] {
  const width = widest(windows.map((w) => w.id));
  return windows.map((w, i) => {
    const facts = [w.repo, w.state, w.plugin, w.reach]
      .filter((fact) => fact)
      .map((fact) => oneLine(fact!))
      .join(" · ");
    const where = w.where === undefined ? w.name : w.where;
    const name = where ? ` ${oneLine(where)}` : "";
    return `${labelled(i === 0 ? "windows" : "")}${w.id.padEnd(width)}${name}  ${facts}`;
  });
}

export function nudgePrompt(s: Status): string {
  if (s.joinWorkspace) {
    return `Set this repo up in devcorner: start a session for it, and if it is in no workspace, offer to add it to my workspace ${s.joinWorkspace.slug}. Ask me before changing anything.`;
  }
  const slug = s.suggestWorkspace?.slug ?? "a name of your choice";
  return `Set this repo up in devcorner: start a session for it, and if it is in no workspace, offer me a workspace named ${slug} for it. Ask me before making anything.`;
}

/**
 * /dc setup (dc-t533): in a repo devcorner does not know, `nudgePrompt` goes
 * as the person's own words once the command has answered, as the row's
 * offer says. devcorner has no page that puts a repo in a workspace, so the
 * person's agent does it with its devcorner tools, asking them first.
 */
async function setUpHere($: Engine): Promise<string> {
  const got = await refresh($, true);
  if ((await read($, updating)) !== null) {
    return got?.problem ?? UPDATING_LINE;
  }
  const s = got?.status ?? (await read($, status));
  if (!s) return got?.problem ?? NO_STATUS_LINE;
  if (s.known) return `devcorner knows ${s.repo} already.`;
  askDevcorner($, nudgePrompt(s));
  return `Asking Claude to set ${s.repo} up in devcorner.`;
}

/**
 * /dc hide (dc-t533): the row offers nothing more for a repo devcorner does
 * not know, remembered for the repo in the plugin's store; /dc setup still
 * sets it up.
 */
async function hideNudge($: Engine): Promise<string> {
  const s = await read($, status);
  if (!s) return NO_STATUS_LINE;
  if (s.known)
    return `devcorner knows ${s.repo} already: there is nothing to hide.`;
  const list = [...new Set([...(await read($, dismissed)), s.repo])];
  await $.store.set("dismissed", list);
  await update($, dismissed, () => list);
  $.ui.invalidate("ui.render");
  return `The row no longer offers to set ${s.repo} up; /dc setup still does.`;
}

/**
 * What an idle conversation does with devcorner's answer: wake for a message
 * it has not woken for, or ask again later, sooner while its session waits on
 * its person. A conversation that works as no session is woken by its own
 * mail, its person's word to it (dc-t312). Null stops asking: nothing to
 * wake, or a devcorner too old to say what would wake it. A turn starts the
 * asking again.
 *
 * A delivered message leaves the count, so `wokeFor` matters only when the
 * hook did not hand it over: without it, every ask would wake again.
 */
export function nextStep(
  s: WokenStatus,
  wokeFor: string | null,
): { wake: string } | { after: number } | null {
  const woken = wokenOf(s);
  if (!woken || woken.wakeMessages === undefined) return null;
  const latest = woken.wakeMessageId;
  if (woken.wakeMessages > 0 && latest && latest !== wokeFor) {
    return { wake: latest };
  }
  return {
    after: s.session?.waitingOnPerson ? WAITING_MS : IDLE_MS,
  };
}

/**
 * What the server's held request (`Wait`) answered: a message that wakes the
 * session or the conversation (ids only), mail the conversation is told of
 * without a turn (`notice`, dc-t312), nothing yet (`{}`, the hold ran out),
 * or a failure that hands the conversation to the Status poll: no answer, a
 * refusal, an answer not understood, or a conversation devcorner does not
 * know. Or that devcorner is updating, and asks to be left alone `after` ms.
 * Or that the session the conversation works as is not live any more
 * (`notLive`), so nothing would wake it: the window leaves it out of its
 * holds until its next turn or session.
 */
export type Held =
  | { kind: "wake"; session: string; id: string }
  | { kind: "notice"; id: string }
  | { kind: "claim" }
  | { kind: "chat"; chat: string }
  | { kind: "launch"; launch: string }
  | { kind: "reload" }
  | { kind: "stop"; chat: string }
  | { kind: "not-live"; session: string }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "updating"; after: number };

export function readHeld(text: string): Held {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { kind: "failed" };
    }
    const o = v as Record<string, unknown>;
    if ("session" in o && o.session === null) return { kind: "failed" };
    // The session this conversation works as has ended: no hold would ever
    // wake it, so the window leaves it out of its holds until its next turn
    // or session.
    if (typeof o.notLive === "string")
      return { kind: "not-live", session: o.notLive };
    if (typeof o.wake === "string" && typeof o.id === "string") {
      return { kind: "wake", session: o.wake, id: o.id };
    }
    if (typeof o.notice === "string") return { kind: "notice", id: o.notice };
    // The session the conversation works as changed (dc-t588): a Status says
    // the one it kept from its start.
    if (typeof o.claim === "string") return { kind: "claim" };
    // Words from devcorner's page wait for this window's window chat: ids
    // only, fetched with ChatParts.
    if (typeof o.chat === "string") return { kind: "chat", chat: o.chat };
    // A window chat to start on this machine, asked from devcorner's page:
    // the launch's number alone, taken with LaunchTake.
    if (typeof o.launch === "string")
      return { kind: "launch", launch: o.launch };
    // Its person asked this window to reload its plugin: a Status
    // says the ask, which `reloadWhenIdle` takes.
    if (typeof o.reload === "string") return { kind: "reload" };
    // devcorner's page moves the window chat this window mirrors to
    // devcorner and its person stopped this window first: the
    // chat alone, which `stopForMove` acts on.
    if (typeof o.stop === "string") return { kind: "stop", chat: o.stop };
    return { kind: "empty" };
  } catch {
    return { kind: "failed" };
  }
}

/** How long to leave devcorner alone after `failures` failed asks in a row. */
export function backoff(failures: number): number {
  return Math.min(DOWN_MS * 2 ** Math.max(0, failures - 1), MAX_DOWN_MS);
}

function isStatus(v: unknown): v is Status {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Status).known === "boolean"
  );
}

/** Whether devcorner's answer is a light status: the session part alone, for a read on a timer. */
function isStatusLight(v: unknown): v is StatusLight {
  return (
    typeof v === "object" && v !== null && (v as StatusLight).light === true
  );
}

/**
 * A stored status with what a light read said: its session, its
 * mail and the reload ask. Null for no stored status yet, which only a full
 * read fills.
 */
export function withLight(
  before: Status | null,
  light: StatusLight,
): Status | null {
  if (before === null) return null;
  return {
    ...before,
    repo: light.repo,
    session: light.session,
    waitingChat: light.waitingChat ?? null,
    waitingChatAt: light.waitingChatAt ?? null,
    conversation: light.conversation ?? null,
    ...(light.reload !== undefined ? { reload: light.reload } : {}),
  };
}

let lastAt = 0;

/**
 * What one read of devcorner's Status came to. Each read keeps its own, since
 * reads may run at once (the poll, /dc, a turn's refresh) and one must never
 * take another's answer for its own.
 */
type Read = {
  status?: Status;
  /** A light read's answer, which says the session part alone. */
  light?: StatusLight;
  /** Why it found no status, for /dc to say; never the token. */
  problem?: string;
  /** Whether that problem may pass by itself: devcorner unreachable or failing. */
  down: boolean;
  /** How long devcorner, updating, asked to be left alone (ms), or null. */
  retryIn: number | null;
  /**
   * The machine has no token (`none`), or devcorner revoked the one the
   * plugin kept (`revoked`), which is then forgotten (dc-t224).
   */
  signedOut?: "none" | "revoked";
  /** The token devcorner refused, so only that one is forgotten. Kept in memory alone. */
  refused?: string;
};

/** What ends the row's "updating" if devcorner is not asked again in time. */
let updatingTimer: Timer | undefined;
/** How many answers have been noted, so the latest wins (`noteUpdating`). */
let updatingNote = 0;

/**
 * Keeps what devcorner last said of an update: that it is updating and asked
 * to be left alone `ms`, or not (null). The row says so until devcorner
 * answers again, and at most `UPDATING_GRACE_MS` past the time it named,
 * since a running turn asks nothing until it ends. The row is redrawn when
 * that starts or ends.
 */
async function noteUpdating($: Engine, ms: number | null): Promise<void> {
  // Of two answers noted at once, only the later is kept: the earlier sets
  // no timer once it resumes, and writes nothing whenever a later one has
  // been noted before its write lands (the check is in the write itself,
  // which `update` may run again).
  const note = ++updatingNote;
  const until = ms === null ? null : (await $.clock.now()) + ms;
  if (note !== updatingNote) return;
  updatingTimer?.cancel();
  updatingTimer =
    ms === null
      ? undefined
      : $.clock.after(ms + UPDATING_GRACE_MS, () => {
          updatingTimer = undefined;
          void noteUpdating($, null).catch(() => {});
        });
  let redraw = false;
  await update($, updating, (was) => {
    if (note !== updatingNote) {
      redraw = false;
      return was;
    }
    redraw = (was === null) !== (until === null);
    return until;
  });
  if (redraw) $.ui.invalidate("ui.render");
}

/** The repo last read from git, by folder: asked every 15 s, it rarely changes. */
let lastRepo: { cwd: string; repo: string } | undefined;

/**
 * The remote of origin in a folder, followed through a remote that is a
 * folder to the remote that folder's repo came from (`folderOf`), up to
 * FOLDER_HOPS folders on. Undefined when no remote on a host is reached.
 */
async function repoIn($: Engine, cwd: string): Promise<string | undefined> {
  if (lastRepo?.cwd === cwd) return lastRepo.repo;
  let at: string[] = [];
  let repo: string | undefined;
  for (let hop = 0; hop <= FOLDER_HOPS; hop++) {
    const git = await $.process.run(
      ["git", ...at, "remote", "get-url", "origin"],
      { cwd, timeoutMs: 5000 },
    );
    // A relative folder names no repo either, and is not followed (`folderOf`).
    if (git.exitCode !== 0 || /^\.{1,2}[\\/]/.test(git.stdout.trim())) break;
    const folder = folderOf(git.stdout);
    if (folder === undefined) {
      repo = remoteOf(git.stdout);
      break;
    }
    at = ["-C", folder];
  }
  lastRepo = repo ? { cwd, repo } : undefined;
  return repo;
}

/**
 * The branch git is on in a folder, as `git branch --show-current` prints
 * it; null on a detached head, where it prints none; undefined when git
 * cannot say. Read at each Status, since it is what changes.
 */
async function branchIn(
  $: Engine,
  cwd: string,
): Promise<string | null | undefined> {
  const git = await $.process.run(["git", "branch", "--show-current"], {
    cwd,
    timeoutMs: 5000,
  });
  if (git.exitCode !== 0) return undefined;
  const branch = git.stdout.trim();
  if (branch === "") return null;
  return /\s/.test(branch) ? undefined : branch;
}

/**
 * Where a window chat's window leaves its folder in git, sent with its
 * opening and with each turn's end, never as it leaves, since a closed lid
 * sends nothing: the commit it is on, by its short id and subject, and its
 * files not committed, how many and the first `MAX_GIT_PATHS` of them.
 */
interface WindowGit {
  head: string;
  subject: string | null;
  uncommitted: number;
  paths: string[];
}

/** The most uncommitted files' paths a window's git state names; devcorner keeps no more. */
const MAX_GIT_PATHS = 20;

/** The exit code git ends with when it refuses a folder: no repo there, or no commit yet. */
const GIT_REFUSED = 128;

/**
 * Where git stands in a folder (`WindowGit`), read with two quick calls that
 * take none of git's optional locks, so they never clash with a git command
 * running beside them: null for a folder that is no repo or has no commit,
 * undefined when git could not say now (it timed out or failed otherwise),
 * which says nothing, so devcorner keeps what it was told before.
 */
async function gitIn(
  $: Engine,
  cwd: string,
): Promise<WindowGit | null | undefined> {
  const git = (args: string[]) =>
    $.process.run(["git", "--no-optional-locks", ...args], {
      cwd,
      timeoutMs: 5000,
    });
  const [log, status] = await Promise.all([
    git(["log", "-1", "--format=%h%x00%s"]),
    git(["status", "--porcelain"]),
  ]);
  if (log.exitCode === GIT_REFUSED) return null;
  if (log.exitCode !== 0 || status.exitCode !== 0) return undefined;
  const [head = "", subject = ""] = log.stdout.trim().split("\0");
  if (!/^[0-9a-f]{4,40}$/i.test(head)) return undefined;
  // Each line is two status letters, a space and the path.
  const files = status.stdout.split("\n").filter((line) => line.trim() !== "");
  return {
    head,
    subject: subject.trim() || null,
    uncommitted: files.length,
    paths: files.slice(0, MAX_GIT_PATHS).map((line) => line.slice(3).trim()),
  };
}

/**
 * Where this window works now, as a window chat's opening, its rejoin and
 * each turn's end say it: its folder, the branch git is on there
 * (`branchIn`) and where it stands (`gitIn`). A turn's end says the folder
 * and branch too, since Claude Code may move a session into a worktree of
 * its own (`.claude/worktrees/<name>`) after the chat opened, and the page
 * pairs them with the commit. The branch is null on a detached head, which
 * a turn's end tells devcorner as no branch; whatever it cannot say now is
 * left out, which keeps what devcorner was told before.
 */
async function windowWhere($: Engine): Promise<{
  folder?: string;
  branch?: string | null;
  git?: WindowGit | null;
}> {
  const cwd = await $.session.cwd().catch(() => undefined);
  if (!cwd) return {};
  const [branch, git] = await Promise.all([
    branchIn($, cwd).catch(() => undefined),
    gitIn($, cwd).catch(() => undefined),
  ]);
  return {
    folder: cwd,
    ...(branch === undefined ? {} : { branch }),
    ...(git === undefined ? {} : { git }),
  };
}

/** One of this window's own commands as a window chat's page is told it: its name, its line and where it comes from, nothing else. */
interface WindowCommand {
  name: string;
  description: string;
  source: CommandInfo["source"];
}

/**
 * This window's own commands, as a window chat's `/` list offers them: its
 * skills, plugin commands and MCP prompts (`$.command.list()`), never
 * Claude Code's built-ins, which devcorner offers from its own list
 * (`PAGE_BUILTINS`); undefined when they cannot be read now, which a post
 * leaves out, so devcorner keeps those it took before.
 */
async function windowCommands($: Engine): Promise<WindowCommand[] | undefined> {
  const listed = await $.command.list().catch(() => undefined);
  return listed
    ?.filter((one) => one.source !== "builtin")
    .map(({ name, description, source }) => ({ name, description, source }));
}

/**
 * The branch devcorner last took for a conversation's folder (dc-t334): a
 * Status says the branch only when git has moved since, so a branch that
 * stays costs devcorner nothing. Kept for the conversation and folder it
 * was read in.
 */
let branchTaken: { key: string; branch: string } | undefined;

/**
 * Whether a Status that says the branch is out now. Reads overlap (a forced
 * refresh beside the poll), and devcorner may take two in either order, so
 * only one at a time says a branch: else an older read's branch could land
 * last while a newer one's answer is kept as taken, and the session stay on
 * a branch git has left.
 */
let branchSaying = false;

/** What the module has learnt of what waits, in the order it learnt it: each read and wake takes the next. */
let learnt = 0;
/** The latest read whose answer the row holds. */
let shown = 0;
/** The latest of them the marker holds. */
let marked = 0;
/** The marker's writes, one after another, so they land in the order made. */
let marking: Promise<void> = Promise.resolve();

/**
 * Tells the prompt hooks whether messages wait (`markerText`): a count, or
 * null when the module cannot tell, as learnt by `seq` (a read's or a wake's
 * turn in `learnt`). The module is the marker's only writer, and what it
 * learnt later always wins: a read that began before another and ended after
 * it writes nothing. Where no marker is kept (`keepsMarker`) nothing is
 * written, and one left from when it was is marked unknown, so the hooks ask
 * as before. Silent on any failure: the hooks then go by an older marker, or
 * ask as before with none.
 */
function markWaiting(
  $: Engine,
  pending: number | null,
  seq: number,
): Promise<void> {
  if (seq < marked) return marking;
  marking = marking.then(async () => {
    try {
      if (seq < marked) return;
      marked = seq;
      const file = await markerOf($);
      if (!file) return;
      const at = await $.clock.now();
      if (await draws($)) await $.fs.write(file, markerText(pending, at));
      else if (await $.fs.exists(file)) {
        await $.fs.write(file, markerText(null, at));
      }
    } catch {
      /* stay silent */
    }
  });
  return marking;
}

/**
 * Whether something draws the session. Only then is a marker kept: a plain -p
 * run draws nowhere, and there the hooks ask as before, since with no next
 * prompt and no wake a message its Stop hook skipped on a marker would never
 * reach the run.
 */
async function draws($: Engine): Promise<boolean> {
  return (await $.session.surfaces()).length > 0;
}

/** Whether the conversation keeps a marker: a file to name it, and something that draws it. */
async function keepsMarker($: Engine): Promise<boolean> {
  return (await markerOf($)) !== undefined && (await draws($));
}

/** The marker last worked out, for the conversation it is for. */
let marker: { id: string; file: string | undefined } | undefined;

/**
 * Where the conversation's marker goes (`markerFile`), or undefined where no
 * file can name it. Worked out once for each conversation: its variables do
 * not change.
 */
async function markerOf($: Engine): Promise<string | undefined> {
  const id = await $.session.id();
  if (marker?.id !== id) {
    marker = {
      id,
      file: markerFile(id, await stateEnvOf($)),
    };
  }
  return marker.file;
}

/** How many messages wait for the hooks, as a Status says it; null when it cannot say. */
export function pendingOf(s: WokenStatus | undefined): number | null {
  if (!s) return null;
  // A conversation that works as no session is handed its own mail alone
  // (dc-t312); an older devcorner hands it nothing.
  const woken = wokenOf(s);
  if (!woken) return 0;
  return typeof woken.pending === "number" ? woken.pending : null;
}

// Signing in (dc-t224). A machine signs in from Claude Code itself, as `gh
// auth login` does: /dc login (or an agent's connect_plugin) asks devcorner
// for a code, the row says where to open and what to enter, the person
// approves it on devcorner's /device page, and the module, asking at the
// interval devcorner gave, is handed a hook token made for this machine. It
// keeps the token in its own store ($.store), never in settings.json, and
// never shows it. DEVCORNER_TOKEN in the environment still wins, for people
// who set it themselves.
//
// The command hooks (hooks/devcorner.sh) send the token too, and cannot read
// $.store, so the module hands it to them as one owner-only file in their own
// folder (`tokenFile`), the folder the markers are in, written with umask 077
// and removed at sign-out; the store stays the one source, and the file is
// written again from it at each session's start.

/** What a hook token looks like; anything else in the store is no token. */
const hookTokenShape = /^dch_[A-Za-z0-9_-]{43}$/;

/** RFC 8628's grant type, which a poll names. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** The address of the devcorner the plugin talks to: DEVCORNER_URL, else the default. */
async function baseOf($: Engine): Promise<string> {
  return ((await $.env.get("DEVCORNER_URL")) ?? DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

/** The token the plugin sends, and where it came from: the environment wins over the store. */
type Token = { token: string; from: "env" | "store" };

async function tokenOf($: Engine): Promise<Token | null> {
  const set = await $.env.get("DEVCORNER_TOKEN");
  if (set) return { token: set, from: "env" };
  const kept = await keptToken($, await baseOf($));
  return kept ? { token: kept, from: "store" } : null;
}

/**
 * The store's key for the token a devcorner gave this machine. Each
 * devcorner's is its own, so a token is only ever sent to the devcorner that
 * made it, and a refusal from another never forgets it.
 */
export const tokenKey = (base: string) => `token:${base}`;

/** The token the store keeps for the devcorner at `base`, or null. */
async function keptToken($: Engine, base: string): Promise<string | null> {
  const kept = await $.store.get(tokenKey(base));
  return typeof kept === "string" && hookTokenShape.test(kept) ? kept : null;
}

/**
 * Where the module hands the command hooks the token it keeps: in their own
 * folder, named from the same variables as the markers (`markerFile`, and
 * `token_file` in hooks/devcorner.sh). Undefined with no home to keep it in.
 */
export function tokenFile(env: StateEnv): string | undefined {
  const base = stateDir(env);
  return base ? `${base}/token` : undefined;
}

async function tokenFileOf($: Engine): Promise<string | undefined> {
  return tokenFile(await stateEnvOf($));
}

/**
 * Writes the token for the command hooks, readable by its owner alone: the
 * shell makes the folder and the file under umask 077, and the token reaches
 * it on standard input, never in an argument.
 */
async function handOver($: Engine, token: string, base: string): Promise<void> {
  const file = await tokenFileOf($);
  if (file) await writePrivate($, file, handedText(token, base));
}

/**
 * Writes a file its owner alone may read: the shell makes the folder and the
 * file under umask 077, and the text reaches it on standard input, never in
 * an argument.
 */
async function writePrivate(
  $: Engine,
  file: string,
  text: string,
): Promise<void> {
  await $.process.run(
    [
      "sh",
      "-c",
      'umask 077 && mkdir -p "${1%/*}" && cat >"$1.new" && mv -f "$1.new" "$1"',
      "sh",
      file,
    ],
    { stdin: text, timeoutMs: 5000 },
  );
}

/**
 * What the hooks' file holds: the token, then the devcorner it is for, which
 * the hook script checks against its own DEVCORNER_URL before it sends it.
 */
export const handedText = (token: string, base: string) =>
  `${token}\n${base}\n`;

/**
 * Takes `token` for the devcorner at `base` back from the command hooks. The
 * file is shared by every plugin store of the machine, so it goes only while
 * it holds that token: one another store wrote since, or another devcorner's
 * conversation handed them, is its own, and stays.
 */
async function takeBack($: Engine, base: string, token: string): Promise<void> {
  const file = await tokenFileOf($);
  if (!file) return;
  const [held, forBase] = await handedIn($, file);
  if (held !== token || forBase !== base) return;
  await $.process.run(["rm", "-f", file], { timeoutMs: 5000 });
}

/** The hooks' file's token and the devcorner it is for, both empty with no file. */
async function handedIn(
  $: Engine,
  file: string,
): Promise<[token: string, base: string]> {
  if (!(await $.fs.exists(file).catch(() => false))) return ["", ""];
  const [token = "", base = ""] = String(
    await $.fs.read(file).catch(() => ""),
  ).split("\n");
  return [token, base];
}

/** Keeps a token devcorner gave this machine: in the store, and handed to the hooks. */
async function keepToken($: Engine, token: string): Promise<void> {
  const base = await baseOf($);
  await $.store.set(tokenKey(base), token);
  await handOver($, token, base);
  await markOffered($, base);
}

/**
 * Forgets the machine's token for this devcorner: from the store, and from
 * the hooks. With `only`, only while the store still holds that token: a
 * refusal of an old token never forgets a newer one another conversation
 * kept meanwhile.
 */
async function forgetToken($: Engine, only?: string): Promise<void> {
  const base = await baseOf($);
  const kept = await keptToken($, base);
  if (only !== undefined && kept !== only) return;
  await $.store.delete(tokenKey(base));
  if (kept) await takeBack($, base, kept);
}

/**
 * At a session's start the hooks' copy is made what the store says for this
 * devcorner when the store holds a token. A store that holds none is no
 * evidence the file is stale: the file is shared by every conversation of the
 * machine, and a window with a store of its own (an inline plugin) is empty
 * while the installed plugin's store holds the token. So an empty store
 * leaves the file alone; only a sign-out (`forgetToken`) takes it back.
 */
async function syncHandOver($: Engine): Promise<void> {
  const file = await tokenFileOf($);
  if (!file) return;
  const base = await baseOf($);
  const kept = await keptToken($, base);
  if (!kept) return;
  const there = (await $.fs.exists(file))
    ? String(await $.fs.read(file))
    : null;
  if (there !== handedText(kept, base)) await handOver($, kept, base);
}

/**
 * What the plugin says while this machine has no hook token (dc-t576, part
 * 4): at each session's start, in the transcript, and in /dc. `/mcp`'s
 * sign-in gives the agent its tools only; the hooks, the wake and the line
 * above the prompt need the machine's own hook token, and with none the hook
 * script exits without a word, so the window looked connected and heard
 * nothing.
 */
export const DELIVERY_OFF =
  "devcorner: delivery is off in this window: this machine has no hook token, so devcorner's messages, dispatches and wakes never reach this conversation, though the agent's devcorner tools still work. /dc login signs this machine in, or ask Claude to sign it in, or set DEVCORNER_TOKEN to a hook token from devcorner's connections page.";

/**
 * What the plugin says, where it says `DELIVERY_OFF`, when its store holds no
 * token but the hooks' file holds one for this devcorner: another plugin
 * store of the machine handed it over, as the installed plugin does beside a
 * window started with --plugin-dir. The command hooks still send with that
 * token, so only this window's line above the prompt and its wake are off.
 */
export const WINDOW_DELIVERY_OFF =
  "devcorner: delivery is off for this window alone: its plugin holds no token of its own (a window started with --plugin-dir keeps a store of its own), so the line above the prompt and the wake are off here. This machine keeps its hook token, and the hooks still send with it, so devcorner's messages still reach this conversation and every other. /dc login signs this window's plugin in too.";

/**
 * The line that says delivery is off with no token of the plugin's own:
 * `WINDOW_DELIVERY_OFF` while the hooks' file holds a hook token for the
 * devcorner at `base`, else `DELIVERY_OFF`.
 */
async function deliveryOff($: Engine, base: string): Promise<string> {
  const file = await tokenFileOf($);
  const [token, forBase] = file ? await handedIn($, file) : ["", ""];
  return forBase === base && hookTokenShape.test(token)
    ? WINDOW_DELIVERY_OFF
    : DELIVERY_OFF;
}

/** What /dc says in a cloud session, which is never signed in (`NO_SIGN_IN.cloud`), so has no hooks' delivery. */
export const CLOUD_DELIVERY =
  "devcorner: this is a cloud session, whose plugin is never signed in, so devcorner's hooks and wake are off here; the agent's devcorner tools reach it through its own connection, and its check() reads its messages.";

/**
 * The store's key that says the devcorner at `base` was offered a sign-in on
 * this machine's first run (dc-t576, part 4): the plugin starts /dc login
 * itself once, and after that only says how.
 */
export const offeredKey = (base: string) => `offered:${base}`;

/**
 * Keeps that this machine needs no sign-in offered for the devcorner at
 * `base` any more: once offered, once signed in (`keepToken`), and once
 * signed out on purpose (`signOut`), so a person who chose to be signed
 * out is never signed in for unasked.
 */
async function markOffered($: Engine, base: string): Promise<void> {
  await $.store.set(offeredKey(base), true);
}

/**
 * At a session's start with no token on a machine that may sign in
 * (`noSignIn`): says delivery is off, and on the machine's first run for this
 * devcorner starts the sign-in itself, as /dc login does, so the person has
 * only to approve the code the line above the prompt shows. Never in a cloud
 * session, nor with DEVCORNER_TOKEN or a kept token, nor where nothing draws
 * the session. Silent on any failure.
 */
async function offerDelivery($: Engine): Promise<void> {
  try {
    if ((await noSignIn($)) !== null) return;
    // A plain -p run draws nowhere, and has no person to approve a code.
    if (!(await draws($))) return;
    const base = await baseOf($);
    $.ui.log(await deliveryOff($, base));
    if ((await $.store.get(offeredKey(base))) !== undefined) return;
    const got = await showCode($);
    // A code devcorner could not give is offered again at the next start.
    if ("problem" in got) return;
    await markOffered($, base);
    $.ui.log(
      `devcorner: this is the plugin's first run on this machine, so it began /dc login for you. ${await codeText($, got)} /dc logout stops it.`,
    );
  } catch {
    /* stay silent */
  }
}

/** "Darwin" as a person says it. */
export function osName(uname: string): string | null {
  const raw = uname.trim();
  if (!raw) return null;
  if (raw === "Darwin") return "macOS";
  if (/^(MINGW|MSYS|CYGWIN)/i.test(raw)) return "Windows";
  return raw;
}

/** What the plugin tells devcorner of this machine: its system and a name to suggest. */
async function machineOf(
  $: Engine,
): Promise<{ os: string | null; name: string | null }> {
  const run = async (argv: string[]) => {
    try {
      const done = await $.process.run(argv, { timeoutMs: 3000 });
      return done.exitCode === 0 ? done.stdout.trim() : "";
    } catch {
      return "";
    }
  };
  const os = osName(await run(["uname", "-s"]));
  // A Mac's own name ("Ann's MacBook Air") reads better than its host name.
  const name =
    (os === "macOS" ? await run(["scutil", "--get", "ComputerName"]) : "") ||
    (await run(["hostname"])).replace(/\.local$/, "");
  return { os, name: name || null };
}

/** How the row says to sign in (dc-t533): commands, since it has nothing to press. */
const SIGN_IN_HOW = " · /dc login, or ask Claude to sign it in";

/** What the row says while signed out, by why, and how to sign in. */
export function signedOutText(s: SignIn & { step: "out" }): string {
  switch (s.why) {
    case "denied":
      return `devcorner · sign-in was denied on the page${SIGN_IN_HOW}`;
    case "expired":
      return `devcorner · the code expired before it was approved${SIGN_IN_HOW}`;
    case "revoked":
      return `devcorner · this machine was signed out${SIGN_IN_HOW}`;
    case "failed":
      return `devcorner · could not sign in: ${s.detail ?? "devcorner did not answer"}${SIGN_IN_HOW}`;
    default:
      return `devcorner · not signed in${SIGN_IN_HOW}`;
  }
}

/** A page address as the row shows it: no scheme. */
export const shownAddress = (url: string) => url.replace(/^https?:\/\//, "");

/**
 * A code devcorner gave this machine (RFC 8628 §3.2), kept in the store
 * (`codeKey`) so every conversation, and a reload, uses the same one until it
 * runs out. Its secret, `device_code`, never leaves the store and the polls.
 */
type KeptCode = {
  device_code: string;
  /** The public code a person or an agent approves, "KQ4F-9XZT". */
  user_code: string;
  page: string;
  link: string;
  expiresAt: number;
  /** Seconds between polls. */
  interval: number;
};

/** The store's key for the code devcorner at `base` gave. */
export const codeKey = (base: string) => `device:${base}`;

/** A code is asked for again when it has less than this left, so an approval never races its end. */
const CODE_MARGIN_MS = 60_000;

/** The code the store keeps for this devcorner while it has not run out, or null. */
async function keptCode($: Engine, base: string): Promise<KeptCode | null> {
  const v = (await $.store.get(codeKey(base))) as Partial<KeptCode> | undefined;
  if (
    !v ||
    typeof v.device_code !== "string" ||
    typeof v.user_code !== "string" ||
    typeof v.page !== "string" ||
    typeof v.link !== "string" ||
    typeof v.expiresAt !== "number" ||
    typeof v.interval !== "number"
  ) {
    return null;
  }
  return v.expiresAt > (await $.clock.now()) ? (v as KeptCode) : null;
}

/** Forgets the code. */
async function forgetCode($: Engine, base: string): Promise<void> {
  await $.store.delete(codeKey(base));
}

/**
 * The code to sign in with: the kept one while it has a minute left, so
 * every conversation of this machine shows the same, else a new one
 * devcorner gives, kept. What went wrong, for the row and /dc, when there is
 * none. Asked for only when a sign-in begins (/dc login, an agent's
 * connect_plugin), never in the background.
 */
async function codeFor($: Engine): Promise<KeptCode | { problem: string }> {
  const base = await baseOf($);
  const kept = await keptCode($, base);
  const now = await $.clock.now();
  if (kept && kept.expiresAt - now > CODE_MARGIN_MS) return kept;
  try {
    const machine = await machineOf($);
    const res = await $.http.fetch(`${base}/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code plugin",
        ...(machine.os ? { os: machine.os } : {}),
        ...(machine.name ? { name: machine.name } : {}),
      }),
    });
    const body = readDeviceCode(res.ok ? res.text : "");
    if (!body) {
      return { problem: `devcorner at ${base} answered HTTP ${res.status}` };
    }
    const code: KeptCode = {
      device_code: body.device_code,
      user_code: body.user_code,
      page: body.verification_uri,
      link: body.verification_uri_complete,
      expiresAt: (await $.clock.now()) + body.expires_in * 1000,
      interval: body.interval,
    };
    await $.store.set(codeKey(base), code);
    return code;
  } catch {
    return { problem: `devcorner at ${base} could not be reached` };
  }
}

/** The sign-in under way, so a newer one, a cancel or a sign-in that landed makes an older poll count for nothing. */
let flow = 0;
/** The next poll. */
let signInTimer: Timer | undefined;
/**
 * Whether the row shows a code now and polls at its interval (/dc login,
 * an agent's connect_plugin). `signIn` in $.state outlives a reload, which forgets the poll; a
 * row left showing a code by a module that no longer polls is taken up
 * again or signed out at the next read (`noteSignedOut`).
 */
let signingIn = false;
/** The code the row shows, which a shown sign-in polls, whatever the store holds now. */
let shownCode: KeptCode | undefined;
/**
 * A poll on its way: one at a time, since devcorner refuses a code polled
 * again once taken, and a second poll in flight would only be refused.
 */
let polling = false;
/**
 * When the shown code was last polled, so the poll an approval asks for at
 * once keeps to the interval: sooner, devcorner answers slow_down.
 */
let polledAt = 0;

async function setSignIn($: Engine, value: SignIn | null): Promise<void> {
  await update($, signIn, () => value);
  $.ui.invalidate("ui.render");
}

/** Ends the asking under way, if any: its poll stops. The code stays kept. */
function endFlow(): void {
  flow++;
  signInTimer?.cancel();
  signInTimer = undefined;
  signingIn = false;
  shownCode = undefined;
  polledAt = 0;
}

/** The row's step while it shows `code`. */
const codeStep = (code: KeptCode): SignIn => ({
  step: "code",
  code: code.user_code,
  page: code.page,
  link: code.link,
  expiresAt: code.expiresAt,
});

/** Whether this is a cloud session: Claude Code sets CLAUDE_CODE_REMOTE there. */
async function inCloud($: Engine): Promise<boolean> {
  return Boolean(await $.env.get("CLAUDE_CODE_REMOTE"));
}

/** Why this machine takes no sign-in (`noSignIn`). */
type NoSignIn = "env" | "in" | "cloud";

/**
 * Why this machine takes no sign-in, or null when it may: DEVCORNER_TOKEN
 * wins, a kept token is in already, and a cloud session is never signed in,
 * since its store ends with the container and would leave a grant for each
 * container on the connections page.
 */
async function noSignIn($: Engine): Promise<NoSignIn | null> {
  const held = await tokenOf($).catch(() => null);
  if (held) return held.from === "env" ? "env" : "in";
  return (await inCloud($)) ? "cloud" : null;
}

/** What /dc login says for each `NoSignIn`. */
const NO_SIGN_IN: Record<NoSignIn, string> = {
  env: "This Claude Code has DEVCORNER_TOKEN in its environment, which wins over a sign-in here. Remove it from your shell or from env in ~/.claude/settings.json first, then /dc login.",
  in: "This machine is signed in to devcorner already. /dc says as whom; /dc logout signs it out.",
  cloud:
    "This is a cloud session, whose plugin is never signed in: its store ends with the container. It reaches devcorner through its own connection.",
};

/** What an agent's connect_plugin is told for each `NoSignIn`. */
const AGENT_NO_SIGN_IN: Record<NoSignIn, string> = {
  env: "This machine's devcorner plugin uses DEVCORNER_TOKEN from its environment, so it has nothing to sign in.",
  in: "This machine's devcorner plugin is signed in already; /dc says as whom.",
  cloud:
    "This is a cloud session: its devcorner plugin is never signed in, since its store ends with the container.",
};

/**
 * Shows a code and asks at its interval whether it was approved: the code,
 * or what went wrong, which the row says too.
 */
async function showCode($: Engine): Promise<KeptCode | { problem: string }> {
  endFlow();
  const mine = flow;
  signingIn = true;
  await setSignIn($, { step: "asking" });
  const got = await codeFor($);
  if (mine !== flow) return { problem: "a newer sign-in took over" };
  if ("problem" in got) {
    endFlow();
    await setSignIn($, { step: "out", why: "failed", detail: got.problem });
    return got;
  }
  shownCode = got;
  await setSignIn($, codeStep(got));
  pollIn($, mine, got.interval * 1000);
  return got;
}

/** /dc login: a code shown, and what /dc login says of it. */
async function startSignIn($: Engine): Promise<string> {
  const no = await noSignIn($);
  if (no) return NO_SIGN_IN[no];
  const got = await showCode($);
  if ("problem" in got) return `Could not sign in: ${got.problem}.`;
  return codeText($, got);
}

/** What a sign-in says of the code it shows: where to approve it, and how long it lasts. */
async function codeText($: Engine, got: KeptCode): Promise<string> {
  const minutes = Math.max(
    1,
    Math.round((got.expiresAt - (await $.clock.now())) / 60_000),
  );
  return `Open ${got.link}\nand approve the code ${got.user_code}, or ask Claude to sign the devcorner plugin in: it approves that code through its own devcorner connection. The code lasts ${minutes} more minutes; the row above the prompt says when this machine is signed in.`;
}

/** A code as devcorner reads it: capitals, no spaces or hyphens. */
const sameCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

/**
 * The code an agent's `connect_plugin` sends (the user's decision dc-c381):
 * always this machine's own. The one the row shows, or a new one shown now,
 * so the person sees the code their yes is on. A code the agent names that
 * is not it is refused: one read anywhere else, as from a prompt injection,
 * would sign in whoever asked for it. A refusal is for the agent to read.
 */
async function agentCode(
  $: Engine,
  given: unknown,
): Promise<{ code: KeptCode; flow: number } | { deny: string }> {
  const elsewhere = `Another machine's code is approved in a browser at ${await baseOf($)}/device. Nothing was sent to devcorner.`;
  const no = await noSignIn($);
  if (no) return { deny: `${AGENT_NO_SIGN_IN[no]} ${elsewhere}` };
  const now = await $.clock.now();
  const shown =
    signingIn && shownCode && shownCode.expiresAt > now ? shownCode : null;
  const typed = typeof given === "string" ? given.trim() : "";
  if (typed && (!shown || sameCode(typed) !== sameCode(shown.user_code))) {
    return {
      deny: `${typed} is not the code this machine's devcorner plugin shows, and the plugin sends only its own. Call connect_plugin again without device to sign this machine in. ${elsewhere}`,
    };
  }
  // The code the person named is the one sent; with none named, one about
  // to run out is shown anew, so an approval never races its end.
  const code =
    shown && (typed || shown.expiresAt - now > CODE_MARGIN_MS)
      ? shown
      : await showCode($);
  if ("problem" in code) {
    return {
      deny: `This machine's devcorner plugin could not get a sign-in code: ${code.problem}. Nothing was sent to devcorner.`,
    };
  }
  return { code, flow };
}

/** What devcorner gave for a code (RFC 8628 §3.2), or null for anything else. */
export function readDeviceCode(text: string): {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
} | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const page = String(v.verification_uri ?? "");
    const link = String(v.verification_uri_complete ?? "");
    if (
      typeof v.device_code !== "string" ||
      typeof v.user_code !== "string" ||
      !/^https?:\/\//.test(page) ||
      !link.startsWith(page) ||
      typeof v.expires_in !== "number" ||
      v.expires_in <= 0
    ) {
      return null;
    }
    const interval =
      typeof v.interval === "number" && v.interval > 0 ? v.interval : 5;
    return {
      device_code: v.device_code,
      user_code: v.user_code,
      verification_uri: page,
      verification_uri_complete: link,
      expires_in: v.expires_in,
      interval,
    };
  } catch {
    return null;
  }
}

function pollIn($: Engine, mine: number, ms: number): void {
  signInTimer?.cancel();
  signInTimer = $.clock.after(ms, () => void pollSignIn($, mine, ms));
}

/**
 * One poll (RFC 8628 §3.4) of the code the row shows: waiting goes on at
 * the interval, slow_down waits longer, and the token, once given, is kept
 * whatever happened meanwhile, and the row is devcorner's own line again.
 * The code's end says why on the row: denied, run out or refused; and when
 * another conversation of this machine took the token meanwhile, the row is
 * simply signed in. A poll that could not reach devcorner tries again at the
 * interval until the code runs out.
 */
async function pollSignIn($: Engine, mine: number, ms: number): Promise<void> {
  signInTimer = undefined;
  if (mine !== flow || polling) return;
  polling = true;
  try {
    const base = await baseOf($);
    const now = await $.clock.now();
    const code = shownCode && shownCode.expiresAt > now ? shownCode : null;
    if (!code) {
      endFlow();
      await setSignIn($, { step: "out", why: "expired" });
      return;
    }
    const interval = Math.max(ms, code.interval * 1000);
    const again = (wait: number) => {
      if (mine === flow) pollIn($, mine, wait);
    };
    let res: {
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      text: string;
    };
    try {
      polledAt = now;
      res = await $.http.fetch(`${base}/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: code.device_code,
        }),
      });
    } catch {
      again(interval);
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      /* an answer that is not JSON is waited out like a failure */
    }
    // A token is kept whatever happened meanwhile: devcorner gives it once.
    if (
      res.ok &&
      typeof body.access_token === "string" &&
      hookTokenShape.test(body.access_token)
    ) {
      endFlow();
      await keepToken($, body.access_token);
      await forgetCode($, base);
      await setSignIn($, null);
      const name = typeof body.name === "string" ? body.name : "this machine";
      $.ui.toast(`dc: signed in on ${name}`);
      // The row and the idle asking start as at a session's start.
      void refresh($, true).then((got) => startAsking($, got));
      return;
    }
    if (mine !== flow) return;
    /**
     * The code is over: forgotten, and the row says why, unless another
     * conversation of this machine took its token meanwhile.
     */
    const over = async (said: SignIn & { step: "out" }) => {
      endFlow();
      await forgetCode($, base);
      if (await tokenOf($)) {
        await setSignIn($, null);
        void refresh($, true).then((got) => startAsking($, got));
        return;
      }
      await setSignIn($, said);
    };
    if (res.ok) {
      await over({
        step: "out",
        why: "failed",
        detail: "devcorner gave a token this plugin does not know",
      });
      return;
    }
    switch (body.error) {
      case "authorization_pending":
        again(interval);
        return;
      case "slow_down": {
        const told = Number(body.interval);
        again(
          Number.isFinite(told) && told > 0 ? told * 1000 : interval + 5000,
        );
        return;
      }
      case "access_denied":
        await over({ step: "out", why: "denied" });
        return;
      case "expired_token":
        await over({ step: "out", why: "expired" });
        return;
      case "invalid_grant":
        await over({
          step: "out",
          why: "failed",
          detail:
            "the code was used already, or devcorner no longer knows it; sign in again",
        });
        return;
      default: {
        // Updating after a deploy, limited, or failing: asked again after
        // the wait devcorner named, never sooner than the interval.
        const told = Number(res.headers["retry-after"]);
        const limited =
          res.status === 429 && Number.isFinite(told) && told > 0
            ? told * 1000
            : 0;
        again(Math.max(interval, updatingFor(res) ?? 0, limited));
      }
    }
  } catch {
    /* stay silent: the code runs out and says so at the next poll */
    if (mine === flow) {
      pollIn($, mine, Math.max(ms, (shownCode?.interval ?? 5) * 1000));
    }
  } finally {
    polling = false;
  }
}

/**
 * Signs this machine out (/dc logout): devcorner revokes its token, as the
 * connections page would, and the plugin forgets it. A token from the
 * environment is not the plugin's to forget. With none, it stops a sign-in
 * under way (dc-t533: the row has nothing to press), the code kept for the
 * next sign-in while it lasts.
 */
async function signOut($: Engine): Promise<string> {
  const held = await tokenOf($);
  const base = await baseOf($);
  if (!held) {
    if (await inCloud($)) {
      return "This is a cloud session, whose plugin is never signed in.";
    }
    // Signed out on purpose: no start begins a sign-in by itself (dc-t576).
    await markOffered($, base);
    const at = await read($, signIn);
    const stopped = at?.step === "asking" || at?.step === "code";
    endFlow();
    await setSignIn($, { step: "out" });
    return stopped
      ? "Stopped signing in: this machine is not signed in to devcorner. /dc login signs it in."
      : "This machine is not signed in to devcorner. /dc login signs it in.";
  }
  if (held.from === "env") {
    return `This Claude Code uses DEVCORNER_TOKEN from its environment, which the plugin does not keep. Remove it from your shell or from env in ~/.claude/settings.json, and revoke it on ${base}/settings/connections.`;
  }
  let said =
    "devcorner could not be reached, so revoke this machine on its connections page";
  try {
    const res = await $.http.fetch(`${base}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${held.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hook_event_name: "SignOut" }),
    });
    // Only devcorner's own word counts: an older one, which knows no
    // SignOut, answers 204 and revokes nothing.
    let revoked: unknown;
    try {
      revoked = (JSON.parse(res.text) as { revoked?: unknown }).revoked;
    } catch {
      revoked = undefined;
    }
    said =
      res.ok && revoked === true
        ? "devcorner revoked this machine's token"
        : res.status === 401 || (res.ok && revoked === false)
          ? "devcorner had revoked this machine's token already"
          : `devcorner did not say it revoked it (HTTP ${res.status}), so revoke this machine on ${base}/settings/connections`;
  } catch {
    said = `devcorner could not be reached, so revoke this machine on ${base}/settings/connections`;
  }
  await forgetToken($, held.token);
  await markOffered($, base);
  stopAsking();
  stopFresh();
  stopListening();
  await update($, status, () => null);
  await setSignIn($, { step: "out" });
  return `Signed out: ${said}, and the plugin forgot it. /dc login signs in again.`;
}

/**
 * What a read found of the token: none, or one devcorner revoked, which is
 * forgotten. The row says how to sign in (/dc login, or ask Claude), saying why
 * when it knows, unless a sign-in is under way, which says what it is doing
 * itself. A code the row
 * still shows from before a reload is taken up again while it lasts. No
 * code is asked for here: only a sign-in someone began asks for one. A cloud
 * session offers none (`noSignIn`).
 */
async function noteSignedOut(
  $: Engine,
  why: "none" | "revoked",
  refused?: string,
): Promise<void> {
  if (why === "revoked") {
    await forgetToken($, refused);
    // Another conversation kept a newer token meanwhile: this one is in.
    if (await tokenOf($)) return;
  }
  await update($, status, () => null);
  if (await inCloud($)) return;
  const at = await read($, signIn);
  if ((at?.step === "asking" || at?.step === "code") && signingIn) return;
  if (at?.step === "code") {
    const code = await keptCode($, await baseOf($));
    if (code && code.user_code === at.code) {
      endFlow();
      signingIn = true;
      shownCode = code;
      pollIn($, flow, code.interval * 1000);
      return;
    }
  }
  // A sign-in that ended badly keeps saying why until the next one.
  if (!(why === "none" && at?.step === "out")) {
    await setSignIn(
      $,
      why === "revoked" ? { step: "out", why } : { step: "out" },
    );
  }
}

/** Who the token stands for, as /dc's first line says it; null when devcorner does not say. */
async function whoLine($: Engine, held: Token): Promise<string | null> {
  try {
    const res = await $.http.fetch(`${await baseOf($)}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${held.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hook_event_name: "Who" }),
    });
    if (!res.ok) return null;
    return whoText(JSON.parse(res.text), held.from);
  } catch {
    return null;
  }
}

/** "signed in: Ann (ann@example.com) on Ann's laptop, with a code from this machine". */
export function whoText(
  who: {
    person?: { name?: string | null; email?: string | null; id?: string };
    connection?: {
      name?: string;
      kind?: string;
      machine?: { client?: string; os?: string | null } | null;
    } | null;
  },
  from: "env" | "store",
): string | null {
  const person = who.person?.name ?? who.person?.email ?? who.person?.id;
  if (!person) return null;
  const email =
    who.person?.email && who.person.email !== person
      ? ` (${who.person.email})`
      : "";
  const connection = who.connection;
  const how =
    from === "env"
      ? "with DEVCORNER_TOKEN from the environment"
      : "signed in from this machine with /dc login";
  return connection?.name
    ? `signed in: ${person}${email} on ${connection.name}, ${how}`
    : `signed in: ${person}${email}, ${how}`;
}

/** What /dc send says when it is not given both a target and words (dc-t312). */
export const SEND_USAGE =
  "Usage: /dc send <to> <text>. <to> is a conversation of yours (me-h3), a session of yours in any project (me-s4, acme-s4; /dc sessions lists them), mine (your other live conversations), or a list with commas (me-h3,me-h5). Your words go as yours, typed here, and an idle conversation wakes for them. A paste's id alone as the text (me-p4) sends that paste.";

/**
 * /dc send's words, read (dc-t312): first where to, a target or a list with
 * commas (a space after a comma is taken as part of the list), then the
 * text. Null when either is missing.
 */
function readSend(words: string): { to: string; text: string } | null {
  const found = /^((?:[^\s,]+\s*,\s*)*[^\s,]+)\s+([\s\S]*\S)\s*$/.exec(
    words.trim(),
  );
  return found ? { to: found[1]!.replace(/\s+/g, ""), text: found[2]! } : null;
}

/**
 * What /dc send posts as Send (dc-t312): its target and its words, or, when
 * the words are a paste's id alone (dc-p4), that paste, which devcorner
 * sends as the person's own (part 6).
 */
export function sendBody(read: {
  to: string;
  text: string;
}): { to: string; text: string } | { to: string; paste: string } {
  return PASTE_ID.test(read.text)
    ? { to: read.to, paste: read.text.toLowerCase() }
    : read;
}

/** Where one target stands, as devcorner's Send answers it. */
interface SentTo {
  id?: unknown;
  /** A conversation's name (dc-t312, part 5); absent from an older devcorner. */
  name?: unknown;
  session?: unknown;
  state?: unknown;
  /**
   * False for a conversation your word does not wake now: one devcorner
   * opened for an MCP connection or its chat (dc-t312, part 2), which has no
   * hooks, and, from a devcorner that sends `reach` (dc-t610), a cloud
   * session's or a window gone quiet. Absent for a session, and from an
   * older devcorner.
   */
  wakes?: unknown;
  /**
   * Why it does not wake and when it reads the message instead, in
   * devcorner's words (dc-t610, `wakeWords`), as "no wake: a cloud session,
   * read at its next devcorner call". Absent from an older devcorner.
   */
  reach?: unknown;
}

/** One target's place in /dc send's answer: "dc-h2 (reviewer): queued, no session yet". */
function sentToText(to: SentTo): string {
  const id = `${String(to.id ?? "")}${typeof to.name === "string" && to.name ? ` (${to.name})` : ""}`;
  if (to.wakes === false) {
    return typeof to.reach === "string" && to.reach
      ? `${id}: ${to.reach}`
      : `${id}: read at its next call; it cannot be woken`;
  }
  if (to.state === "queued") return `${id}: queued, no session yet`;
  return typeof to.session === "string" && to.session !== id
    ? `${id}: for ${to.session} at its next hook event`
    : `${id}: at its next hook event`;
}

/**
 * What /dc send answers (dc-t312), from devcorner's answer to Send: what was
 * sent and where each target stands, or why nothing was sent. An older
 * devcorner knows no Send, and answers 204.
 */
function sentText(status: number, body: unknown): string {
  const answer = (body ?? {}) as {
    ok?: unknown;
    messages?: unknown;
    to?: unknown;
    error?: unknown;
  };
  if (status === 200 && answer.ok === true) {
    const messages = Array.isArray(answer.messages)
      ? answer.messages.map(String)
      : [];
    const to = Array.isArray(answer.to) ? (answer.to as SentTo[]) : [];
    // Only a conversation with hooks wakes (dc-t312, part 2).
    const wake =
      to.length > 0 && to.every((t) => t.wakes === false)
        ? ""
        : " An idle conversation wakes for it now; a busy one is handed it at its next hook event.";
    return `Sent ${messages.join(", ") || "it"} to ${to.map(sentToText).join("; ") || "devcorner"}.${wake}`;
  }
  if (status === 204 || status === 404) {
    return "This devcorner does not take /dc send yet, so nothing was sent.";
  }
  if (status === 429) {
    return "devcorner did not send it: that is more sends than a minute allows. Nothing was sent; try again shortly.";
  }
  const why = typeof answer.error === "string" ? answer.error : null;
  return why
    ? `devcorner did not send it: ${why}`
    : `devcorner did not send it (HTTP ${status}), so nothing was sent.`;
}

/**
 * /dc send (dc-t312): the person's own words, typed in this conversation,
 * for others of theirs, posted as the hook route's Send with this machine's
 * token, so devcorner reads them as the person's and an idle conversation
 * they are for wakes. The model sees none of it: the command answers itself.
 */
async function sendAsYou($: Engine, words: string): Promise<string> {
  const read = readSend(words);
  if (!read) return SEND_USAGE;
  const posted = await postAsYou(
    $,
    { hook_event_name: "Send", ...sendBody(read) },
    { command: "/dc send", nothing: "nothing was sent" },
  );
  return typeof posted === "string"
    ? posted
    : sentText(posted.status, posted.body);
}

/** How long devcorner holds the person's ask for its answer (dc-t611, `ASK_HOLD_MS`), as /dc ask says it. */
const ASK_HOLD_HOURS = 24;

/** What /dc ask says when it is not given one target and a task (dc-t611). */
export const ASK_USAGE = `Usage: /dc ask <to> <task>. <to> is one session of yours in any project (me-s4, acme-s4; /dc sessions lists them) or one conversation of yours (me-h3, or its name). Your words go as yours, typed here, and wake it if it is idle; its answer comes back to this window and wakes it, in whatever turn it is sent, within ${ASK_HOLD_HOURS} h. /dc send reaches a list.`;

/** /dc ask's words, read (dc-t611): one target, then the task. Null when either is missing, or the target is a list. */
function readAsk(words: string): { to: string; text: string } | null {
  const found = /^([^\s,]+)\s+([\s\S]*\S)\s*$/.exec(words.trim());
  return found ? { to: found[1]!, text: found[2]! } : null;
}

/**
 * What /dc ask answers (dc-t611), from devcorner's answer to Send: what was
 * asked of whom and where it stands, and that its answer comes back here;
 * or why nothing was asked. A devcorner that does not say `ask` took it as
 * a plain /dc send, whose reply wakes this window only in the turn it woke.
 */
function askedText(status: number, body: unknown): string {
  const answer = (body ?? {}) as {
    ok?: unknown;
    ask?: unknown;
    messages?: unknown;
    to?: unknown;
    error?: unknown;
  };
  if (status === 200 && answer.ok === true) {
    const messages = Array.isArray(answer.messages)
      ? answer.messages.map(String)
      : [];
    const to = Array.isArray(answer.to) ? (answer.to as SentTo[]) : [];
    const where = to.map(sentToText).join("; ") || "devcorner";
    if (answer.ask !== true) {
      return `Sent ${messages.join(", ") || "it"} to ${where}, as a plain /dc send: this devcorner does not take /dc ask yet, so a reply wakes this window only if it comes in the turn your words woke.`;
    }
    const wake =
      to.length > 0 && to.every((t) => t.wakes === false)
        ? ""
        : " An idle one wakes for it now; a busy one is handed it at its next hook event.";
    return `Asked ${messages.join(", ") || "it"} of ${where}.${wake} Its answer comes back to this window and wakes it, within ${ASK_HOLD_HOURS} h.`;
  }
  if (status === 204 || status === 404) {
    return "This devcorner does not take /dc ask yet, so nothing was asked.";
  }
  if (status === 429) {
    return "devcorner did not ask it: that is more sends than a minute allows. Nothing was asked; try again shortly.";
  }
  const why = typeof answer.error === "string" ? answer.error : null;
  return why
    ? `devcorner did not ask it: ${why}`
    : `devcorner did not ask it (HTTP ${status}), so nothing was asked.`;
}

/**
 * /dc ask (dc-t611): the person's own words, typed in this conversation,
 * asking one session or conversation of theirs to do something (test,
 * verify, …) and answer, posted as the hook route's Send with `ask`, so
 * devcorner reads them as the person's, wakes it if it is idle, and wakes
 * this window with its answer when it comes. The model sees none of it: the
 * command answers itself.
 */
async function askAsYou($: Engine, words: string): Promise<string> {
  const read = readAsk(words);
  if (!read) return ASK_USAGE;
  const posted = await postAsYou(
    $,
    { hook_event_name: "Send", ...read, ask: true },
    { command: "/dc ask", nothing: "nothing was asked" },
  );
  return typeof posted === "string"
    ? posted
    : askedText(posted.status, posted.body);
}

/**
 * Posts one of the person's own hook events (Send, Name, dc-t312) for this
 * conversation with this machine's token: devcorner's answer, or what the
 * command says when none came (not signed in, updating, unreachable).
 */
async function postAsYou(
  $: Engine,
  event: Record<string, unknown>,
  words: { command: string; nothing: string },
): Promise<{ status: number; body: unknown } | string> {
  const held = await tokenOf($);
  if (!held) {
    return (await inCloud($))
      ? `This is a cloud session, whose plugin is never signed in, so ${words.command} cannot act for you here.`
      : `This machine is not signed in to devcorner, so ${words.nothing}. /dc login signs it in.`;
  }
  try {
    const res = await postEvent($, held.token, event);
    if (updatingFor(res) !== null) {
      return `${UPDATING_LINE} ${words.nothing.charAt(0).toUpperCase()}${words.nothing.slice(1)}.`;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return `devcorner could not be reached, so ${words.nothing}.`;
  }
}

/** Posts a hook event of this conversation's with `token`, as the module's own events (Send, Name, Turn) go. */
async function postEvent(
  $: Engine,
  token: string,
  event: Record<string, unknown>,
) {
  return $.http.fetch(`${await baseOf($)}/mcp/hooks/claude-code`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...event, session_id: await $.session.id() }),
  });
}

/**
 * Who started a turn, as `Turn` says it (dc-t312): the plugin's wake, for the
 * message its prompt was submitted for; the harness, for a prompt Claude Code
 * or another plugin made (`turnWords`), which is no turn the person typed and
 * so never starts the hour's wakes over; else the person, by typing or by
 * `/dc <words>`, which are their own words. Only a message id is sent.
 */
export type TurnBy =
  | { by: "wake"; for: string }
  | { by: "person" }
  | { by: "harness" };

/** The plugin's wake as a turn's `TurnBy`, for the message its prompt was submitted for; null when no wake started it. */
export function wakeBy(
  wakingFor: string | null,
): { by: "wake"; for: string } | null {
  return wakingFor !== null && MESSAGE.test(wakingFor)
    ? { by: "wake", for: wakingFor }
    : null;
}

/**
 * Tells devcorner who started this conversation's turn (dc-t312), the hook
 * route's `Turn`, with this machine's token: a relay its agent sends counts
 * its chain of wakes from it, and a typed turn clears a paused chain, which
 * the row then stops saying. Silent: a machine not signed in, a cloud
 * session or a devcorner that does not answer sends nothing more, and its
 * relays count as from a turn devcorner cannot place; so does a harness's
 * turn told to an older devcorner, which knows no `harness` and refuses it.
 */
async function postTurn($: Engine, turnId: string, by: TurnBy): Promise<void> {
  try {
    const held = await tokenOf($);
    if (!held) return;
    const res = await postEvent($, held.token, {
      hook_event_name: "Turn",
      turn_id: turnId,
      ...by,
    });
    if (res.status !== 200) return;
    const answer = JSON.parse(res.text) as { cleared?: unknown };
    if (Array.isArray(answer.cleared) && answer.cleared.length > 0) {
      await refresh($, true);
    }
  } catch {
    /* stay silent */
  }
}

/**
 * What /dc name answers (dc-t312, part 5), from devcorner's answer to Name:
 * the conversation's name now, or why it was not named. An older devcorner
 * knows no Name, and answers 204.
 */
function namedText(status: number, body: unknown): string {
  const answer = (body ?? {}) as {
    ok?: unknown;
    conversation?: unknown;
    name?: unknown;
    error?: unknown;
  };
  if (status === 200 && answer.ok === true) {
    const id = String(answer.conversation ?? "This conversation");
    return typeof answer.name === "string" && answer.name
      ? `This conversation, ${id}, is ${answer.name} now: /dc send ${answer.name} and message(to: "${answer.name}") reach it while it is live.`
      : `This conversation, ${id}, has no name now.`;
  }
  if (status === 204 || status === 404) {
    return "This devcorner does not take /dc name yet, so nothing was named.";
  }
  const why = typeof answer.error === "string" ? answer.error : null;
  return why
    ? `devcorner did not name it: ${why}`
    : `devcorner did not name it (HTTP ${status}), so nothing was named.`;
}

/**
 * /dc name (dc-t312, part 5): names this conversation, the person's word,
 * posted as the hook route's Name, so a message's `to` and /dc send reach it
 * by the name while it is live; with no word it clears the name. The row
 * reads the status again to show it.
 */
async function nameHere($: Engine, words: string): Promise<string> {
  const name = words.trim();
  const posted = await postAsYou(
    $,
    { hook_event_name: "Name", name },
    { command: "/dc name", nothing: "nothing was named" },
  );
  if (typeof posted === "string") return posted;
  if (posted.status === 200) await refresh($, true).catch(() => undefined);
  return namedText(posted.status, posted.body);
}

/**
 * What /dc machine answers (dc-t590), from devcorner's answer to Machine:
 * the machine's name now, or why it was not renamed, with devcorner's
 * warning of another machine of the person's named the same. `renaming` is
 * whether a name was given. An older devcorner knows no Machine, and
 * answers 204.
 */
export function machineText(
  status: number,
  body: unknown,
  renaming: boolean,
): string {
  const answer = (body ?? {}) as {
    ok?: unknown;
    renamed?: unknown;
    name?: unknown;
    from?: unknown;
    warning?: unknown;
    error?: unknown;
  };
  if (status === 200 && answer.ok === true) {
    const name = typeof answer.name === "string" ? answer.name : null;
    const warning =
      typeof answer.warning === "string" && answer.warning
        ? ` ${answer.warning}`
        : "";
    if (!renaming) {
      return name
        ? `This machine is ${name} to devcorner: the line above the prompt names your windows here by it. /dc machine <name> renames it.`
        : "This machine has no name in devcorner, so the line above the prompt names no machine. /dc machine <name> names it.";
    }
    if (answer.renamed !== true) {
      return name
        ? `This machine is ${name} already. Nothing was renamed.${warning}`
        : "Nothing was renamed: the machine had that name already.";
    }
    const from =
      typeof answer.from === "string" && answer.from
        ? `, renamed from ${answer.from}`
        : "";
    // A name of devcorner's own default names no machine.
    return name
      ? `This machine is ${name} now${from}: the line above the prompt names your windows here by it, and your connections page lists it so.${warning}`
      : `Renamed${from ? ` from ${String(answer.from)}` : ""} to a name devcorner gives a machine with none, so the line above the prompt names no machine now. /dc machine <name> names it.`;
  }
  if (status === 204 || status === 404) {
    return "This devcorner does not take /dc machine yet: rename the machine on your connections page.";
  }
  const why = typeof answer.error === "string" ? answer.error : null;
  return why
    ? `devcorner did not ${renaming ? "rename it" : "say its name"}: ${why}`
    : `devcorner did not ${renaming ? "rename it" : "say its name"} (HTTP ${status})${renaming ? ", so nothing was renamed" : ""}.`;
}

/**
 * /dc machine (dc-t590): with a name, renames this machine, the person's
 * word, posted as the hook route's Machine with the machine's own token, as
 * its connections page would; alone, says its name. The row reads the
 * status again to show the new name in the window's label.
 */
async function machineHere($: Engine, words: string): Promise<string> {
  const name = words.trim();
  const posted = await postAsYou(
    $,
    { hook_event_name: "Machine", ...(name ? { name } : {}) },
    name
      ? { command: "/dc machine", nothing: "nothing was renamed" }
      : { command: "/dc machine", nothing: "its name could not be read" },
  );
  if (typeof posted === "string") return posted;
  if (posted.status === 200 && name) {
    await refresh($, true).catch(() => undefined);
  }
  return machineText(posted.status, posted.body, name !== "");
}

/** A paste whole, as the hook route's Paste gives it (dc-t490). */
export type PasteRead = {
  id: string;
  title: string;
  text: string;
  length: number;
  expiresAt: number;
  /** A session of this conversation wrote it. */
  here: boolean;
  page: string | null;
};

/** What reading a paste came to: the paste, none kept, or why not, in words. */
type PasteGot = { paste: PasteRead } | { none: true } | { problem: string };

/** A paste devcorner gave, when it is one this version reads; null otherwise. */
export function pasteRead(v: unknown): PasteRead | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (
    typeof p.id !== "string" ||
    !PASTE_ID.test(p.id) ||
    typeof p.title !== "string" ||
    typeof p.text !== "string"
  ) {
    return null;
  }
  return {
    id: p.id,
    title: p.title,
    text: p.text,
    length: typeof p.length === "number" ? p.length : Array.from(p.text).length,
    expiresAt: typeof p.expiresAt === "number" ? p.expiresAt : 0,
    here: p.here === true,
    page: typeof p.page === "string" ? p.page : null,
  };
}

/**
 * Reads one paste whole from devcorner (dc-t490), the hook route's Paste
 * with this machine's token: the one `id` names, else the newest this
 * conversation's sessions wrote, else the person's newest.
 */
async function readPaste($: Engine, id?: string): Promise<PasteGot> {
  const posted = await postAsYou(
    $,
    { hook_event_name: "Paste", ...(id ? { id } : {}) },
    { command: "/dc paste", nothing: "nothing was copied" },
  );
  if (typeof posted === "string") return { problem: posted };
  const answer = (posted.body ?? {}) as { paste?: unknown; error?: unknown };
  if (posted.status === 200) {
    if (answer.paste === null) return { none: true };
    const paste = pasteRead(answer.paste);
    return paste
      ? { paste }
      : {
          problem:
            "devcorner gave a paste this plugin does not understand, so nothing was copied.",
        };
  }
  if (posted.status === 204) {
    return {
      problem:
        "This devcorner does not give pastes to copy yet, so nothing was copied: open the paste's page and press Copy.",
    };
  }
  return {
    problem:
      typeof answer.error === "string"
        ? `devcorner did not give it: ${answer.error}`
        : `devcorner did not give it (HTTP ${posted.status}), so nothing was copied.`,
  };
}

/** Why a copy did not take, in words (`UiCopyResult.reason`). */
const NOT_COPIED: Record<string, string> = {
  "no-surface": "nothing draws this session",
  "no-clipboard": "this terminal took no copy",
  refused: "a plugin refused the copy",
};

/**
 * Puts a paste's text on the clipboard (dc-t490): `$.ui.copy`, which writes
 * as Claude Code's /copy does, with the machine's clipboard tool or an OSC 52
 * sequence, of the session's first surface. OSC 52 says nothing back, so a
 * terminal that drops it still reads as taken: every answer names the
 * paste's page, whose Copy button always copies.
 */
async function copyPaste(
  $: Engine,
  paste: PasteRead,
): Promise<{ copied: true } | { copied: false; why: string }> {
  const done = await $.ui.copy({ text: paste.text });
  if (!done.isCopied) {
    return { copied: false, why: NOT_COPIED[done.reason] ?? done.reason };
  }
  return { copied: true };
}

/** A title on one line, cut at a word to `max` cells (`cutAtWord`). */
const clip = (text: string, max: number) =>
  cutAtWord(oneLine(text), max) ?? "…";

/** How long ago, in a few characters: "just now", "5 min ago", "2 h ago", "3 d ago". */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** What /dc paste says when its words are not a paste's id. */
export const PASTE_USAGE =
  "Usage: /dc paste [<id>]. With no id it copies the newest paste this conversation's sessions wrote, else your newest; /dc pastes lists yours.";

/**
 * What /dc paste answers (dc-t490): the paste, and that it was copied, with
 * its page, whose Copy button copies it where the terminal took none.
 */
function pasteCopiedText(
  paste: PasteRead,
  done: { copied: true } | { copied: false; why: string },
  named: boolean,
): string {
  const whose =
    named || paste.here ? "" : " · your newest; this conversation wrote none";
  const head = `${paste.id}  ${oneLine(paste.title)} · ${sizeText(paste.length)}${whose}`;
  const page = paste.page ? `: ${paste.page}` : "";
  const how = done.copied
    ? `copied to your clipboard · if it is not there, open it and press Copy${page}`
    : `not copied here (${done.why}) · open it and press Copy${page}`;
  return `${head}\n${how} · /dc pastes lists yours`;
}

/** /dc paste [<id>] (dc-t490): reads the paste and copies it, answering in two lines. */
async function pasteHere($: Engine, words: string): Promise<string> {
  const id = words.trim();
  if (id && !PASTE_ID.test(id)) return PASTE_USAGE;
  const got = await readPaste($, id || undefined);
  if ("problem" in got) return got.problem;
  if ("none" in got) {
    return "You have no paste kept. An agent writes one for you to copy with devcorner's paste tool; each is kept 30 days.";
  }
  const done = await copyPaste($, got.paste).catch(
    (): { copied: false; why: string } => ({
      copied: false,
      why: "the copy failed",
    }),
  );
  return pasteCopiedText(got.paste, done, id !== "");
}

/** One paste as the hook route's Pastes lists it (dc-t490). */
type PasteListed = {
  id: string;
  title: string;
  length: number;
  createdAt: number;
  here: boolean;
  page: string | null;
};

/**
 * What /dc pastes answers (dc-t490), from devcorner's answer to Pastes: the
 * person's kept pastes, newest first, one a line with its size, its age
 * (given the time), whether this conversation's sessions wrote it, and its
 * page; or why not.
 */
export function pastesText(
  status: number,
  body: unknown,
  now?: number,
): string {
  if (status === 204) {
    return "This devcorner does not list pastes yet.";
  }
  const answer = (body ?? {}) as {
    pastes?: unknown;
    more?: unknown;
    error?: unknown;
  };
  if (status !== 200 || !Array.isArray(answer.pastes)) {
    return typeof answer.error === "string"
      ? `devcorner did not list them: ${answer.error}`
      : `devcorner did not list them (HTTP ${status}).`;
  }
  const listed = (answer.pastes as Partial<PasteListed>[]).filter(
    (p): p is PasteListed =>
      typeof p.id === "string" &&
      PASTE_ID.test(p.id) &&
      typeof p.title === "string",
  );
  if (listed.length === 0) {
    return "You have no paste kept. An agent writes one for you to copy with devcorner's paste tool; each is kept 30 days.";
  }
  const width = widest(listed.map((p) => p.id));
  const lines = listed.map((p) =>
    [
      `${p.id.padEnd(width)}  ${clip(p.title, 60)}`,
      sizeText(Number(p.length) || 0),
      ...(now === undefined ? [] : [agoText(Number(p.createdAt) || now, now)]),
      ...(p.here ? ["written here"] : []),
      ...(p.page ? [p.page] : []),
    ].join(" · "),
  );
  const more = Number(answer.more) > 0 ? Number(answer.more) : 0;
  return [
    "your pastes, newest first (/dc paste <id> copies one):",
    ...lines,
    ...(more > 0 ? [`and ${more} more kept`] : []),
  ].join("\n");
}

/** /dc pastes (dc-t490): the person's kept pastes, from the hook route's Pastes. */
async function listPastes($: Engine): Promise<string> {
  const posted = await postAsYou(
    $,
    { hook_event_name: "Pastes" },
    { command: "/dc pastes", nothing: "nothing was listed" },
  );
  if (typeof posted === "string") return posted;
  const now = await $.clock.now().catch(() => undefined);
  return pastesText(posted.status, posted.body, now);
}

/**
 * devcorner's paste tool, on a server named for devcorner, as `CARRIER`'s
 * tools are (dc-t490): after the session writes one, the transcript says so.
 */
export const PASTER = /^mcp__[\w-]*devcorner[\w-]*__paste$/i;

/** The line the transcript says when the session writes a paste (dc-t490). */
export function pasteNote(paste: StatusPaste): string {
  const page = paste.page ? `, or press Copy on ${paste.page}` : "";
  return `devcorner: paste ${paste.id} "${clip(paste.title, 80)}" is ready for you to copy: /dc paste copies it${page}`;
}

/**
 * The paste a paste tool call wrote (dc-t490), by the first words of its
 * reply as the model reads it, "Saved paste me-p14 …"; null when it names
 * none, as a refusal or another devcorner's wording.
 */
export function pasteWritten(text: string | undefined): string | null {
  const found = /^Saved paste ((?:me|dc)-p\d{1,12})\b/i.exec(text ?? "");
  return found ? found[1]!.toLowerCase() : null;
}

/**
 * After the session's paste tool call wrote `written` (dc-t490): reads
 * Status at once, and when it names that very paste as this conversation's
 * newest, says one line in the transcript, which the model never reads. A
 * paste Status does not name (one written as no session, or another
 * conversation's) is not said. Silent on any failure, and with no token, as
 * in a cloud session.
 */
async function notePaste($: Engine, written: string): Promise<void> {
  try {
    const got = await refresh($, true);
    const paste = got?.status?.paste;
    if (paste?.id.toLowerCase() === written) $.ui.log(pasteNote(paste));
  } catch {
    /* stay silent */
  }
}

/**
 * devcorner's start and finish tools, on a server named for devcorner, as
 * `CARRIER`'s are (dc-t588): the session the main conversation's start
 * returned is the one this window states it runs as, until its finish.
 */
export const STARTER = /^mcp__[\w-]*devcorner[\w-]*__start$/i;
export const FINISHER = /^mcp__[\w-]*devcorner[\w-]*__finish$/i;

/**
 * The session a start's reply says it started or carried on as, by its first
 * line as the model reads it, "devcorner · session acm-s4 · …" (dc-t588);
 * null for a child's, whose line ends " · child of acm-s3" (then its role,
 * " · review", when it has one), which is never the window's, and for a
 * reply that names none, as a refusal or another devcorner's wording. The
 * end is read, not the whole line, since a ticket's quoted title may say
 * anything.
 */
export function startedSession(text: string | undefined): string | null {
  const line = /^devcorner · session (\S+) · .*$/m.exec(text ?? "");
  if (!line || CHILD_END.test(line[0])) return null;
  const id = line[1]!;
  return CLAIMED.test(id) ? id : null;
}

/** A conversation's id as devcorner shows it: me-h3. */
const WINDOW_ID = /^[a-z][a-z0-9]*-h\d{1,12}$/i;

/**
 * The main conversation's start as this window sends it (dc-t610): naming
 * this window, as devcorner's fresh status read gives it
 * (`thisConversation`), as its `harness`, in place of what the model passed
 * or left out. A window's agent that started with no harness, or another
 * conversation's, worked as its session in a second conversation devcorner
 * opened for its MCP connection, which no hook, held request or typed turn
 * reaches, so its mail and relays went where nothing could wake it. A start
 * that names a parent is a child's, sent as it is, and so is any start
 * while devcorner names no conversation for this window.
 */
async function inThisWindow<E>($: Engine, e: E): Promise<E> {
  const parent = (e as { parent?: unknown }).parent;
  if (typeof parent === "string" && parent.trim()) return e;
  try {
    const here = (await refresh($, true))?.status?.thisConversation?.id;
    return typeof here === "string" && WINDOW_ID.test(here)
      ? { ...e, harness: here }
      : e;
  } catch {
    return e;
  }
}

/** How a child's start line ends: its parent, then its role when it has one. */
const CHILD_END =
  / · child of [a-z][a-z0-9]*-s\d{1,12}(?:@[a-z0-9-]{1,64})?(?: · [^·]+)?$/i;

/** A session's id as devcorner shows it: me-s4, acm-s4, dc-s4@acme. */
const CLAIMED = /^[a-z][a-z0-9]*-s\d{1,12}(?:@[a-z0-9-]{1,64})?$/i;

/**
 * Where the session this conversation states it runs as is kept (dc-t588):
 * beside the markers, named from the same variables (`claims` in
 * hooks/devcorner.sh, which sends it with a SessionStart), so a reload of
 * the module, a resume and a compaction state it too. Undefined with no
 * home to keep it in, or an id the hook would not read.
 */
export function claimFile(id: string, env: StateEnv): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const base = stateDir(env);
  return base ? `${base}/claims/${id}.claim` : undefined;
}

/** The session this conversation states it runs as, once read or kept: for which conversation, and null for none. */
let claim: { id: string; session: string | null } | undefined;

/**
 * The session this conversation states it runs as (dc-t588): the one its
 * main conversation's last `start` returned, kept by `keepClaim`, read back
 * from its file once a load; null for none. Never throws.
 */
async function claimOf($: Engine): Promise<string | null> {
  try {
    const id = await $.session.id();
    if (claim?.id === id) return claim.session;
    const file = claimFile(id, await stateEnvOf($));
    // A read that fails is not kept as none: the next one reads again.
    const there =
      file && (await $.fs.exists(file))
        ? String(await $.fs.read(file)).trim()
        : "";
    claim = { id, session: CLAIMED.test(there) ? there : null };
    return claim.session;
  } catch {
    return null;
  }
}

/**
 * Keeps `session` as the one this conversation states it runs as, or forgets
 * it with null (dc-t588): in the module, and in its file for the hooks and a
 * later load. Either way the claim is no longer one taken from a call
 * (`fromCalls.taken`). Silent on any failure: the module still holds it.
 */
async function keepClaim($: Engine, session: string | null): Promise<void> {
  try {
    const id = await $.session.id();
    claim = { id, session };
    // A claim kept anew is one devcorner has yet to take.
    claimTaken = undefined;
    if (fromCalls?.id === id) fromCalls.taken = null;
    const file = claimFile(id, await stateEnvOf($));
    if (!file) return;
    if (session !== null) await writePrivate($, file, `${session}\n`);
    else await $.process.run(["rm", "-f", file], { timeoutMs: 5000 });
  } catch {
    /* stay silent */
  }
}

/**
 * What a finish of the main conversation's means to its claim (dc-t588):
 * one that names no session, or the claimed one, ends it, and the window
 * states none until its next start; one that names another session, as a
 * child's finish its coordinator makes for it, leaves it.
 */
async function finishedHere($: Engine, named: unknown): Promise<void> {
  const kept = await claimOf($);
  if (kept === null) return;
  if (
    named === undefined ||
    named === null ||
    (typeof named === "string" &&
      (!named.trim() || named.trim().toLowerCase() === kept.toLowerCase()))
  ) {
    await keepClaim($, null);
  }
}

/**
 * What this conversation learnt from its own calls (`claimFromCall`), in the
 * module alone, for which conversation: the claim it took from one, while
 * that is still the claim; the sessions a call need not look at again
 * (`settled`, in lower case): devcorner refused one as a call's claim for
 * good, another window works as it, or devcorner ties this window to it
 * already; and those devcorner refused for now, each with when a call may
 * take it again (`later`, `CALL_CLAIM_AGAIN_MS`).
 */
let fromCalls:
  | {
      id: string;
      taken: string | null;
      settled: Set<string>;
      later: Map<string, number>;
    }
  | undefined;

/**
 * How long after devcorner refused a call's claim for now (its store not
 * read, the session not live) a call may take it again: each try costs two
 * Status reads, one of them every live session's, so a window whose every
 * call names that session tries at most once a minute.
 */
export const CALL_CLAIM_AGAIN_MS = 60_000;

/** `fromCalls` for conversation `id`, made anew for another. */
function callsLearnt(id: string): NonNullable<typeof fromCalls> {
  if (fromCalls?.id !== id) {
    fromCalls = { id, taken: null, settled: new Set(), later: new Map() };
  }
  return fromCalls;
}

/** Whether `stated`, the claim a Status carries, is one taken from a call (`claimFromCall`), which devcorner holds to more. */
function takenFromCall(id: string, stated: string): boolean {
  return fromCalls?.id === id && fromCalls.taken === stated;
}

/**
 * The claim devcorner has taken for this window, for which conversation: a
 * claim it holds is no change, so a Status says it only once
 * more after a restart and again when something asks the window to state it
 * (`forgetClaimTaken`, at the held request's `{claim}` frame).
 */
let claimTaken: { id: string; session: string } | undefined;

/** Whether devcorner has already taken `session` for the window `id`. */
function claimTakenHere(id: string, session: string): boolean {
  return claimTaken?.id === id && claimTaken.session === session;
}

/**
 * Forgets the claim devcorner took, so the next Status says it again: the
 * held request's `{claim}` frame says the window's tie changed, and only a
 * stated claim asks devcorner to repair it.
 */
function forgetClaimTaken(): void {
  claimTaken = undefined;
}

/**
 * What a Status said of the claim it carried (dc-t588): one devcorner can
 * never take (the session finished, is a child's or another's, or its
 * connection moved on) is forgotten, unless a newer start kept another
 * meanwhile. A claim taken from a call (`claimFromCall`) is only this
 * window's guess, so any refusal of it forgets it; only one that can never
 * hold (devcorner's `final`: a cloud session, another window's, or gone) is
 * not taken from a call again, and one refused for now (its store not read,
 * the session not live) is taken again at a call `CALL_CLAIM_AGAIN_MS` on.
 */
async function heardClaim($: Engine, sent: string, s: Status): Promise<void> {
  if (s.claim?.session !== sent || s.claim.outcome !== "refused") return;
  let guessed = false;
  try {
    const learnt = callsLearnt(await $.session.id());
    guessed = learnt.taken === sent;
    if (guessed) {
      const key = sent.toLowerCase();
      if (s.claim.final === true) learnt.settled.add(key);
      else learnt.later.set(key, (await $.clock.now()) + CALL_CLAIM_AGAIN_MS);
    }
  } catch {
    /* stay silent */
  }
  if (s.claim.final !== true && !guessed) return;
  if ((await claimOf($)) === sent) await keepClaim($, null);
}

/**
 * devcorner's tools whose input takes `session`, on a server named for
 * devcorner, and any of devcorner's tools by name: kept in `./session-tools`,
 * where a test of devcorner's own holds them to its tool schemas, so the list
 * cannot drift from the server.
 */
export { DEVCORNER_TOOL, SESSION_TOOL } from "./session-tools";

/**
 * The session a devcorner call names as the one it is made as,
 * its `session` as devcorner shows ids (me-s4, acm-s4, dc-s4@acme); null
 * for none, or any other value.
 */
export function namedSession(call: { session?: unknown }): string | null {
  const named = typeof call.session === "string" ? call.session.trim() : "";
  return CLAIMED.test(named) ? named : null;
}

/** The session devcorner accepted for this window, as a Status read said (`claimTaken`); null for none. */
async function takenClaimOf($: Engine): Promise<string | null> {
  try {
    const id = await $.session.id();
    return claimTaken?.id === id ? claimTaken.session : null;
  } catch {
    return null;
  }
}

/**
 * A devcorner call of the main conversation's that names no session, sent as
 * the one this window states it runs as and devcorner accepted (`claimTaken`,
 * from a Status read): a reload reconnects to devcorner, and the new
 * connection holds no session, so a call that named none was refused as if
 * the window had none while its session was live and its mail still arrived.
 * A start is its own (`STARTER`), which binds the connection; a call that
 * names a session, a tool that takes none, a subagent's call and a window
 * whose session devcorner has not accepted go as they were made.
 */
async function withWindowSession<
  E extends { tool: string; agentId?: string; session?: unknown },
>($: Engine, e: E): Promise<E> {
  if (e.agentId !== undefined) return e;
  if (!SESSION_TOOL.test(e.tool)) return e;
  // A session the agent passed, blank or malformed, goes as it was made.
  if (Object.hasOwn(e, "session")) return e;
  const here = await takenClaimOf($);
  return here === null ? e : { ...e, session: here };
}

/** How a Status's `where` says a session runs in the cloud: "cloud", or "cloud · <routine>". */
const IN_CLOUD = /^cloud(?: · |$)/;

/**
 * Whether a Status says `session` is not this window's to take from a call
 * of its own (`session` is also "one to act as"): it runs in the cloud, or
 * works in another window of the person's that a message wakes now. One
 * working in its connection's own conversation, in none, or in this window
 * is not. devcorner holds a call's claim to the same and more
 * (`ClaimWindowInput.fromCall`): a quiet window's session too, which a
 * Status does not tell from one in its connection's own conversation.
 */
export function inAnotherWindow(s: Status, session: string): boolean {
  const here = s.thisConversation?.id ?? null;
  const key = session.toLowerCase();
  return (s.others?.items ?? []).some(
    (o) =>
      o.id.toLowerCase() === key &&
      (IN_CLOUD.test(o.where ?? "") ||
        (o.conversation !== null &&
          o.conversation !== here &&
          o.wakes === true)),
  );
}

/** A `claimFromCall` under way, so calls made side by side take one claim between them. */
let takingFromCall = false;

/**
 * The window learns its session from its own calls: a
 * conversation whose `start` the plugin never saw (one started before
 * 0.30.0, or in a process that restarted, whose new MCP connection holds no
 * session) passes the session it works as on each devcorner call. Once such
 * a call of the main conversation's, never a subagent's, has gone through,
 * and while the conversation states none and devcorner ties the window to
 * none, the session it names is kept as the claim, in the module alone, and
 * a Status says it at once, marked as a call's (`claim_from`), so devcorner
 * ties the window to it (`claimWindow`, with every check a start's claim
 * gets and more: never a cloud session, nor another window's) and the row,
 * /dc and /dc sessions name it with no new start. It is never written to the
 * claim's file, so a SessionStart never states a guess as a start's claim.
 * A start's claim, or one kept before, stands, even one a start keeps while
 * this call's is being taken; a start and a finish are their own
 * (`STARTER`, `FINISHER`). A session in the cloud or another window a
 * message wakes is not taken (`inAnotherWindow`), one devcorner refused for
 * good as the claim is not taken again and one refused for now not for a
 * while (`heardClaim`), and one devcorner ties the window to already is not
 * looked at again; a call made side by
 * side with one being taken is left (`takingFromCall`). Silent on any
 * failure: the call's answer is the model's as it was.
 */
async function claimFromCall(
  $: Engine,
  e: { tool: string; agentId?: string; session?: unknown },
  ran: { deny?: string; isError?: boolean },
): Promise<void> {
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) {
    return;
  }
  if (STARTER.test(e.tool) || FINISHER.test(e.tool)) return;
  const named = namedSession(e);
  if (named === null || takingFromCall) return;
  takingFromCall = true;
  try {
    const id = await $.session.id();
    const key = named.toLowerCase();
    if ((await claimOf($)) !== null) return;
    const learnt = callsLearnt(id);
    if (learnt.settled.has(key)) return;
    if ((learnt.later.get(key) ?? 0) > (await $.clock.now())) return;
    // Where this window works and where the session does, as devcorner
    // says them now.
    const s = (await refresh($, true, { others: true }))?.status;
    if (!s) return;
    if (s.session) {
      if (s.session.id.toLowerCase() === key) learnt.settled.add(key);
      return;
    }
    if (inAnotherWindow(s, named)) {
      learnt.settled.add(key);
      return;
    }
    // Checked and kept with no wait between, so a start's claim kept
    // meanwhile stands.
    if (claim?.id === id && claim.session !== null) return;
    claim = { id, session: named };
    learnt.taken = named;
    await refresh($, true);
  } catch {
    /* stay silent */
  } finally {
    takingFromCall = false;
  }
}

// Reloading onto the plugin on disk. After a promotion a window
// keeps the plugin it loaded until Claude Code's reload runs in it. So once
// the window is idle (`reloadIdle`) it reloads by itself when its plugin is
// behind: the plugin's folder holds a newer version than the one loaded (a
// checkout pulled), or devcorner names a newer one than both
// (`Status.shippedPlugin`), which it first asks Claude Code to fetch with the
// marketplace's update. Its person may also ask it to reload now
// (`Status.reload`, when it was asked), brought at once by the held
// request's `{reload}`. Claude Code tears this copy down, whose `await`
// never returns, and loads the new one, which says its version with its
// next Status. What a reload was for is kept in the plugin's store by
// conversation before it runs, so the new copy confirms the ask its load
// answers, and a version that did not load is never tried again; what is
// kept of a conversation long over is let go of as a window starts
// (`sweepReloadKept`).

/** The conversation whose Status devcorner said this plugin's version back for, since this window's last start. */
let pluginTaken: string | null = null;

/** The ask this copy tried to reload for and could not: never tried again. */
let reloadTried: number | null = null;

/** A reload's check under way, so two Status reads never run two. */
let reloadChecking = false;

/** The marketplace this plugin is installed from, whose update fetches a newer version. */
const MARKETPLACE_UPDATE = "marketplace update devcorner";

const reloadKey = (session: string) => `reload:${session}`;
const BEHIND_PREFIX = "reloadBehind:";
const behindKey = (session: string) => `${BEHIND_PREFIX}${session}`;

/** How long a conversation's tried version is kept: past it, the conversation is long over. */
const BEHIND_KEPT_MS = 7 * 24 * 60 * 60_000;

/** The version a conversation's last reload by itself was for (`behindKey`), as kept with when; null for none. */
function behindTried(kept: unknown): { version: string; at: number } | null {
  const o = kept as { version?: unknown; at?: unknown } | null;
  return o !== null &&
    typeof o === "object" &&
    isVersion(o.version) &&
    typeof o.at === "number"
    ? { version: o.version, at: o.at }
    : null;
}

/**
 * Lets go of the versions tried by conversations not heard for
 * `BEHIND_KEPT_MS`: one is kept only while its target stays newer than the
 * plugin loaded, which a version Claude Code never fetched does for good.
 */
async function sweepReloadKept($: Engine): Promise<void> {
  try {
    const now = await $.clock.now();
    for (const key of await $.store.keys()) {
      if (!key.startsWith(BEHIND_PREFIX)) continue;
      const tried = behindTried(await $.store.get(key));
      if (tried === null || now - tried.at > BEHIND_KEPT_MS)
        await $.store.delete(key);
    }
  } catch {
    // Kept for the next start: nothing depends on the sweep.
  }
}

/** How long the folder's version read last stands, so an idle window's Status every few seconds reads the manifest once a minute at most. */
const DISK_READ_MS = 60_000;

/** The folder's version as last read (`versionOnDisk`), and when. */
let diskRead: { at: number; version: string | null } | null = null;

/** A plugin version as a manifest says it, "0.77.0". */
const isVersion = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);

/** Orders two plugin versions: positive when `a` is newer; null when either is not one. */
function versionOrder(a: unknown, b: unknown): number | null {
  const parts = (v: unknown) =>
    isVersion(v) ? v.split(".").map(Number) : null;
  const x = parts(a);
  const y = parts(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Whether `version` is newer than the plugin this copy loaded. */
const newerThanLoaded = (version: string | null) =>
  (versionOrder(version, PLUGIN_VERSION) ?? 0) > 0;

/**
 * The version the plugin's folder (`$.plugin.root`) holds, its manifest's,
 * read again once `DISK_READ_MS` passed; null where it cannot be read.
 */
async function versionOnDisk($: Engine): Promise<string | null> {
  const now = await $.clock.now();
  if (diskRead !== null && now - diskRead.at < DISK_READ_MS)
    return diskRead.version;
  const version = await readVersionOnDisk($);
  diskRead = { at: now, version };
  return version;
}

async function readVersionOnDisk($: Engine): Promise<string | null> {
  try {
    const root: unknown = $.plugin.root;
    if (typeof root !== "string" || root === "") return null;
    const text = await $.fs.read(`${root}/.claude-plugin/plugin.json`);
    const version = (JSON.parse(String(text)) as { version?: unknown }).version;
    return isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Idle, as a wake waits for: no turn, no background command or subagent
 * open, nothing typed in the prompt box, and nothing under way that a reload
 * would cut off: a wake or the page's words submitted whose turn has not
 * begun, a command from the page, words of the page waiting to be typed, or
 * an ask of a window chat still open.
 */
async function reloadIdle($: Engine): Promise<boolean> {
  if (
    (await read($, turn)) !== null ||
    runningWork.size > 0 ||
    wokeAt !== null ||
    typedHolding(await $.clock.now()) ||
    commandFromPage !== null ||
    pageWords.length > 0 ||
    asks.size > 0
  )
    return false;
  const draft = await $.prompt.read().catch(() => ({ text: "x" }));
  return draft.text.trim() === "";
}

/** The reload ask this conversation's last copy reloaded for, kept in the plugin's store; null for none. */
async function reloadedFor($: Engine, session: string): Promise<number | null> {
  const kept = await $.store.get(reloadKey(session)).catch(() => undefined);
  return typeof kept === "number" ? kept : null;
}

/**
 * devcorner took this copy's version and the reload ask its load answered:
 * the ask is forgotten, and the person told the window runs the plugin it
 * loaded, unless devcorner still says it waits (a newer ask, which the next
 * idle moment takes).
 */
async function reloadConfirmed(
  $: Engine,
  session: string,
  s: Status,
): Promise<void> {
  const answered = await reloadedFor($, session);
  await $.store.delete(reloadKey(session)).catch(() => {});
  if (answered !== null && typeof s.reload !== "number")
    $.ui.toast(
      `dc: reloaded devcorner's plugin, now ${PLUGIN_VERSION}, as asked`,
    );
}

/**
 * After a Status, once the window is idle and the hook or hold that read it
 * has returned: reloads when its person asked (an ask tried once a
 * conversation), or when its plugin is behind (each newer version tried
 * once a conversation). A version devcorner names that the folder does not
 * hold is fetched first; one Claude Code would not fetch is said with the
 * command to run, and no reload follows unless asked. A reload refused is
 * said with what to type.
 */
function reloadWhenIdle($: Engine, s: Status): void {
  const asked = typeof s.reload === "number" ? s.reload : null;
  const named = typeof s.shippedPlugin === "string" ? s.shippedPlugin : null;
  if (asked === null && named === null) return;
  $.clock.after(0, async () => {
    if (reloadChecking) return;
    reloadChecking = true;
    let session: string | null = null;
    try {
      // A turn's end reads Status again, and takes it then.
      if (!(await reloadIdle($))) return;
      session = await $.session.id();
      const ask =
        asked !== null &&
        asked !== reloadTried &&
        (await reloadedFor($, session)) !== asked
          ? asked
          : null;
      const disk = await versionOnDisk($);
      const target = [disk, named]
        .filter(newerThanLoaded)
        .sort((a, b) => versionOrder(b, a)!)[0];
      const kept = await $.store.get(behindKey(session)).catch(() => null);
      const tried = behindTried(kept)?.version ?? null;
      if (target === undefined && kept != null)
        await $.store.delete(behindKey(session)).catch(() => {});
      const behind = target !== undefined && tried !== target ? target : null;
      if (ask === null && behind === null) return;
      const markTried = async (version: string) =>
        $.store.set(behindKey(session!), { version, at: await $.clock.now() });
      // Only devcorner names it: the folder needs it fetched first.
      if (behind !== null && behind !== disk) {
        try {
          await $.command.run({ command: "plugin", args: MARKETPLACE_UPDATE });
        } catch (error) {
          $.ui.toast(
            `dc: devcorner's plugin ${behind} is out, and Claude Code did not fetch it here (${commandRefused(error)}): run /plugin ${MARKETPLACE_UPDATE}, then /reload-plugins`,
          );
          if (ask === null) {
            await markTried(behind);
            return;
          }
        }
      }
      // The fetch takes seconds: a turn, a wake or words begun meanwhile are
      // never cut off, and the next idle Status tries again.
      if (!(await reloadIdle($))) return;
      if (behind !== null) await markTried(behind);
      if (ask !== null) {
        reloadTried = ask;
        await $.store.set(reloadKey(session), ask);
      }
      await $.command.run({ command: "reload-plugins" });
      // Claude Code tears this copy down, so this runs only where the reload
      // left it loaded (it reloads only modules that changed on disk): it
      // reads Status now, which says its version and the ask as a new copy's
      // first would, so the ask never waits on a copy that never comes, nor
      // on an idle window's next event.
      pluginTaken = null;
      await refresh($, true);
    } catch (error) {
      // Not reloaded: no new copy answers this ask.
      if (session !== null)
        await $.store.delete(reloadKey(session)).catch(() => {});
      $.ui.toast(
        `dc: this window could not reload devcorner's plugin (${commandRefused(error)}): type /reload-plugins`,
      );
    } finally {
      reloadChecking = false;
    }
  });
}

/**
 * What a Status read asks devcorner for besides the row's own, which it
 * reads only when asked: the repo's picture for /dc and /dc waits (dc-t218,
 * dc-t492), what the conversation's session is on and did lately for /dc
 * now (dc-t489), and the person's other live sessions for /dc sessions
 * (dc-t491).
 */
type Asks = { picture?: boolean; now?: boolean; others?: boolean };

// One call to devcorner, with what it came to; a problem is kept in the
// read, never thrown. A light read asks for the session part
// alone: a timer asks it, so what waits, Next, what moves and the night are
// read only where something changed.
async function fetchStatus(
  $: Engine,
  asks: Asks,
  light = false,
): Promise<Read> {
  const failed = (problem: string, down = false): Read => ({
    problem,
    down,
    retryIn: null,
  });
  let base = DEFAULT_URL;
  let saying = false;
  try {
    base = await baseOf($);
    const held = await tokenOf($);
    if (!held) {
      return {
        ...failed(
          (await inCloud($)) ? CLOUD_DELIVERY : await deliveryOff($, base),
        ),
        signedOut: "none",
      };
    }
    const token = held.token;
    const cwd: string = await $.session.cwd();
    const repo = await repoIn($, cwd);
    if (!repo) {
      return failed(
        "This folder has no git remote named origin on a host, nor does a folder its origin names, so devcorner cannot tell which repo it is.",
      );
    }
    const sessionId = await $.session.id();
    // The branch git is on here, said when it moved since devcorner last
    // took it (dc-t334): the conversation's session moves with it.
    const branch = (await branchIn($, cwd).catch(() => undefined)) ?? undefined;
    const key = `${sessionId} ${cwd}`;
    const moved =
      !branchSaying &&
      branch !== undefined &&
      (branchTaken?.key !== key || branchTaken.branch !== branch);
    if (moved) branchSaying = saying = true;
    // The session this window runs as, as its start said (dc-t588): devcorner
    // checks it and ties the window to it when that had drifted. Said until
    // devcorner takes it: a claim it holds is no change, so a
    // status asked after it is read checks none.
    const claiming = await claimOf($);
    const stated =
      claiming !== null && !claimTakenHere(sessionId, claiming)
        ? claiming
        : null;
    const guessed = stated !== null && takenFromCall(sessionId, stated);
    // This plugin's version, said until devcorner says it back for this
    // conversation, and the reload ask this copy's load answers.
    const saysPlugin = pluginTaken !== sessionId;
    const reloaded = saysPlugin ? await reloadedFor($, sessionId) : null;
    // Why the window holds no socket of its own, said once, so devcorner
    // counts how often a window falls back to the held request.
    const telling = listenFellBack;
    // Only an idle window that mirrors a chat can use the waiting chat, so
    // only it asks devcorner to read the mark: a Status without this makes no
    // such read at all (a turn's keepFresh, /dc, every older plugin).
    const idleMirror = mirror !== null && (await read($, turn)) === null;
    const res = await $.http.fetch(`${base}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hook_event_name: "Status",
        repo,
        session_id: sessionId,
        cwd,
        ...(moved ? { branch } : {}),
        ...(stated !== null ? { claim: stated } : {}),
        ...(guessed ? { claim_from: "call" } : {}),
        ...(saysPlugin ? { plugin: PLUGIN_VERSION } : {}),
        ...(reloaded !== null ? { reloaded } : {}),
        ...(asks.picture ? { expanded: true } : {}),
        ...(asks.now ? { now: true } : {}),
        ...(asks.others ? { others: true } : {}),
        ...(idleMirror ? { waitingChat: true } : {}),
        ...(light ? { light: true } : {}),
        ...(telling !== null ? { delivery: telling } : {}),
      }),
    });
    // Said once: a helper that ended again is said again.
    if (telling !== null && res.ok) {
      if (telling !== "ended") listenTold.add(telling);
      if (listenFellBack === telling) listenFellBack = null;
    }
    if (res.status === 401 && held.from === "store") {
      // The machine was revoked on the connections page: its token is
      // forgotten, and the row says how to sign in again.
      return {
        ...failed(
          "devcorner revoked this machine's token: run /dc login, or ask Claude to sign it in.",
        ),
        signedOut: "revoked",
        refused: token,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return failed(
        held.from === "env"
          ? `devcorner at ${base} refused DEVCORNER_TOKEN (HTTP ${res.status}). Make a hook token at ${base}/settings/connections, or unset it and run /dc login.`
          : `devcorner at ${base} refused this machine's token (HTTP ${res.status}). /dc logout, then /dc login, signs it in again.`,
      );
    }
    const retryIn = updatingFor(res);
    if (retryIn !== null) {
      // Not a failure: the asking waits as long as devcorner said, and the
      // row says why.
      return {
        problem: `${UPDATING_LINE}: asking again in ${Math.round(retryIn / 1000)} s.`,
        down: false,
        retryIn,
      };
    }
    if (!res.ok) {
      return failed(`devcorner at ${base} answered HTTP ${res.status}.`, true);
    }
    const body = JSON.parse(res.text);
    if (isStatusLight(body)) {
      return { light: body, down: false, retryIn: null };
    }
    if (!isStatus(body)) {
      return failed(
        `devcorner at ${base} gave an answer this plugin does not understand; it may be older than the plugin.`,
      );
    }
    // Taken once devcorner says it back; until then each Status says it
    // again, as when a store could not take it, or devcorner is older.
    if (moved && body.branch === branch) branchTaken = { key, branch };
    if (stated !== null) await heardClaim($, stated, body);
    if (
      stated !== null &&
      body.claim?.session === stated &&
      body.claim.outcome !== "refused"
    ) {
      claimTaken = { id: sessionId, session: stated };
    }
    if (saysPlugin && body.plugin === PLUGIN_VERSION) {
      pluginTaken = sessionId;
      if (reloaded !== null) await reloadConfirmed($, sessionId, body);
    }
    return {
      status: { ...body, repo: body.repo ?? repo },
      down: false,
      retryIn: null,
    };
  } catch {
    return failed(`devcorner at ${base} could not be reached.`, true);
  } finally {
    if (saying) branchSaying = false;
  }
}

/**
 * Reads Status, at most every 30 s unless forced (undefined when it does
 * not), and keeps what it says: the row, the updating line and the hooks'
 * marker. On failure the last good status stays. It asks for more than the
 * row's own only when `asks` says so (/dc, /dc now, /dc waits, /dc
 * sessions), and a `light` read asks for the session part alone, which a
 * timer does: the row keeps the last full status's rest.
 */
async function refresh(
  $: Engine,
  force = false,
  asks: Asks = {},
  light = false,
): Promise<Read | undefined> {
  const now = await $.clock.now().catch(() => undefined);
  if (now === undefined || (!force && now - lastAt < EVERY_MS)) {
    return undefined;
  }
  lastAt = now;
  const seq = ++learnt;
  const got = await fetchStatus($, asks, light);
  // A read that began before another and ended after it is older news: the
  // row and the marker keep the later one's. Its caller still goes by it.
  if (seq < shown) return got;
  shown = seq;
  try {
    await noteUpdating($, got.retryIn);
    await markWaiting($, pendingOf(got.status ?? got.light), seq);
    if (got.light) {
      const kept = got.light;
      await update($, status, (before) => withLight(before, kept));
      if ((await read($, status)) !== null) {
        // A reload is asked for at a full read's idle moment: a light one
        // hears the ask at the held request's frame or at the next turn's end.
        // A token that works: whatever the row said of signing in is over.
        endFlow();
        if ((await read($, signIn)) !== null) await setSignIn($, null);
        $.ui.invalidate("ui.render");
      }
      return got;
    }
    const s = got.status;
    if (s) {
      reloadWhenIdle($, s);
      await update($, status, () => s);
      // A token that works: whatever the row said of signing in is over, and
      // a sign-in under way here, whose token another conversation took,
      // stops polling.
      endFlow();
      if ((await read($, signIn)) !== null) await setSignIn($, null);
      $.ui.invalidate("ui.render");
    } else if (got.signedOut) {
      await noteSignedOut($, got.signedOut, got.refused);
    }
  } catch {
    /* stay silent: the read is still what it was */
  }
  return got;
}

/** What /dc says before devcorner has answered once. */
const NO_STATUS_LINE = "devcorner has given no status yet.";

// The wake. While the main conversation is idle it asks devcorner whether a
// message that wakes its session waits (see nextStep), and when one does it
// submits `wakePrompt`, naming what came, once for it, and no other wake
// before the turn it starts begins. A turn pauses the asking and its end
// starts it again; no session, no token, no git remote or a refused token
// stops it until the next turn, and a failed ask waits longer each time.
let timer: Timer | undefined;
let failures = 0;

// The held request. While idle, one `Wait` request is kept open: devcorner
// answers at the first message that wakes the session (ids only), or with {}
// after about 50 s. $.http.fetch cannot be cut, so "aborting" is the epoch: a
// turn start, the end of the session or a newer hold makes the old answer
// count for nothing. Any failure hands the conversation to the Status poll.
let epoch = 0;
/** Quick answers in a row that held nothing: empty, or a window chat's frame. */
let quick = 0;
/** Held requests in a row that failed or answered at once, while mirroring a window chat. */
let holdFailures = 0;
/** The earliest time a held request may be tried again. */
let holdAfter = 0;
/**
 * The waiting mark the poll opened a hold for at once (`chat:at`, the status's
 * `waitingChatAt`): only a mark not seen before opens one, so a mark that
 * stays, as a word the window cannot take, falls back to the ordinary
 * backoff rather than spinning a hold at every poll.
 */
let cuedMark: string | null = null;
/**
 * The session a held request said is not live, which its next holds leave out
 * (`aside`) while the conversation alone is held. Null when none was refused;
 * a turn or a new session tries it again.
 */
let sessionAside: string | null = null;
/** The ended sessions whose stop was said in the transcript already, once each in a load. */
const holdTold = new Set<string>();
/** The earliest time devcorner may be asked again after a failure. */
let askAfter = 0;
/**
 * When the plugin submitted a prompt whose turn has not begun yet, a wake or
 * `/dc`'s ask; null once it has (`WAKE_SETTLE_MS`).
 */
let wokeAt: number | null = null;
/** The one timer that types the page's words once a prompt the window holds has begun its turn. */
let typedWait: Timer | undefined;
/**
 * The message a wake's prompt was submitted for, until its turn begins
 * (dc-t312): that turn is the wake's, and `Turn` says so. Null for any other
 * prompt, the person's own or `/dc <words>`.
 */
let wakingFor: string | null = null;

/** Counts the sessions this module has seen begin or end: a late answer belongs to the one it was asked in (`keepLate`). */
let sessionNo = 0;

// The window's own sockets. While no window chat is mirrored, an
// idle window holds no request and asks nothing on a timer: one helper
// (hooks/listen.mjs, run with `node` by `$.process.spawn`) holds a sleeping
// socket to each store a held request would wait on, and prints each frame
// it is sent, which `actOn` takes as it takes a held request's answer. The
// helper reconnects by itself; the child is killed when this module's loop
// ends or the module unloads, so a reload or a closed window leaves none.
// With no node, no `$.process` or a helper that ended, the held request
// takes over, and the next Status says why once (`listenFellBack`).

/**
 * The helper, while it runs or starts: how to stop it, the session it was
 * started for, whether its sockets were lost since they last opened, and
 * whether its child was started (`running`), from when the asking leaves
 * the window to it (`listen` answered true).
 */
let listener: {
  stop: () => void;
  session: number;
  lost?: boolean;
  running?: boolean;
} | null = null;
/** The earliest time a helper may be started again after one ended. */
let listenAfter = 0;
/** Why the window falls back to the held request, said in the next Status; null when it was said or none. */
let listenFellBack: ListenFallback | null = null;
/** The lasting reasons said already in this load (no node, no process), never said twice. */
const listenTold = new Set<ListenFallback>();
/** The node the helper runs with: a path, null where none runs it, undefined until looked for. */
let listenNode: string | null | undefined;
/** Why a window holds no socket of its own, as its Status says it (`DELIVERY_FALLBACKS` in src/mcp/handler.ts). */
type ListenFallback = "no-node" | "no-process" | "ended";
/** The oldest Node whose own WebSocket the helper uses. */
const LISTEN_NODE_MAJOR = 22;
/** Where the store keeps the node the helper ran with last. */
const LISTEN_NODE_KEY = "listenNode";

/** Whether a prompt the plugin submitted lately still waits for its turn to begin (`wokeAt`). */
const settling = (now: number) =>
  wokeAt !== null && now - wokeAt < WAKE_SETTLE_MS;

/**
 * A held request said the session this conversation works as is not live:
 * its next holds leave it out (`sessionAside`) and hold the conversation
 * alone, whose mail still wakes the window, and the transcript says so once
 * for it. A turn or a session puts it back.
 */
function asideEndedSession($: Engine, session: string): void {
  sessionAside = session;
  if (holdTold.has(session)) return;
  holdTold.add(session);
  $.ui.log(
    `devcorner: delivery for ${session} stopped: that session has ended. This window hears its conversation until you send a message or start a new session.`,
  );
}

/** A new or ended session starts clean: nothing of the last one carries over. */
function forgetSession(): void {
  stopListening();
  listenAfter = 0;
  claimTaken = undefined;
  quick = 0;
  holdFailures = 0;
  holdAfter = 0;
  cuedMark = null;
  sessionAside = null;
  holdTold.clear();
  askAfter = 0;
  failures = 0;
  wokeAt = null;
  wakingFor = null;
  stoppingForMove = false;
  typedWait?.cancel();
  typedWait = undefined;
  lateLines.clear();
  sessionNo += 1;
}

/** How long the poll waits: sooner only while the session waits on its person. */
async function pollMs($: Engine): Promise<number> {
  const s = await read($, status);
  return s?.session?.waitingOnPerson ? WAITING_MS : IDLE_MS;
}

async function waitOnce($: Engine): Promise<Held> {
  try {
    const token = (await tokenOf($))?.token;
    if (!token) return { kind: "failed" };
    const base = await baseOf($);
    const from = (await read($, woke)) ?? undefined;
    const each = await read($, cursors);
    const said = mirrorSaid();
    const res = await $.http.fetch(`${base}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hook_event_name: "Wait",
        session_id: await $.session.id(),
        timeout: HOLD_MS,
        // This plugin can start Claude Code sessions for window chats
        // (`takeLaunch`), and revive a chat's parked background session
        // (`claude respawn`): devcorner keeps this window as a launcher of
        // the machine its token is.
        launcher: true,
        revive: true,
        // The window chat it mirrors, which only this copy keeps online, and
        // the turn it still owes devcorner.
        ...(said !== null ? { mirror: said } : {}),
        // This plugin reads the answer that says the session it works as is
        // not live (`{notLive}`), and leaves that session out of its next
        // holds (`aside`).
        readsNotLive: true,
        // The session devcorner said is not live, left out of the hold while
        // the conversation alone is held (`sessionAside`).
        ...(sessionAside !== null ? { aside: sessionAside } : {}),
        ...(from ? { cursor: from } : {}),
        // The newest woken for in each store (dc-t312): the held request
        // holds on two, each of which reads only its own ids.
        ...(each.length > 0 ? { cursors: each } : {}),
      }),
    });
    if (res.ok) return readHeld(res.text);
    const after = updatingFor(res);
    return after === null ? { kind: "failed" } : { kind: "updating", after };
  } catch {
    return { kind: "failed" };
  }
}

async function hold($: Engine): Promise<void> {
  const mine = ++epoch;
  timer?.cancel();
  timer = undefined;
  try {
    while (mine === epoch) {
      if ((await read($, turn)) !== null) return;
      if (await superseded($)) return;
      // The window's own sockets hear for it now, or again once a helper
      // that ended may be tried again: nothing is held here.
      if (await listen($, await $.clock.now())) return;
      const began = await $.clock.now();
      const held = await waitOnce($);
      if (mine !== epoch) return;
      const now = await $.clock.now();
      // A hold whose epoch ended (a turn started, the session ended, a newer
      // hold) touches nothing: not the times, the timer or the row. So the
      // epoch is checked again after every wait below.
      if (mine !== epoch) return;
      const quickly = now - began < QUICK_MS;
      // A request that held a while shows devcorner holds it: the holds that
      // failed or answered at once before it are over.
      if (!quickly && held.kind !== "failed") holdFailures = 0;
      // The row says whether a mirrored chat's page reaches this window.
      if (mirror !== null)
        await mirrorReached(
          $,
          held.kind !== "failed" && held.kind !== "updating",
        );
      if (mine !== epoch) return;
      // The session the conversation works as ended: nothing would ever wake
      // it, so its next holds leave it out (`aside`) and hold the
      // conversation alone, whose mail still wakes the window. A turn or a
      // session tries it again. Said once for each session, and counted as a
      // quick answer, so one that keeps coming despite the aside falls to the
      // poll below rather than looping.
      if (held.kind === "not-live") {
        asideEndedSession($, held.session);
        quick = quickly ? quick + 1 : 0;
        if (quick < QUICK_MAX) {
          holdAfter = now;
          continue;
        }
      }
      // A failed hold that ran its whole length was cut on the way (the
      // client's fetch or a proxy between) after devcorner held it, not
      // devcorner failing: held again at once, as an empty answer is. One that
      // failed sooner is devcorner failing, and leaves the poll below.
      if (held.kind === "failed" && now - began >= HOLD_MS) {
        holdFailures = 0;
        quick = 0;
        holdAfter = now;
        continue;
      }
      // A chat frame given at once counts as an empty one does: devcorner
      // gives it to every hold until the window posts, so a window whose
      // look never goes would otherwise hold again and again at once.
      if (held.kind === "empty" || held.kind === "chat")
        quick = quickly ? quick + 1 : 0;
      if (held.kind === "empty" && quick < QUICK_MAX) continue;
      if (held.kind === "stop") {
        // The loop leaves here, so the hold the Hub keeps answering with the
        // stop is not asked for again, and `/exit` is run once.
        await actOn($, held);
        return;
      }
      if (
        held.kind === "notice" ||
        held.kind === "claim" ||
        held.kind === "reload" ||
        held.kind === "launch"
      ) {
        // Acted on, then held again at once.
        quick = 0;
        await actOn($, held);
        if (mine !== epoch) return;
        continue;
      }
      if (held.kind === "chat") {
        // The person's words from devcorner's page wait for this window's
        // window chat: fetched and typed in as theirs while the window is
        // idle, the look's post ending devcorner's frames for them. The look
        // goes even on the frame that hands the window to the poll below: a
        // frame is never dropped, or its words wait for the hold to happen
        // to reopen.
        await mirrorPost($, { look: true });
        if (mine !== epoch) return;
        if (quick < QUICK_MAX) continue;
      }
      const wokeFor = held.kind === "wake" ? await read($, woke) : null;
      if (mine !== epoch) return;
      if (held.kind === "wake" && held.id !== wokeFor) {
        quick = 0;
        // The held request is not opened again here, so a wake submitted
        // but not yet begun is never followed by another.
        holdAfter = now;
        await actOn($, held);
        return;
      }
      if (held.kind === "updating") {
        // devcorner is updating: nothing is asked until the time it named,
        // then the poll asks first, which says when it is back, and the
        // held request after it.
        quick = 0;
        holdAfter = now + held.after;
        askAfter = now + held.after;
        await noteUpdating($, held.after);
        if (mine !== epoch) return;
        askIn($, held.after, true);
        return;
      }
      // Failed, or answering at once: the poll has it for a while. A window
      // that mirrors a window chat, which hears its page's words only on a
      // held request, holds again at the poll's next ask after the first such
      // hold, and later after each one more in a row (`backoff`), never past
      // WAIT_RETRY_MS: the poll's good Status resets `failures`, not these.
      quick = 0;
      if (mirror === null) holdAfter = now + WAIT_RETRY_MS;
      else {
        holdFailures += 1;
        const retry = holdFailures > 1 ? backoff(holdFailures - 1) : 0;
        holdAfter = now + Math.min(retry, WAIT_RETRY_MS);
      }
      if (held.kind === "failed") {
        // A down server is left alone as a failed ask leaves it.
        const wait = backoff(++failures);
        askAfter = now + wait;
        askIn($, wait, true);
      } else {
        const ms = await pollMs($);
        if (mine !== epoch) return;
        askIn($, ms, true);
      }
      return;
    }
  } catch (error) {
    // A hold that throws leaves the window with neither a hold nor a poll
    // unless one is armed here: say why in the transcript, and ask again as
    // the poll does.
    const why = error instanceof Error ? error.message : String(error);
    $.ui.log(
      `devcorner: the held request failed: ${why}. This window polls devcorner again.`,
    );
    try {
      const ms = await pollMs($);
      if (mine === epoch) askIn($, ms, true);
    } catch {
      // The read that says how long to wait failed too: the idle poll's own.
      if (mine === epoch) askIn($, IDLE_MS, true);
    }
  }
}

/**
 * What an idle window does with a frame devcorner sent it, by its held
 * request or its own socket (`listen`):
 * - `wake`, a message that wakes it: the hooks' marker says one waits, and
 *   the wake itself goes by a fresh Status (dc-t204), which names what came
 *   and says whether it is still unread, since a hook may have handed it
 *   over since. One it woke for already is passed over.
 * - `notice`, mail it is told of without a turn (dc-t312): a fresh Status
 *   puts it in the hooks' marker, so the next prompt's hook hands it, and
 *   the person is told it waits.
 * - `claim`, devcorner asks for the session this window runs as (dc-t588):
 *   a fresh Status states it again, which asks devcorner to check and repair
 *   the tie, even where the claim was taken, and the row shows what it works
 *   as now. `reload`, its person asked it to reload its plugin, which that
 *   Status says and the window does while idle.
 * - `launch`, a window chat to start on this machine: taken by the first
 *   window that asks, and started by this script, never the model.
 * - `stop`, devcorner's page moved the window chat this window holds to
 *   devcorner and its person stopped it first: the chat is mirrored no
 *   more and this session ends (`stopForMove`).
 * Any other is left to its caller.
 */
async function actOn($: Engine, held: Held): Promise<void> {
  if (held.kind === "wake") {
    if (held.id === (await read($, woke))) return;
    await markWaiting($, 1, ++learnt);
    void ask($);
  } else if (held.kind === "notice") {
    await refresh($, true);
    $.ui.toast(noticeToast(held.id));
  } else if (held.kind === "claim" || held.kind === "reload") {
    if (held.kind === "claim") forgetClaimTaken();
    await refresh($, true);
  } else if (held.kind === "launch") {
    await takeLaunch($, held.launch);
  } else if (held.kind === "stop") {
    stopForMove(
      $,
      `${held.chat} moved to devcorner, so this window no longer mirrors it.`,
    );
  }
}

/**
 * The node the helper runs with: the one kept from the last time, else the
 * one on Claude Code's own PATH, else the one the person's login shell
 * finds (nvm puts it there alone), when it is `LISTEN_NODE_MAJOR` or later;
 * null where none is. Looked for once in a load.
 */
async function listenNodeOf($: Engine): Promise<string | null> {
  if (listenNode !== undefined) return listenNode;
  const runs = async (path: string) => {
    try {
      const v = nodeVersionOf((await nodeAt($, path)).version);
      return v !== null && v[0] >= LISTEN_NODE_MAJOR;
    } catch {
      return false;
    }
  };
  const kept = await $.store.get(LISTEN_NODE_KEY).catch(() => null);
  let found: string | null = null;
  if (typeof kept === "string" && (await runs(kept))) found = kept;
  else if (await runs("node")) found = "node";
  else {
    const path = await loginShellNode($).catch(() => null);
    if (path !== null && (await runs(path))) found = path;
  }
  if (found !== null && found !== kept)
    await $.store.set(LISTEN_NODE_KEY, found).catch(() => undefined);
  listenNode = found;
  return found;
}

/**
 * Starts the window's helper (`listener`) where it may run: an idle window
 * that draws, signed in, mirroring no window chat, with the plugin's folder,
 * `$.process` and a node that runs it. True while one runs, its own or one
 * just started; false where the held request goes on, with why kept to say
 * once (`listenFellBack`).
 */
async function listen($: Engine, now: number): Promise<boolean> {
  // A mirrored window chat's held request says the chat's state, so it holds.
  if (mirror !== null) return false;
  if (listener !== null) return true;
  if (now < listenAfter) return false;
  // Taken before the first wait, so a second call meanwhile starts none.
  let run: ReturnType<Engine["process"]["spawn"]> | null = null;
  const life = sessionNo;
  const mine: NonNullable<typeof listener> = {
    stop: () => void run?.return({ code: null, signal: null }),
    session: life,
  };
  listener = mine;
  const none = (why?: ListenFallback): false => {
    if (listener === mine) listener = null;
    return why === undefined ? false : fellBack(why);
  };
  const token = (await tokenOf($))?.token;
  const root: unknown = $.plugin.root;
  if (!token || typeof root !== "string" || root === "") return none();
  const node = await listenNodeOf($);
  if (node === null) return none("no-node");
  const conversation = await $.session.id();
  const input = JSON.stringify({
    base: await baseOf($),
    token,
    conversation,
    cursors: await read($, cursors),
    launcher: true,
    revive: true,
  });
  // Stopped meanwhile (the session ended, a newer copy, a mirror).
  if (listener !== mine) return false;
  try {
    run = $.process.spawn({
      argv: [node, `${root}/hooks/listen.mjs`],
      // Laid over the session's environment: the helper has the token on
      // standard input alone.
      env: { DEVCORNER_TOKEN: "" },
      input,
    });
  } catch {
    return none("no-process");
  }
  mine.running = true;
  const stream = run;
  void (async () => {
    let pending = "";
    let ended: string | null = null;
    try {
      // `return()` on the stream kills the child (the runtime's contract
      // for `$.process.spawn`); leaving this loop does too, so one stopped
      // whose `return()` waited behind a pending read ends at its next line.
      for await (const chunk of stream) {
        if (listener !== mine) break;
        if (chunk.stream !== "stdout") continue;
        pending += chunk.text;
        let at: number;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          ended = (await heardListen($, line, mine)) ?? ended;
        }
      }
    } catch {
      // It could not start: the held request takes over below.
    }
    if (listener !== mine) return;
    listener = null;
    // A node with no WebSocket of its own is no node for it; any other end
    // (a refused token, a conversation devcorner does not know) is tried
    // again after a while.
    if (ended === "no-websocket") listenNode = null;
    listenFellBack = ended === "no-websocket" ? "no-node" : "ended";
    try {
      listenAfter = (await $.clock.now()) + WAIT_RETRY_MS;
      if (life !== sessionNo || (await superseded($))) return;
      askIn($, 0, true);
    } catch {
      // The module unloaded with it: nothing is left to ask.
    }
  })();
  return true;
}

/** Keeps why the window holds no socket of its own, to say once in this load, and answers false. */
function fellBack(why: ListenFallback): false {
  if (!listenTold.has(why)) listenFellBack = why;
  return false;
}

/** Stops the window's helper, which closes its sockets. */
function stopListening(): void {
  const was = listener;
  listener = null;
  was?.stop();
}

/**
 * One line the helper printed (hooks/listen.mjs), read: it ends and why,
 * its sockets are open (`connected`) or lost for a while (`down`), or a
 * frame one was sent, read as a held request's answer is (`readHeld`).
 * Null for anything else.
 */
export type ListenLine =
  | { kind: "end"; why: string }
  | { kind: "connected" }
  | { kind: "down" }
  | { kind: "frame"; held: Held };

export function readListenLine(line: string): ListenLine | null {
  let said: Record<string, unknown>;
  try {
    said = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (said === null || typeof said !== "object") return null;
  if (typeof said.end === "string") return { kind: "end", why: said.end };
  if (said.connected !== undefined) return { kind: "connected" };
  if (said.down !== undefined) return { kind: "down" };
  if (said.frame !== undefined)
    return { kind: "frame", held: readHeld(JSON.stringify(said.frame)) };
  return null;
}

/**
 * One line the helper printed, acted on while it is this module's helper,
 * the window mirroring nothing (a mirrored chat's held request hears for
 * it). A frame is taken as a held request's answer is (`actOn`) while the
 * window is idle; a launch during a turn too, since nothing tells it again,
 * and the rest wait for the turn's end, whose Status reads them. Back after
 * a gap (a deploy closes every socket), what came meanwhile that no frame
 * tells as a socket opens (a notice, a reload ask) is read in one light
 * Status, which wakes for mail as an ask does. Answers why, when the line
 * says the helper ends, else null.
 */
async function heardListen(
  $: Engine,
  line: string,
  from: NonNullable<typeof listener>,
): Promise<string | null> {
  const said = readListenLine(line);
  if (said?.kind === "end") return said.why;
  if (said === null || listener !== from) return null;
  try {
    if (said.kind === "down") {
      from.lost = true;
      return null;
    }
    if (await superseded($)) return null;
    const idle = (await read($, turn)) === null;
    if (said.kind === "connected") {
      if (from.lost && idle) void ask($, undefined, true);
      from.lost = false;
      return null;
    }
    if (mirror !== null) return null;
    if (idle || said.held.kind === "launch") await actOn($, said.held);
  } catch {
    /* stay silent */
  }
  return null;
}

/**
 * Keeps asking: nothing while the window's own sockets hear for it
 * (`listen`), else the held request where it may be tried, else the poll in
 * `ms`. Never the held request while a wake's turn has not begun (`wokeAt`,
 * dc-t204): it would hand back at once a message that came meanwhile.
 */
async function carryOn($: Engine, ms: number): Promise<void> {
  const now = await $.clock.now();
  if (await listen($, now)) return;
  if (!settling(now) && now >= holdAfter) void hold($);
  // The held request is what it waits for: the poll in between asks the
  // light status, since nothing changed while it waits.
  else askIn($, ms, true);
}

/**
 * Submits `text` as the person's own prompt (`/dc <words>`, `/dc setup`),
 * once the `command.run` hook that asked has returned (dc-t226). Claude Code
 * refuses a prompt submitted from inside that hook, since it would wait on
 * the turn the hook holds, and a local command raises no `turn.complete` to
 * submit from: a timer due at once fires after the command answered, with
 * the session idle, and its prompt starts its turn then, interactive or
 * `-p`. Until that turn begins no wake goes (`wokeAt`): its prompt hook hands
 * over what waits. A refusal is said on a toast, since the command already
 * answered that it is asking.
 */
function askDevcorner($: Engine, text: string): void {
  $.clock.after(0, async () => {
    try {
      wokeAt = await $.clock.now();
      // The person's own words: its turn is theirs, not a wake's.
      wakingFor = null;
      const entered = await $.prompt.submit({ text, asUser: true });
      // Dropped (a Stop in the window stands) it begins no turn either.
      if (entered.drop !== undefined) {
        wokeAt = null;
        $.ui.toast(`dc: could not ask devcorner: ${entered.drop}`);
      }
    } catch (error) {
      wokeAt = null;
      const why = error instanceof Error ? error.message : String(error);
      $.ui.toast(`dc: could not ask devcorner: ${why}`);
    }
  });
}

/**
 * Asks devcorner again in `ms`, in place of any ask already set; a `light`
 * ask reads the session part alone, as a timer does.
 */
function askIn($: Engine, ms: number, light = false): void {
  timer?.cancel();
  timer = $.clock.after(ms, () => void ask($, undefined, light));
}

function stopAsking(): void {
  epoch++;
  timer?.cancel();
  timer = undefined;
}

/**
 * Whether a newer copy of the plugin loaded in this window since this one
 * (`generation`, which each copy's start names itself in): Claude Code stops
 * a copy's `$.clock.every` at a reload, but a `$.clock.after` loop runs on
 * until the hooks in flight settle, so a copy a reload replaced would keep
 * asking devcorner and holding requests for the window. Such a copy lets go
 * of its asking, its fresh marker and its mirror, sending nothing more.
 */
async function superseded($: Engine): Promise<boolean> {
  const newest = await read($, generation).catch(() => null);
  if (newest === null || newest === GENERATION) return false;
  stopAsking();
  stopFresh();
  stopListening();
  if (mirror !== null) {
    leaveMirror();
    mirror = null;
  }
  return true;
}

/** This window's own key (`windowKey`), made by the first copy that needs it. */
async function windowKeyOf($: Engine): Promise<string> {
  const kept = await read($, windowKey).catch(() => null);
  if (kept !== null) return kept;
  const made = randomKey();
  await update($, windowKey, (was) => was ?? made).catch(() => undefined);
  return (await read($, windowKey).catch(() => null)) ?? made;
}

/**
 * What a window chat's opening or rejoin binds the chat to: this copy of the
 * plugin and this window's own key, so devcorner counts no other copy for
 * it and takes the chat back when this window comes back under a new
 * conversation.
 */
async function boundTo(
  $: Engine,
): Promise<{ generation: string; windowKey: string }> {
  return { generation: GENERATION, windowKey: await windowKeyOf($) };
}

/**
 * What a held request says of the window chat this window mirrors: this
 * copy, and the turn it still owes devcorner, its turn under way or the
 * first whose posts have not gone yet (its end among them). A turn devcorner
 * still has under way that the window no longer owes ended here with its
 * end lost on the way, which devcorner then says on the page.
 */
function mirrorSaid(): { generation: string; turn: string | null } | null {
  if (mirror === null) return null;
  return {
    generation: GENERATION,
    turn:
      mirror.key ??
      mirror.unsent.find((payload) => payload.turn !== null)?.turn ??
      null,
  };
}

// While a turn runs, nothing above asks devcorner, and the prompt hooks ask
// only when the marker says something waits. So the marker is kept fresh:
// Status is asked every EVERY_MS while the turn runs, and a message sent
// mid-turn reaches the next tool call's hook.
// Where no marker is kept (`keepsMarker`: no file to name it, or a plain -p
// run that draws nowhere) the hooks ask as before, and nothing is asked.
let turnTimer: Timer | undefined;

async function keepFresh($: Engine): Promise<void> {
  if (!(await keepsMarker($).catch(() => false))) {
    // A marker kept while something drew the session is marked unknown.
    await markWaiting($, null, ++learnt);
    return;
  }
  stopFresh();
  turnTimer = $.clock.after(EVERY_MS, () => {
    turnTimer = undefined;
    void (async () => {
      // The timer paces it; refresh's own throttle would skip a tick. A
      // timer set as the turn ended finds it over and stops.
      if ((await read($, turn).catch(() => null)) === null) return;
      if (await superseded($)) return;
      // A light read: a turn's timer keeps the marker and the
      // session's line fresh, and the row's rest waits for the turn's end.
      await refresh($, true, {}, true);
      await keepFresh($);
    })();
  });
}

function stopFresh(): void {
  turnTimer?.cancel();
  turnTimer = undefined;
}

/**
 * Starts asking, where a person could see a wake: never in a plain -p run.
 * It asks Status first, which says whether there is a session to hold for,
 * unless a failure keeps devcorner alone for a while.
 */
async function startAsking($: Engine, given?: Read): Promise<void> {
  try {
    if (await draws($)) {
      stopAsking();
      const wait = askAfter - (await $.clock.now());
      if (wait > 0) askIn($, wait, true);
      else void ask($, given);
    }
  } catch {
    /* stay silent */
  }
}

async function ask($: Engine, given?: Read, light = false): Promise<void> {
  timer = undefined;
  try {
    // A running turn is handed its messages by the hooks; its end asks again.
    // (turn.start cancels the timer; this holds one already firing, or set by
    // a reload mid-turn.)
    if ((await read($, turn)) !== null) return;
    if (await superseded($)) return;
    // This ask goes by its own read, never by another that ran beside it.
    const got = given ?? (await refresh($, true, {}, light));
    const s = got?.status ?? got?.light;
    if (!got || !s) {
      const retryIn = got?.retryIn ?? null;
      if (retryIn !== null) {
        // devcorner is updating: asked again when it said, with no failure
        // counted.
        askAfter = (await $.clock.now()) + retryIn;
        askIn($, retryIn, true);
      } else if (got?.down) {
        const wait = backoff(++failures);
        askAfter = (await $.clock.now()) + wait;
        askIn($, wait, true);
      }
      return;
    }
    failures = 0;
    askAfter = 0;
    const step = nextStep(s, await read($, woke));
    if (step === null) return;
    const now = await $.clock.now();
    // A status that says a page message waits for this window's chat opens
    // the held request at once, once for each mark: the mark's stamp tells a
    // new word from the same one answered again, which falls back to the
    // ordinary backoff below rather than spinning a hold at every poll. The
    // hold is what says the chat, and its frame fetches the words.
    const cue =
      s.waitingChat && typeof s.waitingChatAt === "number"
        ? `${s.waitingChat}:${s.waitingChatAt}`
        : null;
    if (cue === null) cuedMark = null;
    if (
      "after" in step &&
      mirror !== null &&
      cue !== null &&
      cue !== cuedMark &&
      !settling(now)
    ) {
      cuedMark = cue;
      holdAfter = 0;
      quick = 0;
      void hold($);
      return;
    }
    if ("after" in step) {
      await carryOn($, step.after);
      return;
    }
    // A wake submitted a moment ago has not begun its turn yet: that turn's
    // prompt hook hands over whatever waits then, this message too, so no
    // second wake goes before it (dc-t204). Asked again in a while, or at
    // the turn's end.
    if (settling(now)) {
      askIn($, WAITING_MS);
      return;
    }
    // Never over what the person is typing: their own prompt's hook hands
    // the message over, and if they leave the draft, the next ask wakes.
    // Nor while a command from the page runs alone: a switch it asks the
    // page about holds its turn until the person answers there.
    const draft = await $.prompt.read();
    if (
      draft.text.trim() === "" &&
      (await read($, turn)) === null &&
      commandFromPage === null
    ) {
      // The session, or the conversation with none (dc-t312): `nextStep`
      // woke for one of them.
      const woken = wokenOf(s)!;
      await update($, woke, () => step.wake);
      await update($, cursors, (kept) => withCursor(kept, step.wake));
      wokeAt = now;
      wakingFor = step.wake;
      $.ui.toast(wakeToast(woken));
      // A wake refused starts no turn: the next turn is not the wake's. One
      // Claude Code drops (a Stop in the window stands) never begins one, so
      // the held request opens again at the next ask, a window chat's page
      // heard meanwhile; the message waits for the next prompt's hook.
      $.prompt.submit({ text: wakePrompt(woken) }).then(
        (entered) => {
          if (entered.drop === undefined || wakingFor !== step.wake) return;
          wakingFor = null;
          wokeAt = null;
          $.ui.toast(`dc: Claude Code refused the wake: ${entered.drop}`);
        },
        () => {
          wakingFor = null;
        },
      );
      // The poll, not the held request, until the turn begins: the held
      // request would hand back at once a message that came meanwhile.
      askIn($, WAITING_MS);
      return;
    }
    askIn($, WAITING_MS);
  } catch {
    /* stay silent */
  }
}

/**
 * What the status line reads of the account's limits, cut to the two windows:
 * the percentages and their reset times, nothing else. Null with none.
 */
export function capacityBody(
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): Record<string, { used_percentage: number; resets_at?: number }> | null {
  const out: Record<string, { used_percentage: number; resets_at?: number }> =
    {};
  for (const l of limits) {
    if (l.kind !== "five_hour" && l.kind !== "seven_day") continue;
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
    out[l.kind] = {
      used_percentage: l.percentUsed,
      ...(Number.isNaN(at) ? {} : { resets_at: Math.round(at / 1000) }),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * At most one report every CAPACITY_EVERY_MS, and none for a minute after a
 * failure. A reading that arrives inside the wait is kept (the latest only)
 * and sent when the wait ends, so the last reading before a quiet spell is not
 * lost.
 */
const CAPACITY_EVERY_MS = 30_000;
let capacityNext = 0;
let capacityPending: Record<
  string,
  { used_percentage: number; resets_at?: number }
> | null = null;
let capacityTimer: Timer | null = null;

/** A rate-limit window as the engine reports it. */
type Limit = { kind: string; percentUsed: number; resetsAt?: string };

/**
 * Keeps the latest reading and sends it now, or when the throttle opens. With
 * no token, as in a cloud session, nothing is sent: a devcorner call carries
 * the reading instead (`carriedCapacity`).
 */
async function reportCapacity(
  $: Engine,
  limits: readonly Limit[],
): Promise<void> {
  try {
    if (!(await tokenOf($))) return;
    const body = capacityBody(limits);
    if (!body) return;
    capacityPending = body;
    await flushCapacity($);
  } catch {
    /* stay silent */
  }
}

async function flushCapacity($: Engine): Promise<void> {
  let body: typeof capacityPending = null;
  try {
    const token = (await tokenOf($))?.token;
    if (!capacityPending || !token) return;
    const at = await $.clock.now();
    if (at < capacityNext) {
      capacityTimer ??= $.clock.after(capacityNext - at + 50, () => {
        capacityTimer = null;
        void flushCapacity($);
      });
      return;
    }
    body = capacityPending;
    capacityPending = null;
    capacityNext = at + CAPACITY_EVERY_MS;
    const base = await baseOf($);
    const res = await $.http.fetch(`${base}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hook_event_name: "Capacity",
        session_id: await $.session.id(),
        rate_limits: body,
      }),
    });
    if (!res.ok) {
      capacityNext = at + DOWN_MS;
      if (body) capacityPending ??= body;
    }
  } catch {
    if (body) capacityPending ??= body;
    try {
      capacityNext = (await $.clock.now()) + DOWN_MS;
    } catch {
      /* stay silent */
    }
  }
}

/**
 * A reading as a devcorner call carries it (dc-t221): each window's percent and
 * reset time, and when the module read them, nothing else. A cloud session
 * passes it to devcorner as it is.
 */
export type CapacityReading = {
  five_hour?: { percent: number; resets_at?: string };
  seven_day?: { percent: number; resets_at?: string };
  read_at: string;
};

/** The two windows of the engine's limits as a call carries them; null with neither. */
export function capacityReading(
  limits: readonly Limit[],
  nowMs: number,
): CapacityReading | null {
  const out: CapacityReading = { read_at: new Date(nowMs).toISOString() };
  for (const l of limits) {
    if (l.kind !== "five_hour" && l.kind !== "seven_day") continue;
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
    out[l.kind] = {
      percent: l.percentUsed,
      ...(Number.isNaN(at) ? {} : { resets_at: new Date(at).toISOString() }),
    };
  }
  return out.five_hour || out.seven_day ? out : null;
}

/**
 * When a reading is due, the person's rule (dc-c361), as devcorner holds it
 * (`capacityDue` in src/registry/claude-accounts.ts, its numbers in
 * src/hub/capacity-report.ts): ten minutes after the last one carried, or
 * sooner when a window moved five points or more, crossed 80% or 95% either
 * way, began anew or appeared or went. The plugin imports nothing of
 * devcorner's, so the numbers are copied here.
 */
export const DUE_EVERY_MS = 10 * 60_000;
export const DUE_POINTS = 5;
export const DUE_THRESHOLDS: readonly number[] = [80, 95];
/** Two reset times this close are one window's. */
const SAME_WINDOW_MS = 60_000;

export function capacityDue(
  last: CapacityReading | null,
  next: CapacityReading,
): boolean {
  if (last === null) return true;
  const was = Date.parse(last.read_at);
  const now = Date.parse(next.read_at);
  if (now <= was) return false;
  if (now - was >= DUE_EVERY_MS) return true;
  return (
    windowMoved(last.five_hour, next.five_hour) ||
    windowMoved(last.seven_day, next.seven_day)
  );
}

function windowMoved(
  a: CapacityReading["five_hour"],
  b: CapacityReading["five_hour"],
): boolean {
  if (!a || !b) return a !== b;
  if (Math.abs(b.percent - a.percent) >= DUE_POINTS) return true;
  if (DUE_THRESHOLDS.some((t) => a.percent < t !== b.percent < t)) return true;
  if (!a.resets_at || !b.resets_at) return a.resets_at !== b.resets_at;
  return (
    Math.abs(Date.parse(a.resets_at) - Date.parse(b.resets_at)) > SAME_WINDOW_MS
  );
}

/**
 * devcorner's tools that carry a cloud session's reading (dc-t221): start,
 * check, note, finish and usage, on a server named for devcorner, as a
 * person's connector or this plugin's own server is (`mcp__Devcorner__check`,
 * `mcp__plugin_devcorner_devcorner__check`). Of usage, only its run_account.
 */
export const CARRIER =
  /^mcp__[\w-]*devcorner[\w-]*__(start|check|note|finish|usage)$/i;

/**
 * devcorner's workspace tool, whose connect_plugin the plugin fills with this
 * machine's code (dc-t224), on a server named for devcorner, as `CARRIER`'s.
 */
export const SIGNER = /^mcp__[\w-]*devcorner[\w-]*__workspace$/i;

/** The last reading a call carried out, which the next is due against. */
let capacityCarried: CapacityReading | null = null;
/**
 * A call that carried a reading was refused (a permission check, a rule):
 * no call of this session carries one again, so none is refused for it.
 */
let capacityRefused = false;

/** A devcorner call as the `tool.call` hook sees it: the tool and its arguments. */
type CarrierCall = { tool: string; action?: unknown; capacity?: unknown };

/**
 * The reading a devcorner call is to carry, or null (dc-t221). Only in a
 * cloud session (CLAUDE_CODE_REMOTE, which Claude Code sets there) with no
 * token, since one holds no credential (dc-t141): with a token the module
 * posts `Capacity` itself. The windows are the ones the session's last answer
 * reported ($.session.usage()), which a call always follows, so even a
 * session's first call has them. Only when one is due against the last a
 * call carried, and never over one the agent passed itself. The reading is
 * taken as carried as it is chosen, with the one it replaced, so calls made
 * beside it carry none. Null on any failure, so the call goes out as the
 * agent made it.
 */
async function carriedCapacity(
  $: Engine,
  call: CarrierCall,
): Promise<{
  reading: CapacityReading;
  before: CapacityReading | null;
} | null> {
  try {
    if (capacityRefused) return null;
    // Blank is no reading, as devcorner takes it, so the plugin's goes.
    const own = call.capacity;
    if (own != null && !(typeof own === "string" && !own.trim())) return null;
    if (/__usage$/i.test(call.tool) && call.action !== "run_account") {
      return null;
    }
    if (await tokenOf($)) return null;
    if (!(await inCloud($))) return null;
    const reading = capacityReading(
      (await $.session.usage()).rateLimits,
      await $.clock.now(),
    );
    const before = capacityCarried;
    if (!reading || !capacityDue(before, reading)) return null;
    capacityCarried = reading;
    return { reading, before };
  } catch {
    return null;
  }
}

/**
 * The research tools devcorner points to earlier work before: a web search,
 * a page fetch and a subagent's spawn. The hook route's Recall answers the
 * work of the person's an agent should read before it researches again, or
 * nothing, and never the same item twice in one context window.
 */
export const RECALL_WEB = /^(?:WebSearch|WebFetch)$/;

/** How long a spawn waits for the answer before the subagent starts without it. */
export const RECALL_WAIT_MS = 2_000;
/** How long a web tool's result waits for an answer still on its way once the tool is done. */
export const RECALL_AFTER_MS = 500;
/** How long no Recall or Memory is asked after one failed: devcorner down, refused, or too many. */
export const RECALL_BACKOFF_MS = 60_000;
/** The most of any one field of a tool's input sent, in characters. */
export const RECALL_FIELD_MAX = 2_000;

/**
 * Agent types spawned with no line: devcorner's own worker, which starts its
 * run from devcorner itself, a fork, which shares its parent's context, and
 * Claude Code's status line setup, which edits one settings file from a fixed
 * brief and researches nothing. Any other Agent call is recalled for.
 */
const NO_RECALL_AGENT =
  /^(?:(?:[\w-]+:)?devcorner:worker|fork|statusline-setup)$/i;

/** No Recall or Memory is asked before this time, after one failed. */
let recallQuietUntil = 0;
/** The tool calls with a Recall on its way, by tool_use_id: each call asks its own. */
const recalling = new Set<string>();

/** A line devcorner answered, with the ids of the items it points to. */
interface Recalled {
  line: string;
  items: string[];
}

const field = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? value.slice(0, RECALL_FIELD_MAX)
    : null;

/**
 * What a Recall sends of a tool call: the tool and the input devcorner
 * searches by, each field cut to RECALL_FIELD_MAX. Null for a call it does
 * not recall for: another tool, an agent type in NO_RECALL_AGENT, or one with
 * nothing to search by. Nothing of it is stored.
 */
export function recallInput(call: {
  tool: string;
  [argument: string]: unknown;
}): { tool: string; input: Record<string, string> } | null {
  const fields = (names: string[]) => {
    const input: Record<string, string> = {};
    for (const name of names) {
      const value = field(call[name]);
      if (value !== null) input[name] = value;
    }
    return Object.keys(input).length > 0 ? { tool: call.tool, input } : null;
  };
  if (call.tool === "WebSearch") return fields(["query"]);
  if (call.tool === "WebFetch") return fields(["url", "prompt"]);
  if (call.tool !== "Agent") return null;
  const type = call.subagent_type;
  if (typeof type === "string" && NO_RECALL_AGENT.test(type.trim())) {
    return null;
  }
  return fields(["description", "prompt"]);
}

/**
 * Asks devcorner for the earlier work a research tool call should be pointed
 * to: its line and item ids, or null for none. Nothing is marked seen by the
 * ask: an item counts as seen in a window only once a result of that window
 * carried it (`deliver`). Fails open: no token, a call already asking, a
 * minute after a failure, or any error, and the answer is null, so the call
 * goes on as the agent made it.
 */
async function recallFor(
  $: Engine,
  call: { tool: string; tool_use_id?: string; agentId?: string },
): Promise<Recalled | null> {
  const key = call.tool_use_id ?? "";
  let mine = false;
  try {
    const asked = recallInput(call as Parameters<typeof recallInput>[0]);
    if (asked === null || (key !== "" && recalling.has(key))) return null;
    if ((await $.clock.now()) < recallQuietUntil) return null;
    const held = await tokenOf($);
    if (!held) return null;
    if (key !== "") {
      recalling.add(key);
      mine = true;
    }
    return await askLine($, held.token, {
      hook_event_name: "Recall",
      session_id: await $.session.id(),
      ...(call.agentId ? { agent_id: call.agentId } : {}),
      ...(call.tool_use_id ? { tool_use_id: call.tool_use_id } : {}),
      ...asked,
    });
  } catch {
    await quietRecalls($);
    return null;
  } finally {
    if (mine) recalling.delete(key);
  }
}

/**
 * Posts one ask of the hook route's that devcorner answers with a line for
 * the model and the ids it points to (`Recall`, `Memory`), with this
 * machine's token and the folder's repo: the line and its ids, or null when
 * devcorner has nothing to add or refused. A refusal other than of a bad
 * input quiets every ask for RECALL_BACKOFF_MS; a failure throws, for the
 * caller to quiet them.
 */
async function askLine(
  $: Engine,
  token: string,
  body: Record<string, unknown>,
): Promise<Recalled | null> {
  const res = await postHook($, token, body);
  // A devcorner from before the event answers 204, with nothing.
  if (res.status === 204) return null;
  if (!res.ok) {
    // A refused input is this call's alone; anything else waits a minute.
    if (res.status !== 400) await quietRecalls($);
    return null;
  }
  const answer = JSON.parse(res.text) as {
    context?: unknown;
    items?: unknown;
  };
  if (typeof answer?.context !== "string" || !answer.context.trim()) {
    return null;
  }
  const items = Array.isArray(answer.items)
    ? answer.items.filter((item): item is string => typeof item === "string")
    : [];
  return { line: answer.context, items };
}

/** Posts a hook route event with this machine's token and the folder's repo, as `Recall` and `Memory` send them. */
async function postHook(
  $: Engine,
  token: string,
  body: Record<string, unknown>,
) {
  const repo = await repoIn($, await $.session.cwd()).catch(() => undefined);
  return $.http.fetch(`${await baseOf($)}/mcp/hooks/claude-code`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(repo ? { "X-Devcorner-Repo": repo } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * The tools an agent uses on Claude Code's own memory, its auto memory: a
 * folder of Markdown files read with Read, Grep and Glob and written with
 * Write and Edit. Its index, MEMORY.md, is loaded by Claude Code itself as a
 * conversation starts, which no hook sees.
 */
export const AUTO_MEMORY_TOOL = /^(?:Read|Grep|Glob|Write|Edit)$/;

/**
 * A path in Claude Code's auto-memory folder,
 * `~/.claude/projects/<project>/memory/`, with `~` expanded or not, a glob's
 * wildcard for the project, and either separator. A folder moved by
 * `autoMemoryDirectory` or `CLAUDE_CONFIG_DIR` is not matched.
 */
const AUTO_MEMORY_PATH =
  /(?:^|[\\/])\.claude[\\/]projects[\\/][^\\/]+[\\/]memory(?:[\\/]|$)/;

/**
 * Whether a tool call looks in Claude Code's own memory ("read": a Read of a
 * file there, a Grep whose path or glob is there, a Glob under it, its pattern
 * read from its path) or writes there ("write": a Write or an Edit of a file
 * there), else null. Only the path decides: nothing of it is sent.
 */
export function autoMemoryLookup(call: {
  tool: string;
  [argument: string]: unknown;
}): "read" | "write" | null {
  const text = (name: string) =>
    typeof call[name] === "string" ? (call[name] as string) : "";
  const inMemory = (...paths: string[]) =>
    paths.some((path) => AUTO_MEMORY_PATH.test(path));
  if (call.tool === "Read") return inMemory(text("file_path")) ? "read" : null;
  if (call.tool === "Grep") {
    return inMemory(text("path"), text("glob")) ? "read" : null;
  }
  if (call.tool === "Glob") {
    const pattern = text("pattern");
    const path = text("path");
    return inMemory(path, pattern, path && `${path}/${pattern}`)
      ? "read"
      : null;
  }
  if (call.tool === "Write" || call.tool === "Edit") {
    return inMemory(text("file_path")) ? "write" : null;
  }
  return null;
}

/**
 * The line a write or an edit in Claude Code's own memory is given, from the
 * module itself: it needs nothing of devcorner's, so it is said with no
 * token too, as in a cloud session, and never comes too late for its result.
 * Its words are `MEMORY_RULE`'s (src/hub/system-layer.ts), the entry
 * `memory` of devcorner's ways of working, which every session is given at
 * start; a module of the plugin cannot import devcorner's own, so the words
 * are here and test/memory.test.ts holds them to that one.
 */
export const LOCAL_MEMORY_LINE =
  "devcorner: Save what every session should know in devcorner `memory`, at the narrowest scope that fits. What is only true on one machine or in one folder stays out of it.";

/**
 * Asks the hook route's `Memory` for devcorner's memories at a lookup in
 * Claude Code's own memory: their line and ids, which the window is not
 * given again once a result of it carried them (`deliver`). Fails open as
 * `recallFor` does: no token, quiet after a failure, or any error, and the
 * answer is null.
 */
async function askMemory(
  $: Engine,
  call: { agentId?: string },
): Promise<Recalled | null> {
  try {
    if ((await $.clock.now()) < recallQuietUntil) return null;
    const held = await tokenOf($);
    if (!held) return null;
    return await askLine($, held.token, {
      hook_event_name: "Memory",
      session_id: await $.session.id(),
      ...(call.agentId ? { agent_id: call.agentId } : {}),
    });
  } catch {
    await quietRecalls($);
    return null;
  }
}

/** The Memory asks on their way, by window: reads that run in parallel share one. */
const memoryAsks = new Map<string, Promise<Recalled | null>>();
/** The Memory answers a result has carried: a shared ask's line goes to one result. */
const memoryCarried = new WeakSet<Recalled>();

/**
 * The answer to a lookup in Claude Code's own memory, asked once for a
 * window: reads that run in parallel share the ask, and only the first result
 * that gets the answer carries its line, so a window is given devcorner's
 * memories once.
 */
function memoryFor(
  $: Engine,
  call: { agentId?: string },
): Promise<Recalled | null> {
  const window = call.agentId ?? "";
  const onWay = memoryAsks.get(window);
  if (onWay) return onWay;
  const asked = askMemory($, call).finally(() => {
    memoryAsks.delete(window);
  });
  memoryAsks.set(window, asked);
  return asked;
}

/** The answer a result is to carry, or null when another result of its window already did. */
function carryMemory(answer: Recalled | null): Recalled | null {
  if (answer === null || memoryCarried.has(answer)) return null;
  memoryCarried.add(answer);
  return answer;
}

/**
 * Tells devcorner a window's result carried these items, so that window is
 * not pointed to them again. Fire and forget, failing open: unsaid, the
 * window may be pointed to an item twice, never to none.
 */
async function delivered(
  $: Engine,
  window: string,
  items: readonly string[],
): Promise<void> {
  try {
    const held = await tokenOf($);
    if (!held || items.length === 0) return;
    await postHook($, held.token, {
      hook_event_name: "Recall",
      delivered: true,
      session_id: await $.session.id(),
      ...(window ? { agent_id: window } : {}),
      items,
    });
  } catch {
    // Unsaid is safe.
  }
}

async function quietRecalls($: Engine): Promise<void> {
  try {
    recallQuietUntil = (await $.clock.now()) + RECALL_BACKOFF_MS;
  } catch {
    // No clock, no quiet: the next call asks again.
  }
}

/**
 * Lines that came after their web call stopped waiting, by window: nothing
 * is marked seen for them yet, so the window's next research result carries
 * them (`deliver`), and only then are they.
 */
const lateLines = new Map<string, Recalled[]>();

/**
 * The answer a call waited for, when `asked` answered within `ms`, else null.
 * With `keep`, an answer past that is kept for the window's next result
 * (`lateLines`). The timer is stopped once the answer comes, so nothing
 * outlives the hook.
 */
function answerOf<T>(
  $: Engine,
  asked: Promise<T | null>,
  ms: number,
  keep?: (late: T) => void,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: Timer | null = null;
    const end = (answer: T | null) => {
      if (done) return;
      done = true;
      timer?.cancel();
      resolve(answer);
    };
    try {
      timer = $.clock.after(ms, () => end(null));
    } catch {
      end(null);
    }
    asked.then(
      (answer) => {
        if (!done) end(answer);
        else if (answer !== null) keep?.(answer);
      },
      () => end(null),
    );
  });
}

/**
 * Keeps a web call's late answer for its window's next result. `asked` is the
 * session count as of when the recall was asked.
 */
const keepLate = (window: string, asked: number) => {
  return (late: Recalled) => {
    // An answer that comes after its session ended is no one's.
    if (asked !== sessionNo) return;
    lateLines.set(window, [...(lateLines.get(window) ?? []), late]);
  };
};

/**
 * A tool's result with devcorner's lines after it, for the model alone: those
 * kept from earlier calls of the window's that came late, then this call's.
 * The items of every line the result carries are then marked seen for this
 * window, and no other.
 */
function deliver<R extends { deny?: unknown; context?: readonly string[] }>(
  $: Engine,
  ran: R,
  window: string,
  recalled: Recalled | null,
): R {
  if (ran.deny !== undefined) return ran;
  const carried = [
    ...(lateLines.get(window) ?? []),
    ...(recalled ? [recalled] : []),
  ];
  lateLines.delete(window);
  if (carried.length === 0) return ran;
  void delivered(
    $,
    window,
    carried.flatMap((c) => c.items),
  );
  return {
    ...ran,
    context: [...(ran.context ?? []), ...carried.map((c) => c.line)],
  };
}

// ---- Window chats ----
//
// `/dc chat` opens this window as a window chat in devcorner: each turn's
// words, live parts and reply are posted with the machine's hook token
// (ChatParts), and the person's own words typed on devcorner's page come back
// in the answer to a post, or on the held request (`{chat}`), to be typed in
// here as theirs, never over a draft and never mid-turn. Stop on the page
// aborts the turn. A tool call goes by its short
// name and a short label, or, for one of devcorner's own tools, with its
// short arguments, which devcorner reads what the call acts on from by the
// project chat's rule; its own arguments stay here, and what it went in with
// (a command, a file, an edit's diff, `toolDetail`) and what it printed
// (`keepOutput`) are sent. Nothing is mirrored until `/dc chat` in this
// window.

/**
 * What a window that mirrors a window chat is told of where its replies are
 * read: as a row of its conversation wherever its mirroring begins from none
 * (`/dc chat`, `/dc continue`, a rejoin after a restart or a resume), and
 * after each compaction while it mirrors, as the SessionStart hook's context.
 * Only what a laptop window needs on top of the chat rules devcorner gives
 * every chat, and when to title the chat, as a project chat's turn frame
 * tells its coordinator (`titleFrameLines`): the window is told no title
 * per turn, so devcorner's refusal of a title its person gave is what it
 * reads to leave theirs.
 */
export const LAPTOP_CHAT_INSTRUCTION =
  "Your replies are read in a devcorner chat, on a page or a phone, and the person may write to you from there. Write plain chat prose: short paragraphs and simple lists, no headings, no tables. Do work through devcorner's tools so it shows in the chat's tracking, and ask what is the person's to decide as a question rather than a paragraph. Keep the chat's title current: once its topic is clear, usually in your first answer, give it a title that names the topic in a few plain words with devcorner's run(action: \"title\", title), and set it again only when the topic has clearly moved on, never to reword it. Use rename only when the person asks you to name the chat, since it makes the name theirs; once devcorner says the person named it, leave its title as it is.";

/** How long a mirrored turn's parts gather before they go: the page runs about this far behind the window, plus the post. */
export const MIRROR_BATCH_MS = 250;
/** How often a mirrored turn says it still runs while nothing streams (a long tool, a permission ask): well within devcorner's two minutes before it calls the window gone. */
export const MIRROR_BEAT_MS = 30_000;
/** The most of this window's conversation an opening sends, as devcorner keeps at most that many. */
export const MAX_EXCHANGES = 100;
/** The most a tool's label holds: the tool's own first argument, cut. */
const MAX_LABEL = 120;
/** The most cells a tool call's line in a window chat gives its argument, cut at a word. */
const LINE_LABEL = 60;
/** The longest argument of a devcorner call sent for its line: longer ones (a body, a summary) name nothing it acts on. */
const LINE_ARG = 200;

/**
 * What a tool call carries for its line in a window chat: a short label of
 * its argument, or, for one of devcorner's own tools, its short arguments,
 * which go to devcorner anyway as the call itself, so devcorner names what
 * it acts on by the project chat's rule (`namedIn`, src/mcp/chat-calls.ts).
 */
export type MirrorToolInput =
  | { label: string }
  | { args: Record<string, string | number> };

/**
 * A tool call as a turn's end keeps it for the reply's line: its short name,
 * what its line carries, and what its page shows under the line when the
 * step is opened: what it went in with and what it printed.
 */
export interface MirrorTool {
  name: string;
  input: MirrorToolInput;
  /** An edit's diff, a shell call's command, a read's file (`toolDetail`); none for a call that shows none. */
  detail?: string;
  /** What it printed, as the window's terminal showed it (`toolOutput`); none while it works, and for a call that printed nothing. */
  output?: string;
}

/** A live part as devcorner's page draws a reply: text, summarised reasoning, a tool by its name. */
export type MirrorPart =
  | {
      type: "text-start" | "text-end" | "reasoning-start" | "reasoning-end";
      id: string;
    }
  | { type: "text-delta" | "reasoning-delta"; id: string; delta: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: MirrorToolInput;
      /** What the call went in with (`toolDetail`); none for a call that shows none. */
      detail?: string;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      /** What the call printed, cut as the page keeps it (`toolOutput`). */
      output: string;
      isError: boolean;
    }
  | { type: "data-ask"; data: AskState }
  | { type: "data-hold"; data: HoldState }
  | { type: "data-tasks"; data: { tasks: WindowTask[] } };

/**
 * What holds this window's turn in place while the page's words wait: a tool
 * call of the main loop that runs on (`command`), by its name and label, and
 * whether the page may move it to the background (a foreground Bash
 * command); or a dialog only the window answers (`dialog`), as a plan's
 * approval.
 */
export interface Hold {
  kind: "command" | "dialog";
  tool: string;
  label: string;
  background: boolean;
}

/** Where one hold of this window's stands, as devcorner's page is told (`data-hold`): holding, or over. */
export type HoldState =
  | { id: string; state: "held"; hold: Hold }
  | { id: string; state: "over" };

/** A task of this window's own list, Claude Code's checklist, as devcorner's page draws it: its words and where it stands. */
export interface WindowTask {
  text: string;
  state: "pending" | "in_progress" | "completed";
}

/** One question of the model's to its person, as the page draws it: its chip, its words, its options, each by its label (the answer) and its description. */
export interface AskQuestion {
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multi: boolean;
}

/** What this window waits on its person for: a tool by its name and label (never its input whole), and whether only the window can answer it (a subagent's in a window, since a background agent's dialog there waits on the hook), or the model's questions. */
export type Ask =
  | { kind: "permission"; tool: string; label: string; windowOnly: boolean }
  | { kind: "question"; questions: AskQuestion[] };

/** Where one of this window's asks stands, as devcorner's page is told (`data-ask`). */
export type AskState =
  | { id: string; state: "open"; ask: Ask }
  | { id: string; state: "answered"; by: "page" | "window"; said: string }
  | { id: string; state: "expired" };

/** The person's answer from devcorner's page: a permission allowed or denied, or each question's chosen labels. */
export type PageAnswer = { allow: boolean } | { answers: string[][] };

/** One step of a mirrored turn that made tool calls: the words written before them, "" for none, and how many it made. */
interface MirrorStep {
  text: string;
  calls: number;
}

/** This window's window chat while it mirrors one, and its turn under way. */
interface Mirror {
  /** The chat, as the person is shown it (me-k3). */
  thread: string;
  /**
   * Whether Claude Code runs this session in the background (`claude --bg`),
   * as its chat's opening or rejoin read it (`backgroundHere`, `ChatOpen`'s
   * `background`); null when it could not be read. Nobody watches a window
   * in a background session, so there a subagent's ask waits for the page.
   */
  background: boolean | null;
  /** The window's turn under way, by its id; null between turns. */
  turn: string | null;
  /**
   * The part of `turn` devcorner is sent, by its key: the turn's id, and
   * after a stop hook carried the turn on, a key of its own for each part
   * after it (`nextPart`), so each reply the window ended is a turn of the
   * chat's own. Null between turns.
   */
  key: string | null;
  /** How many parts of `turn` began before the one under way, which names the next one's key. */
  part: number;
  /** From a stop a stop hook carried on (`carryOnAtStop`) to the turn's next step: the reply the part under way ends with then, and how the next part begins. Null otherwise. */
  next: { answer: string; begin: NonNullable<Mirror["begin"]> } | null;
  /**
   * The turn's beginning, until it was posted: for `harness`, the short line
   * `turnWords` made of a prompt Claude Code or another plugin submitted, in
   * place of its text.
   */
  begin: {
    text: string;
    from: "window" | "page" | "wake" | "harness";
    took: string[];
    /** The images pasted with words typed in the window (`pastedImages`); none for any other beginning. */
    images: WindowImage[];
  } | null;
  /** Parts gathered since the last post. */
  parts: MirrorPart[];
  /** The keys of the page's words joined to the turn (`joinPageWords`) since the last post, which the next one tells devcorner. */
  join: string[];
  /** The turn's tool calls, for its kept reply's lines. */
  tools: MirrorTool[];
  /** The turn's steps that made tool calls, each its words and how many calls, as the page drew them live (`keepStep`). */
  steps: MirrorStep[];
  /** The text blocks written since the turn's last tool call: the next step's words, or the answer's. */
  said: string[];
  /** The text or reasoning block open in the stream, with its id and the response's index of it; null between blocks. */
  open: { kind: "text" | "reasoning"; id: string; index: number } | null;
  /** How many blocks the turn opened, which names the next. */
  blocks: number;
  /** The tool call whose arguments are still arriving, as JSON pieces; null when none is. */
  tool: { index: number; id: string; name: string; json: string } | null;
  /** The turn's number of its last parts posted, which names the next (`MirrorPayload.post`). */
  posted: number;
  /** This window's task list as its chat was last sent it (`windowTasks`, as JSON), so a turn sends it only when it changed. */
  tasksSent: string;
  /** This window's own commands as devcorner last took them (`windowCommands`, as JSON), so a post sends them only when they changed; null before it took any. */
  commandsSent: string | null;
  /** What runs (background commands and subagents) as devcorner last took them (`runningWork`, as JSON), so a post sends them only when they changed; null before it took any, when the next post sends them, none too. */
  runningSent: string | null;
  /** The last turn whose beginning devcorner took (its post answered), which a terminate from the page stops; null before any. */
  taken: string | null;
  /** Whether a Stop in the window held the page's words as devcorner last took a post (`tellHolds`); null before any. */
  holdsSent: boolean | null;
  batch?: Timer;
  /**
   * The posts in flight, one after another: each waits for the one before,
   * so devcorner takes a turn's beginning, parts and end in their order.
   */
  sending: Promise<void>;
  /** The posts that carry something and did not reach devcorner yet, in order: each goes, as it was, before anything after it. */
  unsent: MirrorPayload[];
  /** How many of a look's own retries failed since it was asked; 0 for a look just asked (`mirrorPost` bounds them with `MIRROR_TRIES`). */
  lookTries: number;
  /** The next try of `unsent`, while one is due. */
  retry?: Timer;
  beat?: Timer;
}

let mirror: Mirror | null = null;
/** The chat this window mirrored as its last conversation ended, which its next one in this copy rejoins (`rejoinMirror`); null otherwise. */
let endedMirror: string | null = null;
/** Counts this module's session starts and ends, so a rejoin tried again after either is dropped. */
let sessionLife = 0;
/** This window's conversation since the plugin loaded in it, what an opening sends once. */
const exchanges: { from: "person" | "window"; text: string }[] = [];
/**
 * The page's words the plugin typed in whose turn has not begun yet: their
 * keys, their words, the prompt they were submitted as, and when. Only a turn
 * that prompt began may take them (`takesTyped`): a wake's, a harness's or the
 * person's turn that came first is not theirs, and taking it would draw their
 * words under a reply that answers something else and hand them again as a
 * turn of their own. Their hold is bounded as a wake's is (`typedHolding`), so
 * a prompt whose turn never begins lets later words go after `WAKE_SETTLE_MS`
 * rather than hold them for the window's life.
 */
let typedFromPage: TypedPageWords | null = null;
interface TypedPageWords {
  keys: string[];
  text: string;
  /** The words as submitted, the prompt its turn begins with; "" for a command until its prompt is handed over. */
  prompt: string;
  /** When the words were typed in (`WAKE_SETTLE_MS` bounds their hold). */
  since: number;
}

/**
 * Whether the turn a prompt began is the one the page's words were submitted
 * as: the engine gives the turn the same text as its prompt, as it gives every
 * prompt's own turn its words (`seenFor`). Any other turn leaves them for
 * theirs (`typedFromPage`): the flag of a heard submit alone would hand them to
 * any turn that began next, a folded prompt's included.
 */
function takesTyped(typed: TypedPageWords | null, text: string): boolean {
  return typed !== null && typed.prompt !== "" && typed.prompt === text;
}

/** Whether the page's words a prompt the window holds still wait for its turn (`typedFromPage`), bounded as a wake's is (`WAKE_SETTLE_MS`). */
const typedHolding = (now: number) =>
  typedFromPage !== null && now - typedFromPage.since < WAKE_SETTLE_MS;
/** A file the person's words from devcorner's page carry, which the window fetches (`ChatFile`) and names by path. */
interface PageFile {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** A slash command the person sent from devcorner's page: its name, without the slash, and the words after it. */
interface PageCommand {
  name: string;
  args: string;
}

/**
 * The person's words from devcorner's page, as a post's answer gives them:
 * what to type, and the files to fetch first; or a slash command, which the
 * window runs alone (`runPageCommand`), never typed in.
 */
interface PageWords {
  key: string;
  text: string;
  files: PageFile[];
  command: PageCommand | null;
  /** When the person said them, by devcorner's clock (ms); null from an older devcorner. */
  at: number | null;
}

/** The page's words a post answered with, waiting for the window to be idle. */
let pageWords: PageWords[] = [];
/** Whether the files of the page's words being typed are being fetched, before the words are typed. */
let fetchingPage = false;
/**
 * The keys of the page's words that waited as the window's turn was stopped
 * in the window: they stay waiting, never typed by themselves, until words
 * come that are not among them (the person said more) or the person begins
 * a turn in the window. Null when nothing is held.
 */
let pageHeld: Set<string> | null = null;
/** The turn the page's Stop aborted, whose end holds nothing here: devcorner holds the words that waited then until the person says more or sends them now, so any the window is handed came after the Stop or were sent now. */
let stoppedFromPage: string | null = null;
/** The turn stopped in the window whose end is not answered yet, by the key its end is posted under (`Mirror.key`): the words its answer names are those that waited at the stop, and are held. */
let stoppedInWindow: string | null = null;
/**
 * Whether this window was told to stop for its chat's move to devcorner
 *: its session ends once, whichever tells it first, the stop on
 * its held request or the refusal of its next post.
 */
let stoppingForMove = false;
/**
 * The mirrored turn whose `turn.complete` is under way, until its end is
 * posted; null otherwise. The turn is over here as that event begins, so the
 * answer of a post sent while it ran (a batch on its way, as a short reply
 * ends) may land meanwhile: the words it names are typed by that event once
 * its end is posted, never by the answer. Claude Code ends a turn at once to
 * run a prompt that the turn's own `turn.complete` (or `turn.start`)
 * submitted; one submitted from another event's work (a batch's timer) waits
 * until the turn's events settle, which took the better part of a minute in
 * a real window, the page's message waiting meanwhile. Typed by the turn's
 * end, the words are also marked as said during its reply (`markDuring`).
 */
let endingTurn: string | null = null;

/**
 * The line a mirrored turn that an API failure ended says (`failureWords`),
 * kept by the turn it came in: Claude Code's `StopFailure` names no turn, but
 * comes while the window's one is under way. The end of that turn reads it
 * (`failureOf`).
 */
let failedTurn: { turn: string; words: Promise<string> } | null = null;
/** Set while a failed turn's end waits for its `StopFailure`, which may come just after `turn.complete`: calling it lets the end go on. */
let failureArrived: (() => void) | null = null;

/**
 * The effort the main loop's last model call was sent at, as `turn.step`
 * gives it: Claude Code has no call that reads the session's effort, so it
 * is known from the first call on. Null before one, or on a model that
 * takes none.
 */
let windowEffort: string | null = null;

/** What a window chat's head says the window runs on (`runsOn` on ChatOpen and ChatParts). */
interface WindowModel {
  model: string | null;
  effort: string | null;
  /** The tokens the last response was answered over, of the model's window; null before the first. */
  context: { used: number; window: number } | null;
}

/**
 * What this window runs on now: its model, as `/model` shows it, the effort
 * its last call was sent at, and how full its context is, as the status line
 * has it. Each null when Claude Code could not say.
 */
async function windowModel($: Engine): Promise<WindowModel> {
  const [model, usage] = await Promise.all([
    $.session.model().catch(() => null),
    $.session.usage().catch(() => null),
  ]);
  const used = usage?.context?.tokens;
  const window = usage?.context?.window;
  return {
    model: model || null,
    effort: windowEffort,
    context:
      typeof used === "number" && typeof window === "number" && window > 0
        ? { used, window }
        : null,
  };
}

/** The store key that keeps which chat a Claude Code session mirrors, so a restart or a resume rejoins it. */
const mirroredKey = (session: string) => `laptopChat:${session}`;

/** Keeps one exchange of this window's conversation, the newest `MAX_EXCHANGES`. */
export function keepExchange(
  kept: { from: "person" | "window"; text: string }[],
  from: "person" | "window",
  text: string,
): void {
  if (!text.trim()) return;
  kept.push({ from, text });
  if (kept.length > MAX_EXCHANGES) kept.splice(0, kept.length - MAX_EXCHANGES);
}

/**
 * A prompt as `prompt.submit` saw it: its text, where the engine says it
 * came from (`PromptOrigin`, a closed set it stamps, never read from the
 * text), the slash command it runs, whether the person never saw it typed
 * (`isMeta`), and when. `turnWords` reads it to tell the person's own
 * words from a prompt Claude Code or another plugin made.
 */
export interface PromptSeen {
  text: string;
  origin: {
    kind: string;
    name?: string;
    asUser?: true;
    server?: string;
  } | null;
  command: { name: string; args: string } | null;
  meta: boolean;
  at: number;
  /** The images pasted with it, read while this window mirrors a window chat (`pastedImages`); none otherwise. */
  images: WindowImage[];
}

/** An image pasted with a prompt, as a window chat's turn sends it (`begin.images`): its name, type and bytes in base64. */
export interface WindowImage {
  name: string;
  type: string;
  base64: string;
}

/** The most images one turn's beginning sends, and the most bytes of one, as devcorner keeps no more with one message (`MAX_CHAT_FILES`, `MAX_ATTACHMENT_BYTES`). */
export const MAX_PASTED_IMAGES = 4;
export const MAX_PASTED_BYTES = 10 * 1024 * 1024;

/**
 * The images pasted with a prompt, read whole by their engine handles while
 * the prompt is submitted (`$.prompt.media`, which answers only then, in
 * slices joined in order): at most `MAX_PASTED_IMAGES`, each within
 * `MAX_PASTED_BYTES`. An item that is no image, has no handle, or that the
 * engine could not read or refused is left out, as one too large is; the
 * prompt goes on all the same.
 */
export async function pastedImages(
  attachments: readonly PromptSubmitAttachment[] | undefined,
  read: (id: string, offset: number | undefined) => Promise<PromptMedia>,
): Promise<WindowImage[]> {
  const images: WindowImage[] = [];
  for (const item of attachments ?? []) {
    if (images.length >= MAX_PASTED_IMAGES) break;
    if (item.type !== "image" || !item.id) continue;
    const slices: string[] = [];
    let type = "";
    let offset: number | undefined;
    let whole = true;
    do {
      const slice = await read(item.id, offset).catch(() => null);
      if (
        slice === null ||
        slice.base64 === undefined ||
        slice.size > MAX_PASTED_BYTES
      ) {
        whole = false;
        break;
      }
      slices.push(slice.base64);
      type = slice.mediaType;
      offset = slice.next;
    } while (offset !== undefined);
    if (whole && slices.length > 0)
      images.push({
        name: item.filename || `pasted image ${images.length + 1}`,
        type,
        base64: slices.join(""),
      });
  }
  return images;
}

/**
 * Whether a prompt is the person's own words typed in this window, the one
 * kind whose images a window chat's turn sends: not a slash command, not a
 * prompt the person did not see typed, and not one Claude Code or a plugin
 * made, the page's words this module types in among them (`originLine`).
 */
function typedHere(seen: {
  origin: NonNullable<PromptSeen["origin"]>;
  command?: unknown;
  isMeta?: true;
}): boolean {
  return (
    seen.origin.kind !== "plugin" &&
    originLine(seen.origin) === null &&
    seen.command === undefined &&
    seen.isMeta !== true
  );
}

/** The image types a file named in a prompt is sent as, by its extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** An image file's extension at the end of a path, for the patterns below. */
const IMAGE_END = `\\.(?:${Object.keys(IMAGE_TYPES).join("|")})`;

/**
 * The image files dragged into the window with a prompt, by the path the
 * drop wrote into its words. `prompt.submit` marks no drag (a dropped file
 * that Claude Code does not attach comes as words alone), so a path counts
 * only in the form a drop writes it: an absolute path that is a whole
 * whitespace-separated token of its own, either in quotes or with at least
 * one character escaped by a backslash. A path written in a sentence does
 * not count: one inside other characters (`open("/tmp/a.png")`,
 * `src='/a.png'`, `"/a.png",`), or a bare one with nothing escaped
 * (`look at /tmp/a.png please`), which a drop with nothing to escape writes
 * the same as typing does, so such a drop is not sent either. A path typed
 * exactly as a drop writes it, quoted or escaped and standing alone, cannot
 * be told from one and counts. Each once, in the order the words name them.
 */
export function droppedImagePaths(text: string): string[] {
  const found: string[] = [];
  // Whole tokens: nothing but whitespace or the text's ends around them.
  const dropped = new RegExp(
    `(?<![^ \\t\\r\\n])(?:(['"])(/[^'"\\n]*?${IMAGE_END})\\1|(/(?:\\\\.|[^ \\t\\r\\n'"\\\\])+?${IMAGE_END}))(?![^ \\t\\r\\n])`,
    "gi",
  );
  for (const match of text.matchAll(dropped)) {
    const escaped = match[3];
    if (escaped !== undefined && !escaped.includes("\\")) continue;
    const path = match[2] ?? escaped!.replace(/\\(.)/g, "$1");
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * The image files dragged into the window (`droppedImagePaths`), read whole
 * from the disk (`$.fs.read`, which reads at most 4 MiB): each by its
 * file's name and the type its extension says, at most `MAX_PASTED_IMAGES`.
 * One that cannot be read is left out, and the prompt goes on all the same.
 */
export async function droppedImages(
  paths: readonly string[],
  read: (path: string) => Promise<{ base64: string }>,
): Promise<WindowImage[]> {
  const images: WindowImage[] = [];
  for (const path of paths) {
    if (images.length >= MAX_PASTED_IMAGES) break;
    const type = IMAGE_TYPES[path.split(".").pop()!.toLowerCase()];
    const file = await read(path).catch(() => null);
    if (type === undefined || file === null || file.base64 === "") continue;
    images.push({ name: path.split("/").pop()!, type, base64: file.base64 });
  }
  return images;
}

/** The most base64 one beginning's images take together: `MAX_PASTED_BYTES` of bytes, padded, so a turn's post (and its resend) stays small. */
const MAX_POST_BASE64 = Math.ceil(MAX_PASTED_BYTES / 3) * 4;
/** The most base64 the prompts waiting for their turn keep together (`noteSubmitted`): two beginnings' worth. */
export const MAX_KEPT_BASE64 = 2 * MAX_POST_BASE64;

/**
 * The images one beginning sends, in order: at most `MAX_PASTED_IMAGES`,
 * and together within `MAX_POST_BASE64`; one that would pass it is left out,
 * and a smaller one after it may still go.
 */
export function withinPost(images: readonly WindowImage[]): WindowImage[] {
  const kept: WindowImage[] = [];
  let total = 0;
  for (const image of images) {
    if (kept.length >= MAX_PASTED_IMAGES) break;
    if (total + image.base64.length > MAX_POST_BASE64) continue;
    total += image.base64.length;
    kept.push(image);
  }
  return kept;
}

/** What a turn of the window began with, as its window chat keeps it: the person's words, or a short line for a prompt the harness made. */
export interface TurnWords {
  from: "window" | "harness";
  text: string;
}

/** The prompts seen at `prompt.submit` whose turn has not begun yet, oldest first (`seenFor`). */
const submitted: PromptSeen[] = [];
/** The most prompts kept for a turn to begin, and how long each is kept. */
const SEEN_MAX = 20;
const SEEN_MS = 5 * 60_000;

/**
 * The tags Claude Code wraps what it puts into a prompt in: a background
 * task's notification, a reminder, a slash command's name, message and
 * arguments, a local command's output and a shell command typed with `!`
 * with its output. Their words are never the person's, and output in them
 * never leaves the laptop.
 */
const HARNESS_TAGS = [
  "task-notification",
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
] as const;

/** One harness tag's block, closed or cut off at the text's end. */
const harnessBlock = (tag: string) =>
  new RegExp(`<${tag}>[\\s\\S]*?(?:</${tag}>|$)`, "g");

/** A tag's words, the first block of it; null when the text has none. */
function tagWords(text: string, tag: string): string | null {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`).exec(text);
  return found === null ? null : found[1]!.trim();
}

/** The line a prompt from elsewhere than the person is kept as, by where the engine says it came from. */
const ORIGIN_LINES: Record<string, string> = {
  "scheduled-trigger": "A scheduled prompt ran",
  peer: "A message from another Claude session",
  "peer-send-message": "A message from another Claude session",
  "projects-relay": "A message from the coordinating session",
  coordinator: "A message from the coordinating session",
  observer: "A report from an observer agent",
  "observer-activity": "An activity digest for this agent",
  "slack-ping": "A ping from Slack",
  "auto-continuation": "Claude Code went on after an action in the window",
};

/** That line for a prompt's origin; null for the person's own (typed, from a phone or the SDK host, a plugin's `asUser`) and for one the engine could not name. */
function originLine(origin: NonNullable<PromptSeen["origin"]>): string | null {
  switch (origin.kind) {
    case "composer":
    case "bridge":
    case "sdk":
    case "unclassified":
      return null;
    case "plugin":
      if (origin.asUser === true) return null;
      return origin.name
        ? `A message from the ${origin.name} plugin`
        : "A message from a plugin";
    case "channel":
      return origin.server
        ? `A message from the ${origin.server} channel`
        : "A message from a channel";
    default:
      return ORIGIN_LINES[origin.kind] ?? "A message Claude Code made";
  }
}

/**
 * A line with its addresses and paths left out: a URL, a Windows path
 * (`C:\a`), and `/a/b`, `~/a`, `./a` or `../a` where a word or a value
 * (after `=` or `:`) begins.
 */
function withoutPaths(line: string): string {
  return line
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]*/gi, "…")
    .replace(/\b[a-z]:\\[^\s"'`)]*/gi, "…")
    .replace(/(^|[\s"'(`=:])(?:~|\.{1,2})?\/[^\s"'`)]*/g, "$1…");
}

/**
 * A background task's notification as one line: its summary, the first
 * line, with no paths and no closing note in brackets (an exit code), as
 * `Background command "Wait one minute" completed`; else what its status
 * says. Never its ids, its output file or its output.
 */
function taskLine(text: string): string {
  const summary = tagWords(text, "summary")?.split("\n")[0] ?? "";
  const line = withoutPaths(summary.replace(/\s*\([^()]*\)\s*$/, ""))
    .trim()
    .slice(0, MAX_LABEL);
  if (line !== "") return line;
  const status = tagWords(text, "status");
  if (status === "completed") return "A background task completed";
  if (status === "failed") return "A background task failed";
  if (status === "killed" || status === "stopped")
    return "A background task was stopped";
  return "A background task finished";
}

/** The line a prompt the harness made is kept as, by the first of its tags. */
function tagLine(text: string): string {
  const first = HARNESS_TAGS.map((tag) => ({
    tag,
    at: text.indexOf(`<${tag}>`),
  }))
    .filter((one) => one.at !== -1)
    .sort((a, b) => a.at - b.at)[0]?.tag;
  if (first === "task-notification") return taskLine(text);
  if (first === "system-reminder") return "A reminder from Claude Code";
  if (first?.startsWith("bash-")) return "A shell command ran in the window";
  if (first?.startsWith("local-command-"))
    return "A local command ran in the window";
  return "A message Claude Code made";
}

/** A slash command as the person typed it: `/review the diff`. */
function slashLine(name: string, args: string): string {
  const command = name.startsWith("/") ? name : `/${name}`;
  return args.trim() === "" ? command : `${command} ${args.trim()}`;
}

/**
 * What a turn of the window began with, for its window chat: the person's
 * own words, or, for a prompt the harness or another plugin made, a short
 * line of what came, never its paths, ids or output. Read from where the
 * engine says the prompt came from (`seen`, its `prompt.submit`): a slash
 * command is the person's, as typed, and a prompt the person typed is kept
 * as typed, whatever it holds. A turn with no prompt seen is read from the
 * tags Claude Code wraps its own prompts in, and keeps any words besides
 * them as the person's.
 */
export function turnWords(text: string, seen: PromptSeen | null): TurnWords {
  const origin = seen?.origin ?? null;
  if (origin?.kind === "task-notification")
    return { from: "harness", text: taskLine(text) };
  const line = origin === null ? null : originLine(origin);
  if (line !== null) return { from: "harness", text: line };
  if (seen?.command)
    return {
      from: "window",
      text: slashLine(seen.command.name, seen.command.args),
    };
  if (seen !== null)
    return seen.meta
      ? { from: "harness", text: tagLine(text) }
      : { from: "window", text };
  if (text.trimStart().startsWith("<task-notification>"))
    return { from: "harness", text: taskLine(text) };
  const named = tagWords(text, "command-name");
  if (named)
    return {
      from: "window",
      text: slashLine(named, tagWords(text, "command-args") ?? ""),
    };
  const kept = HARNESS_TAGS.reduce(
    (left, tag) => left.replace(harnessBlock(tag), ""),
    text,
  );
  const words = kept === text ? text : kept.trim();
  if (words.trim() !== "") return { from: "window", text: words };
  return { from: "harness", text: tagLine(text) };
}

/**
 * Keeps what `prompt.submit` saw of a prompt, for the turn it begins
 * (`seenFor`), in `kept`. A prompt whose words went to the turn under way
 * begins no turn and is never taken, so the images kept stay within
 * `MAX_KEPT_BASE64` together: the oldest prompts let go of theirs first,
 * and the newest always keeps its own.
 */
export function noteSubmitted(kept: PromptSeen[], seen: PromptSeen): void {
  kept.push(seen);
  if (kept.length > SEEN_MAX) kept.splice(0, kept.length - SEEN_MAX);
  let total = 0;
  for (let at = kept.length - 1; at >= 0; at--) {
    const one = kept[at]!;
    total += one.images.reduce((sum, image) => sum + image.base64.length, 0);
    if (total > MAX_KEPT_BASE64 && one !== seen) one.images = [];
  }
}

/**
 * The prompt a turn that begins with `text` was submitted as, taken from
 * those kept: the newest with the same text. Null when none is, as for a
 * slash command, whose turn begins with the command's own prompt, and the
 * turn is read from its text alone.
 */
export function seenFor(
  kept: PromptSeen[],
  text: string,
  now: number,
): PromptSeen | null {
  for (let at = kept.length - 1; at >= 0; at--)
    if (now - kept[at]!.at > SEEN_MS) kept.splice(at, 1);
  const at = kept.findLastIndex((one) => one.text === text);
  return at === -1 ? null : kept.splice(at, 1)[0]!;
}

/** A tool's short name: its full MCP name, `mcp__<server>__<tool>`, without the prefix; any other name as it is. */
const shortToolName = (name: string): string => name.replace(/^mcp__.*__/, "");

/**
 * The tools a ToolSearch call selects (`select:a,b`) by their short names, as
 * words (`select: a, b`). Any other text is as it came: a command's text is
 * what a permission ask is answered on, so it is never rewritten.
 */
export function shortToolNames(text: string): string {
  const list = /^select:(\S+)$/.exec(text)?.[1];
  return list === undefined
    ? text
    : `select: ${list.split(",").map(shortToolName).join(", ")}`;
}

/** A tool call's label: the first line of its first string argument, a ToolSearch selection by short names, cut; "" when its arguments hold none or do not parse. */
function toolLabel(json: string): string {
  return argsLabel(toolArgs(json) ?? {});
}

/** `toolLabel` of arguments already read. */
function argsLabel(args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === "string");
  return typeof first === "string"
    ? shortToolNames(first.split("\n")[0]!).slice(0, MAX_LABEL)
    : "";
}

/** The arguments of a tool call's JSON, or null when they do not parse to an object. */
function toolArgs(json: string): Record<string, unknown> | null {
  try {
    const input: unknown = JSON.parse(json);
    return input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A tool call as its line in a window chat goes: its short name, with no
 * MCP prefix (`mcp__github__get_me` is `get_me`), and, for one of
 * devcorner's own tools, its short arguments, from which devcorner names
 * what it acts on by the project chat's rule; for any other, whose
 * arguments stay here but whose own detail is sent (`toolDetail`), one
 * short label (`lineLabel`).
 */
export function toolCall(
  name: string,
  json: string,
): { toolName: string; input: MirrorToolInput; detail?: string } {
  const toolName = shortToolName(name);
  if (!DEVCORNER_TOOL.test(name)) {
    const detail = toolDetail(name, json);
    return {
      toolName,
      input: { label: lineLabel(json) },
      ...(detail === null ? {} : { detail }),
    };
  }
  const args: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(toolArgs(json) ?? {}))
    if (
      (typeof value === "string" && value.length <= LINE_ARG) ||
      typeof value === "number"
    )
      args[key] = value;
  return { toolName, input: { args } };
}

/** The most a tool call's detail, and what it printed, holds as the page draws them: devcorner keeps no more (`MAX_CHAT_TOOL_DETAIL`). */
export const MAX_TOOL_TEXT = 2_000;

/** A text's lines with no empty last one, as a text ending at a newline gives it. */
function toolLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/**
 * A text kept to `MAX_TOOL_TEXT`, its first lines whole: a line past them is
 * dropped, and the one it stops at is cut at a word, so a call that prints
 * pages sends a page, not half a line.
 */
export function cutToolText(text: string): string {
  const whole = text.trim();
  if (whole.length <= MAX_TOOL_TEXT) return whole;
  const kept: string[] = [];
  let left = MAX_TOOL_TEXT;
  for (const line of toolLines(whole)) {
    if (line.length + 1 > left) break;
    kept.push(line);
    left -= line.length + 1;
  }
  if (kept.length === 0) {
    const cut = whole.slice(0, MAX_TOOL_TEXT);
    const at = cut.search(/\s\S*$/);
    return at === -1 ? cut : cut.slice(0, at);
  }
  return `${kept.join("\n")}\n…`;
}

/**
 * A small diff of one edit, as the window's terminal draws it: the lines the
 * old and the new text share at their start and at their end kept as they
 * are, and the block between them removed and added, an `…` where text is
 * left out.
 */
export function editDiff(oldText: string, newText: string): string {
  const before = toolLines(oldText);
  const after = toolLines(newText);
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start += 1;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end += 1;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  // Text that changed nothing is no diff.
  if (removed.length === 0 && added.length === 0) return "";
  return [
    ...(start === 0 ? [] : ["…"]),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...(end === 0 ? [] : ["…"]),
  ].join("\n");
}

/** The text of an argument, when it is one. */
function argText(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

/**
 * What a tool call goes in with, as the window's own terminal shows it: an
 * edit's change as a small diff (`editDiff`), a shell call's command, a
 * read's or a write's file. Any other call shows nothing, since what it went
 * in with is not what the terminal draws. Null for none.
 */
export function toolDetail(name: string, json: string): string | null {
  const args = toolArgs(json);
  if (args === null) return null;
  switch (shortToolName(name)) {
    case "Bash": {
      const command = argText(args, "command");
      return command === null ? null : cutToolText(command);
    }
    case "Read":
    case "Write":
    case "NotebookEdit": {
      const path = argText(args, "file_path") ?? argText(args, "notebook_path");
      return path === null ? null : cutToolText(path);
    }
    case "Edit": {
      const before = argText(args, "old_string");
      const after = argText(args, "new_string");
      return before === null || after === null
        ? null
        : cutToolText(editDiff(before, after));
    }
    case "MultiEdit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const diff = edits.flatMap((raw) => {
        const edit = raw as { old_string?: unknown; new_string?: unknown };
        return typeof edit?.old_string === "string" &&
          typeof edit.new_string === "string"
          ? [editDiff(edit.old_string, edit.new_string)]
          : [];
      });
      return diff.length === 0 ? null : cutToolText(diff.join("\n"));
    }
    default:
      return null;
  }
}

/**
 * What a tool call came back with, as the window's terminal shows it: what a
 * shell call printed, its output and its errors, and the lines a read gave.
 * Any other call shows nothing: its result is the model's to read, not the
 * person's to scroll. Null for none, and for a call that printed nothing.
 */
export function toolOutput(name: string, response: unknown): string | null {
  const result = response as {
    stdout?: unknown;
    stderr?: unknown;
    file?: { content?: unknown } | null;
  } | null;
  if (result === null || typeof result !== "object") return null;
  if (shortToolName(name) === "Bash") {
    const parts = [result.stdout, result.stderr].filter(
      (one): one is string => typeof one === "string" && one.trim() !== "",
    );
    return parts.length === 0 ? null : cutToolText(parts.join("\n"));
  }
  if (shortToolName(name) !== "Read") return null;
  const content = result.file?.content;
  return typeof content === "string" && content.trim() !== ""
    ? cutToolText(content)
    : null;
}

/**
 * A tool call's label as its line in a window chat says it, cut at a word
 * to one short line: the first line of its first string argument, a path
 * (an argument named `path` or `..._path`, as `file_path`) by its file's
 * name alone, and a command by its first words, a leading `cd <dir> &&`
 * left out, and a ToolSearch selection by short names (`shortToolNames`); ""
 * for none.
 */
export function lineLabel(json: string): string {
  const [key, value] =
    Object.entries(toolArgs(json) ?? {}).find(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ) ?? [];
  const first = shortToolNames(value?.split("\n")[0]!.trim() ?? "");
  const words = /(?:^|_)path$/.test(key ?? "")
    ? (first
        .split(/[\\/]/)
        .filter((piece) => piece !== "")
        .at(-1) ?? first)
    : first.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
  return (
    cutAtWord(words, LINE_LABEL) ??
    `${Array.from(words)
      .slice(0, LINE_LABEL - 1)
      .join("")}…`
  );
}

/**
 * What a turn that an API failure ended says on the page, by the kind Claude
 * Code names (`StopFailure`'s `error`): what happened and what to do, in one
 * plain line, never the API's own words. A usage limit has its own line
 * (`failureText`), which says when it resets once that is known.
 */
const FAILURE_WORDS: Record<string, string> = {
  overloaded:
    "Claude is overloaded right now, so this turn did not finish. Send the message again in a minute.",
  server_error:
    "Claude had a server error, so this turn did not finish. Send the message again.",
  authentication_failed:
    "Claude Code could not sign in to Claude, so this turn did not finish. Sign in again in the window with /login, then send the message again.",
  oauth_org_not_allowed:
    "Your Claude organization does not allow this sign-in, so this turn did not finish. Sign in with another account in the window with /login, then send the message again.",
  billing_error:
    "Your Claude account has a billing problem, so this turn did not finish. Fix it in your Claude account settings, then send the message again.",
  account_on_hold:
    "Your Claude account is on hold, so this turn did not finish. Contact Anthropic support, then send the message again.",
  verification_required:
    "Claude needs you to verify your account, so this turn did not finish. Do it in the window, then send the message again.",
  invalid_request:
    "Claude did not accept the request, so this turn did not finish. If the chat is long, run /compact in the window, then send the message again.",
  model_not_found:
    "Your account cannot use the model this window runs on, so this turn did not finish. Pick another with /model in the window, then send the message again.",
  max_output_tokens:
    "Claude's reply reached its length limit, so this turn did not finish. Ask for it in smaller steps.",
  cloud_credential_error:
    "Claude Code could not get its cloud credentials, so this turn did not finish. Renew them in the window, then send the message again.",
};

/** For a failure whose kind is none of those above, or not known. */
const FAILURE_UNKNOWN =
  "This turn ended on an error, so it did not finish. Send the message again; if it fails again, look at the window.";

/**
 * How long the end of a turn that an API failure ended waits for the kind
 * of that failure, which `StopFailure` names and Claude Code does not order
 * against `turn.complete`, and how long the windows' reading may take for a
 * usage limit's reset time: past it the line goes without.
 */
export const FAILURE_WAIT_MS = 1_000;

/** A window's usage counts as used up from this percent, as readings are rounded. */
const LIMIT_USED_PERCENT = 99;

/**
 * When the usage limit a failed turn hit resets, from the windows' reading:
 * the latest reset among the 5-hour and weekly windows used up that have not
 * passed, since the turn can go on only when all of them have. Null when
 * none is used up (a reading taken before the limit was hit says so too), or
 * none says when.
 */
export function limitResetAt(
  limits: readonly Limit[],
  nowMs: number,
): number | null {
  let latest: number | null = null;
  for (const l of limits) {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
    if (
      (l.kind !== "five_hour" && l.kind !== "seven_day") ||
      l.percentUsed < LIMIT_USED_PERCENT ||
      Number.isNaN(at) ||
      at <= nowMs
    )
      continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * A reset time in words for the person, in their time zone (`timeZone` names
 * another, for a test): "at 9:00 PM GMT+1" on the day, else with the day,
 * "on Mon, Nov 23 at 9:00 PM GMT+1".
 */
export function resetWords(
  at: number,
  nowMs: number,
  timeZone?: string,
): string {
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const time = new Date(at).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return day(at) === day(nowMs) ? `at ${time}` : `on ${day(at)} at ${time}`;
}

/**
 * The line of a failed turn: by the kind of failure (`error`, null when not
 * known), and for a usage limit when it resets (`resetsAt`, null when not
 * known).
 */
export function failureText(
  error: string | null,
  resetsAt: number | null,
  nowMs: number,
  timeZone?: string,
): string {
  if (error === "rate_limit")
    return resetsAt === null
      ? "Claude hit a rate limit, most often the usage limit of your plan, so this turn did not finish. Send the message again once the limit resets."
      : `Claude's usage limit is reached, so this turn did not finish. It resets ${resetWords(resetsAt, nowMs, timeZone)}; send the message again then.`;
  return (error === null ? undefined : FAILURE_WORDS[error]) ?? FAILURE_UNKNOWN;
}

/** The usage windows now, none when the reading takes longer than `FAILURE_WAIT_MS` or fails. */
function windowsOf($: Engine): Promise<readonly Limit[]> {
  return new Promise((resolve) => {
    const timer = $.clock.after(FAILURE_WAIT_MS, () => resolve([]));
    $.session.usage().then(
      (usage) => {
        timer.cancel();
        resolve(usage.rateLimits);
      },
      () => {
        timer.cancel();
        resolve([]);
      },
    );
  });
}

/** The line of a turn that failed on `error`, with the time its usage limit resets read from the windows now; the line without it where they cannot be read. */
async function failureWords($: Engine, error: string): Promise<string> {
  try {
    const now = await $.clock.now();
    const limits = error === "rate_limit" ? await windowsOf($) : [];
    return failureText(error, limitResetAt(limits, now), now);
  } catch {
    return failureText(error, null, 0);
  }
}

/**
 * The line of the window's turn `turn`, which an API failure ended: that of
 * its `StopFailure`, waited for a moment when that has not come yet, else
 * the line for a failure of no known kind.
 */
async function failureOf($: Engine, turn: string): Promise<string> {
  if (failedTurn?.turn !== turn)
    await new Promise<void>((resolve) => {
      const timer = $.clock.after(FAILURE_WAIT_MS, resolve);
      failureArrived = () => {
        timer.cancel();
        resolve();
      };
    });
  failureArrived = null;
  const failed = failedTurn;
  failedTurn = null;
  return failed?.turn === turn ? failed.words : failureText(null, null, 0);
}

/**
 * The live parts one chunk of a `turn.step` response makes: text and
 * thinking as they arrive, each content block opened and closed as one; a
 * tool call by its name, labelled from its arguments once they are all in
 * (the next block or the stop), and never its output, which no chunk
 * carries. A stop closes what is open; the engine's own chunks make nothing.
 */
export function stepParts(
  state: Pick<Mirror, "open" | "blocks" | "tool">,
  chunk: TurnStepChunk,
): MirrorPart[] {
  const parts: MirrorPart[] = [];
  const close = () => {
    if (state.open === null) return;
    parts.push({ type: `${state.open.kind}-end`, id: state.open.id });
    state.open = null;
  };
  const write = (block: "text" | "reasoning", index: number, delta: string) => {
    if (delta === "") return;
    if (state.open?.kind !== block || state.open.index !== index) {
      close();
      state.blocks += 1;
      state.open = { kind: block, id: `b${state.blocks}`, index };
      parts.push({ type: `${block}-start`, id: state.open.id });
    }
    parts.push({ type: `${block}-delta`, id: state.open.id, delta });
  };
  // A tool call's arguments are in once another block begins or the
  // response stops.
  const tool = state.tool;
  if (tool !== null && chunk.kind !== "input" && chunk.kind !== "engine") {
    state.tool = null;
    parts.push({
      type: "tool-input-available",
      toolCallId: tool.id,
      ...toolCall(tool.name, tool.json),
    });
  }
  switch (chunk.kind) {
    case "text":
      write("text", chunk.index, chunk.text);
      break;
    case "thinking":
      write("reasoning", chunk.index, chunk.text);
      break;
    case "tool":
      close();
      state.tool = {
        index: chunk.index,
        id: chunk.id,
        name: chunk.name,
        json: "",
      };
      break;
    case "input":
      if (state.tool?.index === chunk.index) state.tool.json += chunk.json;
      break;
    case "stop":
      close();
      break;
    case "engine":
      break;
  }
  return parts;
}

/**
 * How long after a failed post, or a failed rejoin, it is tried again. A
 * post of the turn under way is tried until it goes; one of a turn already
 * over is given up once `MIRROR_END_TRIES` of its retries failed, and a
 * rejoin once it failed `MIRROR_TRIES` times in all.
 */
export const MIRROR_RETRY_MS = 5_000;
const MIRROR_TRIES = 3;
/**
 * How many retries a post of a turn already over is given before it is
 * given up, each waiting twice the one before it (`mirrorRetryMs`): 5, 10,
 * 20, 40 and 40 s, about two minutes in all, past the minute devcorner asks
 * to be left alone while a deploy of it settles. A turn's end given up is
 * not lost for good: the held request says the window no longer owes it,
 * and devcorner says on the page that its reply did not come.
 */
export const MIRROR_END_TRIES = 5;

/** How long until the next try of a post that failed: doubling with each of its retries that failed, up to 40 s. */
function mirrorRetryMs(payload: MirrorPayload | undefined): number {
  return MIRROR_RETRY_MS * 2 ** Math.min(payload?.tries ?? 0, 3);
}
/** The most parts one post carries, as devcorner keeps no more of one (`MAX_POST_PARTS`, src/mcp/laptop-chat.ts): more go in the posts after it. */
export const MIRROR_POST_PARTS = 400;

/** One post of a window chat, as it is sent: read from the mirror before any wait, so a turn that begins meanwhile never takes another's parts. */
interface MirrorPayload {
  thread: string;
  /** The turn devcorner keeps it under: a part's key (`Mirror.key`). */
  turn: string | null;
  /** The window's turn it is a part of, which a stop aborts; never sent. Null for a look and a command's turn (`commandTurn`). */
  of: string | null;
  begin: Mirror["begin"];
  parts: MirrorPart[];
  /** The keys of the page's words joined to the turn since the post before (`Mirror.join`); empty for none. */
  join: string[];
  /** How long the window held each of the page's messages its beginning took or it joined (`heldFor`), by key; empty for none. */
  held: Record<string, number>;
  /**
   * The turn's number of its parts (1, 2, 3...), the last one given when it
   * carries none: devcorner keeps parts once by it, so a post sent again
   * after an answer that never came doubles nothing. 0 between turns.
   */
  post: number;
  end: {
    text: string;
    tools: MirrorTool[];
    steps: MirrorStep[];
    /** `failed` for a turn an API failure ended (`failureWords`) and for a command from the page the window did not run (`commandTurn`). */
    outcome: "done" | "stopped" | "failed";
  } | null;
  /** How many of its retries failed once its turn was over. */
  tries: number;
}

/** Whether a post carries what devcorner must take: a beginning, parts or an end. A look or a beat carries none, and a failed one is not kept; a look is asked again by itself, bounded (`mirrorPost`). */
const carries = (payload: MirrorPayload) =>
  payload.begin !== null ||
  payload.parts.length > 0 ||
  payload.join.length > 0 ||
  payload.end !== null;

/**
 * One post of this window's window chat (ChatParts): the turn's beginning,
 * the parts gathered and its end, or with `look` a look at what waits; `turn`
 * names the turn when it is not the one under way (its end, posted as the
 * next may begin). Its answer is acted on: a stop aborts the turn, a move of
 * a held command to the background aborts it keeping the page's words
 * (`backgroundFromPage`), the person's words are typed in once the window is
 * idle, and a chat this
 * window no longer holds (moved, turned off, ended) stops the mirror, said
 * on a toast. A post that carries something and fails is kept, as it was,
 * and goes before anything after it, with the next post that has something
 * new or at its retry (`retry`): so a turn's posts reach devcorner in their
 * order, each once by its number. With `whole`, it sends that post, a turn
 * begun and ended in one (`commandTurn`), in the same order.
 */
async function mirrorPost(
  $: Engine,
  what: {
    look?: boolean;
    turn?: string | null;
    end?: { text: string; outcome: "done" | "stopped" | "failed" };
    whole?: MirrorPayload;
    retry?: boolean;
    /** A look only to say the hold (`tellHolds`): none goes once a post before it said it. */
    holds?: boolean;
  },
): Promise<void> {
  const m = mirror;
  if (m === null) return;
  // A look carries no parts, so the batch under way still goes.
  if (!what.look) {
    m.batch?.cancel();
    m.batch = undefined;
  }
  const build = (): MirrorPayload => {
    const turn = what.look ? null : what.turn !== undefined ? what.turn : m.key;
    const parts = turn === null ? [] : m.parts.splice(0, MIRROR_POST_PARTS);
    if (parts.length > 0) m.posted += 1;
    const begin = turn === null ? null : m.begin;
    const join = turn === null ? [] : m.join.splice(0);
    const payload: MirrorPayload = {
      thread: m.thread,
      turn,
      of: turn === null ? null : m.turn,
      begin,
      parts,
      join,
      held: heldFor([...(begin?.took ?? []), ...join]),
      post: turn === null ? 0 : m.posted,
      // An end goes with the turn's last parts.
      end:
        what.end && turn !== null && m.parts.length === 0
          ? {
              text: what.end.text,
              tools: m.tools.map((tool) => ({ ...tool })),
              steps: m.steps.map((step) => ({ ...step })),
              outcome: what.end.outcome,
            }
          : null,
      tries: 0,
    };
    if (turn !== null) m.begin = null;
    return payload;
  };
  // A turn's end is read now, before the next turn begins, in as many posts
  // as its parts take, and joins the posts to send at once, so a post queued
  // before it that builds the next turn's beginning sends it first; any
  // other post is read when its place in the queue comes.
  const ending: MirrorPayload[] = what.whole ? [what.whole] : [];
  while (what.end) {
    const payload = build();
    ending.push(payload);
    if (payload.end !== null || payload.turn === null) break;
  }
  m.unsent.push(...ending);
  const sent = m.sending.then(async () => {
    // Behind posts that failed, a post with nothing new (a look, a beat)
    // waits for their retry.
    const fresh =
      ending.length > 0 ||
      m.begin !== null ||
      m.parts.length > 0 ||
      m.join.length > 0;
    if (!what.retry && !fresh && m.unsent.length > 0) return;
    if (!(await sendUnsent($, m, what.retry === true))) return;
    if (ending.length > 0) return;
    if (what.holds && m.holdsSent === (pageHeld !== null)) return;
    let payload = build();
    if (!carries(payload)) {
      // A look that failed is asked again by itself: it is what fetches the
      // page's words a held request was told of, so a post that failed after
      // devcorner took it would otherwise leave them waiting until the
      // window's next turn. Only a look a hold was told to make (a `{chat}`
      // frame, `tellHolds`) or such a look's own retry: a beat or a batch
      // that carries nothing is not sent again, as before, and never starts
      // the count over. Bounded like a post of a turn already over
      // (`MIRROR_TRIES`).
      if (what.look && !what.retry) m.lookTries = 0;
      if (await sendMirror($, m, payload)) m.lookTries = 0;
      else if (
        mirror === m &&
        (what.look === true || what.retry === true) &&
        m.lookTries < MIRROR_TRIES
      ) {
        m.lookTries += 1;
        m.retry ??= $.clock.after(MIRROR_RETRY_MS, () => {
          m.retry = undefined;
          if (mirror === m) void mirrorPost($, { retry: true });
        });
      }
      return;
    }
    // Parts past one post's most go in the posts after it.
    for (;;) {
      m.unsent.push(payload);
      if (!(await sendUnsent($, m, false))) return;
      if (payload.parts.length < MIRROR_POST_PARTS) return;
      payload = build();
      if (!carries(payload)) return;
    }
  });
  m.sending = sent.catch(() => undefined);
  await sent;
}

/**
 * Sends the posts that did not reach devcorner yet, in order, until one
 * fails, which is tried again in `mirrorRetryMs` with what gathered behind
 * it: until it goes while its turn is under way, and given up once that turn
 * is over and `MIRROR_END_TRIES` of its retries failed. Only a retry counts, so
 * the posts after it never spend its tries. Whether all went.
 */
async function sendUnsent(
  $: Engine,
  m: Mirror,
  retry: boolean,
): Promise<boolean> {
  while (m.unsent.length > 0) {
    if (mirror !== m) return false;
    const payload = m.unsent[0]!;
    if (await sendMirror($, m, payload)) {
      m.unsent.shift();
      continue;
    }
    if (
      retry &&
      (payload.of === null || payload.of !== m.turn) &&
      ++payload.tries >= MIRROR_END_TRIES
    )
      m.unsent.shift();
    const waits =
      m.unsent.length > 0 ||
      m.begin !== null ||
      m.parts.length > 0 ||
      m.join.length > 0;
    if (waits && mirror === m)
      m.retry ??= $.clock.after(mirrorRetryMs(m.unsent[0]), () => {
        m.retry = undefined;
        if (mirror === m) void mirrorPost($, { retry: true });
      });
    return false;
  }
  return true;
}

/** Sends one post and acts on its answer, the row saying whether it went. Whether devcorner answered it: taken, or refused for a chat this window no longer holds. */
async function sendMirror(
  $: Engine,
  m: Mirror,
  payload: MirrorPayload,
): Promise<boolean> {
  const went = await postMirror($, m, payload);
  if (mirror === m) await mirrorReached($, went);
  // A post that went shows devcorner takes this window's posts: the holds
  // that failed or answered at once before it are over, as a hold that ran
  // its length shows.
  if (went) {
    holdFailures = 0;
    holdAfter = 0;
  }
  return went;
}

/**
 * Says on the row whether the window reaches devcorner for the chat it
 * mirrors: reconnecting from a post or a held request that failed, until
 * one goes. Written only when it changes, so a streamed reply redraws
 * nothing.
 */
async function mirrorReached($: Engine, reached: boolean): Promise<void> {
  const now = await read($, laptop).catch(() => null);
  if (now === null || now.reconnecting === !reached) return;
  await update($, laptop, (was) =>
    was === null ? null : { ...was, reconnecting: !reached },
  ).catch(() => undefined);
}

/**
 * What a post of the mirror says of the window besides the turn: a turn's
 * beginning and end say what it runs on (`/model` and `/effort` change it
 * between turns, and each reply fills the context), its beginning the
 * window's own commands when they changed since devcorner last took them
 * (`/reload-skills`, a plugin added: Claude Code raises nothing then, and
 * they change between turns), and its end where the window works
 * (`windowWhere`): its folder and branch, which may have moved into a
 * worktree since the chat opened, and where git stands there, which the page
 * shows once the window leaves, since a closed lid sends nothing as it goes.
 * All are read at once.
 */
async function saysOfWindow(
  $: Engine,
  m: Mirror,
  payload: MirrorPayload,
): Promise<{
  runsOn?: WindowModel;
  folder?: string | null;
  branch?: string | null;
  git?: WindowGit | null;
  commands?: WindowCommand[];
  running?: WindowRunning[];
}> {
  // Any post says what runs (`runningWork`), once it changed: a subagent or a
  // command starts mid-turn, and a background one's end begins a turn. A
  // mirror's first post says them even when none runs, so a list a window
  // of this chat sent before a restart is not left standing.
  const running = [...runningWork.values()];
  const runningChanged = JSON.stringify(running) !== m.runningSent;
  const ran = runningChanged ? { running } : {};
  if (!payload.begin && !payload.end) return ran;
  const [runsOn, where, commands] = await Promise.all([
    windowModel($),
    payload.end ? windowWhere($) : {},
    payload.begin ? windowCommands($) : undefined,
  ]);
  const changed =
    commands !== undefined && JSON.stringify(commands) !== m.commandsSent;
  return {
    runsOn,
    ...where,
    ...(changed ? { commands } : {}),
    ...ran,
  };
}

/** Posts one of the mirror's posts (`sendMirror`) and acts on its answer. */
async function postMirror(
  $: Engine,
  m: Mirror,
  payload: MirrorPayload,
): Promise<boolean> {
  const held = await tokenOf($).catch(() => null);
  if (!held) return false;
  try {
    const says = await saysOfWindow($, m, payload);
    const holds = pageHeld !== null;
    const res = await postEvent($, held.token, {
      hook_event_name: "ChatParts",
      thread: payload.thread,
      turn: payload.turn,
      ...(payload.begin ? { begin: payload.begin } : {}),
      ...(payload.join.length > 0 ? { join: payload.join } : {}),
      ...(Object.keys(payload.held).length > 0 ? { held: payload.held } : {}),
      parts: payload.parts,
      post: payload.post,
      ...(payload.end ? { end: payload.end } : {}),
      // Every post says whether a Stop in the window holds the page's words,
      // so the page can tell its person to type there (`tellHolds`).
      holds,
      // The copy that posts: devcorner refuses one the chat is not bound to.
      generation: GENERATION,
      ...says,
    });
    // devcorner refused the post itself (its shape, its size): it would
    // refuse it again, so it is not tried again and held ahead of the posts
    // after it. A turn's end lost so is said on the page (`mirrorSaid`).
    if (res.status === 400 || res.status === 413) return true;
    const body = JSON.parse(res.text) as {
      stop?: unknown;
      background?: unknown;
      words?: unknown;
      answers?: unknown;
      code?: unknown;
      error?: unknown;
    };
    if (res.status === 409 && typeof body.code === "string") {
      // A copy a reload replaced stops quietly whatever devcorner refused,
      // its row left as it is: the newer copy mirrors the chat in this same
      // window, draws the row and keeps the chat for a restart. Its pending
      // end's retry, refused once the newer copy took the chat back, would
      // otherwise clear that row and say the window no longer mirrors.
      if (await superseded($)) return true;
      if (mirror === m) {
        const under = m.turn;
        const why = typeof body.error === "string" ? body.error : null;
        // This copy is the window's newest, yet another copy holds the
        // chat: said, and kept for a restart's rejoin.
        if (body.code === "laptop-superseded") {
          stopMirror($, why);
          return true;
        }
        // Its person moved this chat to devcorner and told the window to stop
        // first: this session ends. Every other refusal only stops
        // the mirror.
        if (body.code === "laptop-stopped") stopForMove($, why);
        else {
          stopMirror($, why);
          // A chat this window no longer holds is not rejoined after a restart.
          void $.session
            .id()
            .then((id) => $.store.delete(mirroredKey(id)))
            .catch(() => undefined);
          // A chat its person terminated from the page stops the turn it
          // mirrored, as the page's Stop does; the window itself stays open.
          // Only a turn devcorner took the beginning of: one it never took
          // began after the terminate, in the window alone (an idle window
          // that missed the frame), and runs on. Stopped once the mirror is
          // gone, so the turn's end posts nothing.
          if (
            body.code === "laptop-ended" &&
            under !== null &&
            m.taken === under
          )
            await $.turn.abort({ turnId: under }).catch(() => undefined);
        }
      }
      return true;
    }
    if (res.status !== 200) return false;
    m.holdsSent = holds;
    if (says.commands !== undefined)
      m.commandsSent = JSON.stringify(says.commands);
    if (says.running !== undefined)
      m.runningSent = JSON.stringify(says.running);
    if (payload.begin !== null && payload.of !== null) m.taken = payload.of;
    // A stop aborts the window's turn its post was a part of, while it runs,
    // whichever of its parts the page stopped. A turn begun for asks has no
    // turn of the window's to abort: its asks the page has not answered
    // close with no answer on the page, and stay in the window.
    if (body.stop === true && payload.of !== null && m.turn === payload.of) {
      if (askTurn?.id === payload.of) {
        for (const [id, one] of [...asks])
          if (!one.taken) closeAsk($, id, "expired");
      } else {
        stoppedFromPage = payload.of;
        await $.turn.abort({ turnId: payload.of }).catch(() => undefined);
      }
    }
    // The page's ask to move a held command to the background, by its hold.
    if (typeof body.background === "string" && payload.of !== null)
      await backgroundFromPage($, payload.of, body.background);
    if (Array.isArray(body.answers)) takeAnswers(body.answers);
    if (Array.isArray(body.words)) {
      // Read first, so nothing comes between the words and what they set.
      const now = await $.clock.now();
      // One the window took alone, or joined to its turn, is never taken
      // again, though an answer sent before devcorner heard of it names it.
      pageWords = pageWordsOf(body.words).filter(
        (w) => !takenAlone.has(w.key) && !handedFromPage.has(w.key),
      );
      for (const w of pageWords)
        if (!pageHeardAt.has(w.key)) pageHeardAt.set(w.key, now);
      // devcorner answers a turn's end once it kept the reply: the words it
      // names were said before the person could read it whole.
      if (payload.end !== null && payload.of !== null)
        markDuring(
          pageWords.map((w) => w.key),
          payload.end.text,
        );
      readyPageFiles($);
      // The answer to the end of a turn stopped in the window names the
      // words that waited at the stop, some perhaps never told to the window
      // yet, so no answer before it lets any go; words the person said since
      // let go of those it held.
      const held = pageHeld;
      if (payload.end !== null && payload.turn === stoppedInWindow) {
        pageHeld = new Set(pageWords.map((w) => w.key));
        stoppedInWindow = null;
      } else if (
        held !== null &&
        stoppedInWindow === null &&
        pageWords.some((w) => !held.has(w.key))
      ) {
        pageHeld = null;
      }
      if (pageWords.length > 0) void typePageWords($);
    }
    tellHolds($);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tells devcorner, with a look, that a Stop in the window began or stopped
 * holding the page's words (`pageHeld`), when no post said it yet: the answer
 * that sets the hold comes after its own post, and a prompt Claude Code
 * drops sets it with no post at all.
 */
function tellHolds($: Engine): void {
  const m = mirror;
  if (m === null || m.holdsSent === (pageHeld !== null)) return;
  void mirrorPost($, { look: true, holds: true }).catch(() => undefined);
}

/** The words of text blocks written one after another, as one step's or one reply's. */
function saidWords(said: readonly string[]): string {
  return said
    .filter((text) => text.trim() !== "")
    .join("\n\n")
    .trim();
}

/**
 * The calls of the turn under way whose result has not come, by the engine's
 * id of each, so its `classic.PostToolUse` fills the same call's output in
 * the reply the turn's end keeps (`MirrorTool.output`).
 */
const callOutputs = new Map<string, MirrorTool>();

/**
 * Keeps one part in the turn's steps, as the page folds the live turn
 * (`liveTurn`, src/apps/app/features/chat/lib/live-parts.ts), so the kept
 * reply draws its steps where the live one did: the text blocks since the
 * last tool call are the words of the step that calls next, and a call with
 * no words before it joins the step before.
 */
function keepStep(m: Pick<Mirror, "steps" | "said">, part: MirrorPart): void {
  if (part.type === "text-start") m.said.push("");
  else if (part.type === "text-delta") {
    if (m.said.length === 0) m.said.push("");
    m.said[m.said.length - 1] += part.delta;
  } else if (part.type === "tool-input-available") {
    const words = saidWords(m.said);
    const last = m.steps.at(-1);
    if (words === "" && last !== undefined) last.calls += 1;
    else m.steps.push({ text: words, calls: 1 });
    m.said = [];
  }
}

/** Gathers the parts a chunk of the mirrored turn's response makes, its tool lines kept for the reply, and posts them soon. */
function mirrorChunk($: Engine, m: Mirror, chunk: TurnStepChunk): void {
  const parts = stepParts(m, chunk);
  if (parts.length === 0) return;
  for (const part of parts) {
    keepStep(m, part);
    if (part.type === "tool-input-available") {
      const tool: MirrorTool = {
        name: part.toolName,
        input: part.input,
        ...(part.detail === undefined ? {} : { detail: part.detail }),
      };
      m.tools.push(tool);
      callOutputs.set(part.toolCallId, tool);
      mainCalls.add(part.toolCallId);
    }
  }
  m.parts.push(...parts);
  mirrorSoon($);
}

/**
 * Begins a part of the window's turn under way in its window chat: devcorner
 * keeps it under `key` as a turn of its own, beginning with `begin`, and
 * what the turn gathers from here (its posts' numbers, tool lines, steps and
 * words) is this part's.
 */
function beginPart(
  $: Engine,
  m: Mirror,
  key: string,
  begin: NonNullable<Mirror["begin"]>,
): void {
  m.key = key;
  m.begin = begin;
  m.posted = 0;
  m.tools = [];
  m.steps = [];
  m.said = [];
  m.open = null;
  m.tool = null;
  // A chat opened since the list last changed is sent it with its turn.
  mirrorTasks($);
  void mirrorPost($, {});
}

/** The line a part of the window's turn begins with when a stop hook other than devcorner's hand-over carried the turn on. */
export const CARRIED_ON_LINE = "A stop hook carried the turn on";

/**
 * At a stop of the mirrored turn that a stop hook carried on, its answer
 * blocking the stop or adding context (`ran`, as devcorner's hand-over of
 * messages does), the window ended a reply, and Claude Code goes on in the
 * same turn. That reply (`answer`, the stop's last message, else the words
 * written since the last tool call) is kept for the part under way, which
 * ends with it at the turn's next step (`nextPart`), so devcorner keeps it
 * as an answer of its own and never as a step of what the turn does next.
 * A carry-on that comes to nothing, no step after it, ends nothing here: the
 * turn's end ends the part as any turn's. The next part begins as a turn
 * devcorner's mail woke when the hook handed devcorner's messages, else as
 * `CARRIED_ON_LINE`.
 */
function carryOnAtStop(
  ran: { block?: string; additionalContext?: string[] },
  answer: unknown,
): void {
  const m = mirror;
  if (m === null || m.turn === null) return;
  const said = [
    ...(ran.block === undefined ? [] : [ran.block]),
    ...(ran.additionalContext ?? []),
  ];
  if (said.length === 0) return;
  m.next = {
    answer: typeof answer === "string" ? answer : saidWords(m.said),
    begin: said.some(isHandOver)
      ? { text: "", from: "wake", took: [], images: [] }
      : { text: CARRIED_ON_LINE, from: "harness", took: [], images: [] },
  };
}

/**
 * At the mirrored turn's first step after a stop a stop hook carried on
 * (`carryOnAtStop`): the part under way ends with the reply the window ended
 * at that stop, and the next begins under a key of its own.
 */
function nextPart($: Engine, m: Mirror): void {
  const next = m.next;
  if (next === null || m.turn === null || m.key === null) return;
  m.next = null;
  void mirrorPost($, {
    turn: m.key,
    end: { text: next.answer, outcome: "done" },
  });
  m.part += 1;
  beginPart($, m, `${m.turn}+${m.part}`, next.begin);
}

/** Posts the mirrored turn's parts within `MIRROR_BATCH_MS`, unless a post is already due. */
function mirrorSoon($: Engine): void {
  if (mirror === null || mirror.batch !== undefined) return;
  mirror.batch = $.clock.after(MIRROR_BATCH_MS, () => {
    if (mirror !== null) mirror.batch = undefined;
    void mirrorPost($, {});
  });
}

/** Says the turn still runs every `MIRROR_BEAT_MS` while it does. */
function mirrorBeat($: Engine): void {
  if (mirror === null) return;
  mirror.beat?.cancel();
  mirror.beat = $.clock.after(MIRROR_BEAT_MS, () => {
    if (mirror === null || mirror.turn === null) return;
    // Behind a post that failed, a beat would only send that post again off
    // its retry's backoff (`mirrorRetryMs`), as the turn's beginning waiting
    // behind it counts as something to send (`mirrorPost`); the retry sends
    // what gathered, and a post that goes says the turn runs.
    if (mirror.unsent.length > 0) return mirrorBeat($);
    void mirrorPost($, {}).then(() => mirrorBeat($));
  });
}

// ---- The window's own task list ----
//
// Claude Code keeps a checklist for its main loop from the model's own task
// calls (TaskCreate and TaskUpdate, or TodoWrite where tasks are turned off).
// The plugin keeps the same list from those calls as they end, and sends it
// whole with the mirrored turn's parts (`data-tasks`) whenever it changed, so
// devcorner's page shows it beside what the chat tracks. Only the model's own
// words go: a task's subject and where it stands, never a description.

/** This window's task list, by each task's id, in the order they were made. */
const windowTasks = new Map<string, WindowTask>();

/** The states a task of Claude Code's has, as devcorner keeps them. */
const TASK_STATES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

/** The most of a task's words sent: devcorner keeps no more. */
const MAX_TASK_TEXT = 200;

/** Claude Code's answer to a task made, which names its id. */
const TASK_MADE = /^Task #(\S+) created successfully/;

/**
 * Keeps this window's task list from one of the model's task calls that ran,
 * as Claude Code keeps its own: TaskCreate adds a task once its answer names
 * its id; TaskUpdate changes one's words or state, or deletes it; TodoWrite
 * gives the whole list. An update to a task this window never saw made is
 * kept only when it names the task's words, so no task's words are made up.
 * Whether the list changed.
 */
export function keepTasks(
  tasks: Map<string, WindowTask>,
  tool: string,
  input: Record<string, unknown>,
  answer: string,
): boolean {
  const words = (value: unknown) =>
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_TEXT)
      : "";
  const stateOf = (value: unknown) =>
    typeof value === "string" && TASK_STATES.has(value)
      ? (value as WindowTask["state"])
      : null;
  switch (tool) {
    case "TaskCreate": {
      const id = TASK_MADE.exec(answer.trim())?.[1];
      const text = words(input.subject);
      if (id === undefined || text === "") return false;
      tasks.set(id, { text, state: "pending" });
      return true;
    }
    case "TaskUpdate": {
      const id = words(input.taskId);
      if (id === "") return false;
      if (input.status === "deleted") return tasks.delete(id);
      const was = tasks.get(id);
      const text = words(input.subject) || was?.text;
      if (text === undefined) return false;
      const state = stateOf(input.status) ?? was?.state ?? "pending";
      if (was?.text === text && was.state === state) return false;
      tasks.set(id, { text, state });
      return true;
    }
    case "TodoWrite": {
      if (!Array.isArray(input.todos)) return false;
      tasks.clear();
      input.todos.forEach((todo: unknown, at) => {
        const one = (todo ?? {}) as { content?: unknown; status?: unknown };
        const text = words(one.content);
        const state = stateOf(one.status);
        // Keyed apart from TaskCreate's ids, which a TaskUpdate names.
        if (text !== "" && state !== null)
          tasks.set(`todo-${at}`, { text, state });
      });
      return true;
    }
    default:
      return false;
  }
}

/** Sends this window's task list with the mirrored turn's parts when its chat was not sent it as it stands. */
function mirrorTasks($: Engine): void {
  const m = mirror;
  if (m === null || m.turn === null) return;
  const list = [...windowTasks.values()];
  const said = JSON.stringify(list);
  if (said === m.tasksSent) return;
  m.tasksSent = said;
  m.parts.push({ type: "data-tasks", data: { tasks: list } });
  mirrorSoon($);
}

/** Lets go of the mirror's timers and of its chat's page words, before it stops or another chat takes its place. */
function leaveMirror(): void {
  mirror?.batch?.cancel();
  mirror?.beat?.cancel();
  typedWait?.cancel();
  typedWait = undefined;
  mirror?.retry?.cancel();
  dropAsks();
  for (const held of holds.values()) held.timer?.cancel();
  holds.clear();
  mainCalls.clear();
  callOutputs.clear();
  backgroundedFromPage = null;
  movedFromPage = null;
  carryingOn = false;
  pageWords = [];
  takenAlone.clear();
  handedFromPage.clear();
  pageTextReady.clear();
  pageHeardAt.clear();
  windowHeld.clear();
  replyDuring.clear();
  waitedAtStart = new Set();
  pageHeld = null;
  stoppedFromPage = null;
  stoppedInWindow = null;
  failedTurn = null;
}

/** Stops mirroring this window, saying why when devcorner did. */
function stopMirror($: Engine, why: string | null): void {
  leaveMirror();
  mirror = null;
  typedFromPage = null;
  void update($, laptop, () => null).catch(() => undefined);
  if (why)
    $.ui.toast(`dc: this window no longer mirrors its window chat. ${why}`);
}

/**
 * devcorner's page moves the window chat this window mirrors to devcorner
 * and its person stops this window, so nothing is answered twice:
 * the chat is mirrored no more, the turn the window runs is aborted, and its
 * own Claude Code session ends. A window the ask reaches on its held request
 * comes here, and so does one that hears it at a post instead, refused
 * `laptop-stopped`.
 */
function stopForMove($: Engine, why: string | null): void {
  if (stoppingForMove) return;
  stoppingForMove = true;
  const running = mirror?.turn ?? null;
  stopMirror($, why);
  // A chat this window no longer mirrors is not rejoined after a restart.
  void $.session
    .id()
    .then((id) => $.store.delete(mirroredKey(id)))
    .catch(() => undefined);
  if (running !== null)
    void $.turn.abort({ turnId: running }).catch(() => undefined);
  $.ui.toast("dc: this chat is devcorner's now, so this window's session ends");
  endSession($);
}

/**
 * Ends this window's Claude Code session with Claude Code's own `/exit`, once
 * the hook that asked has returned: a command run from inside one waits on
 * the turn it holds (dc-t226), and Claude Code tears this copy down with the
 * session. One Claude Code refuses is said in the window, with what to type.
 */
function endSession($: Engine): void {
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: "exit" });
    } catch (error) {
      $.ui.toast(
        `dc: could not end this session (${commandRefused(error)}): type /exit to end it`,
      );
    }
  });
}

// ---- Asks in a window chat ----
//
// While its turn runs, the window may stop on its person: a tool's
// permission dialog, or the model's AskUserQuestion. A mirrored turn shows
// each on devcorner's page as an ask (`data-ask` parts), answerable there or
// here, and whichever answer comes first settles it. Claude Code runs a
// PermissionRequest hook beside its dialog and takes the first answer of the
// two, so the page's answer to a permission is the hook's; a tool.call hook
// on AskUserQuestion that answers while its dialog is open closes the dialog.
// A background agent's permission in a window is the exception: Claude Code
// draws its dialog only once every PermissionRequest hook has returned, so a
// hook that waited on the page kept the window blank for as long as it
// waited (2 min 42 s on 2.1.326). Such an ask goes to the page as one
// answered in the window alone (`windowOnly`), and the hook returns at once.
// Every subagent's ask in a window is: nothing the plugin hears says for sure
// whether an agent runs in the background (its definition may force it,
// Ctrl+B may move it there mid-run), and a dialog held for the page is the
// window left blank, while one the page cannot answer is only the page's
// loss. A background session (`claude --bg`) has no window anyone watches,
// so there the reason does not hold: its subagent's asks wait for the page as
// the main loop's do (`Mirror.background`), but only up to
// `BACKGROUND_ASK_HOLD_MS`: Claude Code draws that dialog once the hook
// returns, so a `claude attach` viewer gets none while it waits. Past the
// cap the hook returns, the dialog is the session's own, and the page is told
// the ask is the window's alone (`giveAskToWindow`).
// No hook is told when the person answered here, so a permission ask closes
// once its tool call ends, or at its agent's next step when no call was found
// for it, and the main loop's asks still open close as its turn ends.
// devcorner keeps an ask only in the window's turn under way, so a subagent's
// ask raised while no turn is mirrored (a background agent's, after the main
// loop's turn ended) opens a turn of its own for it (`beginAskTurn`), begun
// by the harness's line `BACKGROUND_ASK_LINE`, which ends once its last ask
// closes, saying how each closed. A subagent's ask still open as the turn
// it was asked in ends, or as the window begins a turn, is asked again in
// the turn that follows (`reopenAsks`), and its subagent's end closes it.
// The page's answer comes back on a post's answer (`answers`). While an ask
// waits on the page, the hook that waits holds devcorner's held request
// (`Wait`), which the page's answer ends with the `{chat}` frame, and then
// posts a look that takes it (`holdForPage`): a hook's own time is bounded
// (10 s) but time inside a `$` call is not, so the page may answer for as
// long as the window's dialog waits (a background session's subagent's ask,
// which has no dialog until its hook returns, for `BACKGROUND_ASK_HOLD_MS`).
// Only a tool's name and its label go, never its input whole nor anything it
// read or wrote.

/** Where holds fail, how soon a turn asks devcorner for the page's answer instead; each look after waits half as long again, up to `ASK_LOOK_MAX_MS`. */
export const ASK_LOOK_MS = 1_500;
export const ASK_LOOK_MAX_MS = 15_000;
/** How long a background session's subagent's permission ask waits for the page before its hook returns and the session's own dialog takes it. Long, as the person is often away and the page is where they answer. */
export const BACKGROUND_ASK_HOLD_MS = 30 * 60_000;
/** The most questions, options of one, and characters of one option's label the page is sent, as devcorner keeps no more (src/agent/laptop-asks.ts): a question past them is answered in the window alone. */
const ASK_MAX_QUESTIONS = 4;
const ASK_MAX_OPTIONS = 4;
const ASK_MAX_OPTION = 200;
/**
 * The tools whose permission the page is never asked for: Claude Code
 * ignores a hook's allow for a tool that needs its person's own hand in the
 * window (a plan's approval, ExitPlanMode), and AskUserQuestion is an ask of
 * its own.
 */
const WINDOW_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
]);

/** An ask open here and on the page: what it asks and whose it is (null for the main loop), how its wait ends, and whether the page's answer came. */
interface PendingAsk {
  ask: Ask;
  agent: string | null;
  /** Ends the hook's wait: with the page's answer, or null once the ask closed otherwise. */
  done: (answer: PageAnswer | null) => void;
  taken: boolean;
}

const asks = new Map<string, PendingAsk>();
/** The line a turn the plugin begins for a subagent's ask while no turn is mirrored is kept as (`beginAskTurn`). */
export const BACKGROUND_ASK_LINE = "A background agent waits on your answer";
/**
 * The mirrored turn the plugin began for asks (`beginAskTurn`), by its id,
 * and how each ask closed in it, its reply's lines; null while none is under
 * way. A page command's (`command`) does not end as its last ask closes: the
 * command ends it with what it came to (`endAskTurn`).
 */
let askTurn: { id: string; said: string[]; command: boolean } | null = null;
/** Names the turns begun for asks, with the clock's time, so no two share a key. */
let askTurns = 0;
let askLook: Timer | undefined;
/** How long the next look waits. */
let askLookMs = ASK_LOOK_MS;
/** The permission asks no tool call of the turn was found for, which the turn's next step closes as answered in the window. */
const looseAsks = new Set<string>();
/** The page's answer to each permission ask under its tool call's id, until the call's end says whose answer Claude Code took. */
const pageAllowed = new Map<string, boolean>();
/**
 * The tool calls of the mirrored turn under way, in the order they began,
 * each by its tool, its agent (null for the main loop) and its `tool.call`
 * input: a permission ask is told by the oldest still without one that
 * matches all three, as Claude Code's PermissionRequest names no call.
 */
const callsUnderWay: {
  id: string;
  tool: string;
  agent: string | null;
  input: object;
  asked: boolean;
}[] = [];
/** The keys of a `tool.call` input that are not the tool's own arguments. */
const CALL_KEYS: ReadonlySet<string> = new Set([
  "tool",
  "tool_use_id",
  "agentId",
  "consent",
  "requestMeta",
]);
/** Names an ask no tool call of the turn can be found for. */
let askCount = 0;

/** Says one state of an ask to the page with the turn's next post: at once, unless `post` is false and a post the caller makes carries it. */
function sayAsk($: Engine, data: AskState, post = true): void {
  if (mirror === null || mirror.turn === null) return;
  mirror.parts.push({ type: "data-ask", data });
  if (post) void mirrorPost($, {});
}

/**
 * Opens an ask on the page while this window mirrors a turn, resolving to
 * the page's answer, or to null once it closed otherwise (answered here, the
 * turn ended, the mirror stopped); null at once with no turn mirrored. The
 * caller looks for the page's answer with `holdForPage`.
 */
function openAsk(
  $: Engine,
  id: string,
  ask: Ask,
  agent: string | null,
): Promise<PageAnswer | null> {
  if (mirror === null || mirror.turn === null || asks.has(id))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    asks.set(id, { ask, agent, done: resolve, taken: false });
    sayAsk($, { id, state: "open", ask });
  });
}

/**
 * Begins a turn of the mirror's own for an ask while no turn is mirrored:
 * devcorner keeps an ask only in the window's turn under way, and a
 * background agent may ask after the main loop's turn ended. Begun as the
 * harness's line, as a turn a background task's end begins, beating as any
 * turn does; it ends once its last ask closes (`endAskTurn`), or as the
 * window begins a turn of its own. Whether it began one.
 *
 * With `command`, the turn is a page command's, begun before it ends since
 * it waits on its person (`switchOnPage`, `dialogOnPage`): under the key its
 * whole post would take (`commandTurn`), as the person's line taking their
 * words, and ended by the command (`runPageCommand`); begun with no wait, so
 * its caller's check of the command still holds.
 */
async function beginAskTurn(
  $: Engine,
  command?: { key: string; line: string },
): Promise<boolean> {
  if (mirror === null || mirror.turn !== null) return false;
  const id =
    command === undefined
      ? `asks-${await $.clock.now()}-${++askTurns}`
      : `page-command-${command.key}`;
  const m = mirror;
  if (m === null || m.turn !== null) return false;
  askTurn = { id, said: [], command: command !== undefined };
  if (command !== undefined) commandTurnsBegun.add(command.key);
  m.turn = id;
  m.part = 0;
  m.parts = [];
  beginPart(
    $,
    m,
    id,
    command === undefined
      ? { text: BACKGROUND_ASK_LINE, from: "harness", took: [], images: [] }
      : { text: command.line, from: "page", took: [command.key], images: [] },
  );
  mirrorBeat($);
  return true;
}

/**
 * Ends the turn begun for asks (`beginAskTurn`) while it is the mirrored one,
 * its reply saying how each ask closed, or for a page command what it came
 * to (`end`), and any still open that the turn after it asks again.
 */
function endAskTurn($: Engine, end?: CommandEnd): void {
  const m = mirror;
  const ending = askTurn;
  askTurn = null;
  if (m === null || ending === null || m.turn !== ending.id) return;
  const open = [...asks.values()]
    .filter((one) => !one.taken)
    .map((one) => `- ${askWhat(one.ask)}: still waiting, asked again below`);
  m.beat?.cancel();
  void mirrorPost($, {
    turn: m.key,
    end: {
      text: [...(end === undefined ? ending.said : [end.text]), ...open].join(
        "\n",
      ),
      outcome: end?.outcome ?? "done",
    },
  });
  m.turn = null;
  m.key = null;
  m.next = null;
}

/** Asks again in the mirrored turn now under way each ask still waiting on the page, since devcorner keeps a turn's asks none of the next's. */
function reopenAsks($: Engine): void {
  const waiting = [...asks].filter(([, one]) => !one.taken);
  if (waiting.length === 0) return;
  for (const [id, one] of waiting)
    sayAsk($, { id, state: "open", ask: one.ask }, false);
  void mirrorPost($, {});
}

/** What an ask asks, in a few words, for the reply of the turn begun for it: a tool by its name and label, or its first question. */
function askWhat(ask: Ask): string {
  if (ask.kind === "question")
    return ask.questions[0]?.question ?? "A question";
  return ask.label === "" ? ask.tool : `${ask.tool} (${ask.label})`;
}

/**
 * Looks for the page's answer to ask `id` while it waits, from inside `$`
 * calls alone: devcorner's held request, which the page's answer ends at
 * once (`{chat}`), then a look post, whose answer carries it. A hook that
 * awaits this spends almost none of its own time (`HookBudget` counts only
 * the gaps between those calls), so the page can answer for as long as the
 * window's dialog waits. Resolves once the ask is answered or closed; or,
 * once holds fail or answer at once `QUICK_MAX` times in a row, hands the
 * looking to the clock (`lookForAnswers`), whose waits a hook pays from
 * its own time. A `{chat}` frame given at once counts as quick, as in
 * `hold`: devcorner gives it to every hold until a post is heard, so posts
 * that never go would otherwise hold again and again at once.
 */
function holdForPage($: Engine, id: string): Promise<void> {
  return holdWhile(
    $,
    () => {
      const pending = asks.get(id);
      return (
        pending !== undefined && !pending.taken && !byWindowAlone(pending.ask)
      );
    },
    () => {
      askLookMs = ASK_LOOK_MS;
      lookForAnswers($);
    },
  );
}

/**
 * Holds devcorner's held request while `waiting` says something waits on the
 * page, posting a look each time it ends, as `holdForPage` says; `fallback`
 * takes the looking over once holds fail or answer at once.
 */
async function holdWhile(
  $: Engine,
  waiting: () => boolean,
  fallback: () => void,
): Promise<void> {
  let quickly = 0;
  while (waiting()) {
    const began = await $.clock.now();
    const held = await waitOnce($);
    if (!waiting()) return;
    const fast = (await $.clock.now()) - began < QUICK_MS;
    // Whatever ended the hold, the look takes any answer the page gave.
    await mirrorPost($, {});
    quickly = fast ? quickly + 1 : 0;
    if (held.kind === "not-live") {
      asideEndedSession($, held.session);
      if (quickly < QUICK_MAX) continue;
    }
    if (
      held.kind === "failed" ||
      held.kind === "updating" ||
      quickly >= QUICK_MAX
    ) {
      if (waiting()) fallback();
      return;
    }
  }
}

/**
 * Turns an ask still waiting on the page into the window's alone, as its hold
 * ran out (`BACKGROUND_ASK_HOLD_MS`): the page is told, so it drops its buttons
 * for an answer that can no longer land, and the hook's wait ends.
 */
function giveAskToWindow($: Engine, id: string): void {
  const pending = asks.get(id);
  if (
    pending === undefined ||
    pending.taken ||
    pending.ask.kind !== "permission"
  )
    return;
  pending.ask = { ...pending.ask, windowOnly: true };
  sayAsk($, { id, state: "open", ask: pending.ask });
  pending.done(null);
}

/** Closes an ask still open, saying how to the page: answered (where, and in a few words), or with no answer. */
function closeAsk(
  $: Engine,
  id: string,
  how: { by: "page" | "window"; said: string } | "expired",
  post = true,
): void {
  const pending = asks.get(id);
  if (pending === undefined) return;
  asks.delete(id);
  looseAsks.delete(id);
  pending.done(null);
  // The last ask of a turn begun for asks ends it, its end post saying this;
  // a page command's ends as the command does.
  const asking = askTurn !== null && askTurn.id === mirror?.turn;
  if (asking) {
    const closed =
      how === "expired"
        ? "closed with no answer"
        : `${how.said || "answered"} ${how.by === "page" ? "from the page" : "in the window"}`;
    askTurn!.said.push(`- ${askWhat(pending.ask)}: ${closed}`);
  }
  const last = asking && asks.size === 0 && !askTurn!.command;
  sayAsk(
    $,
    how === "expired"
      ? { id, state: "expired" }
      : { id, state: "answered", ...how },
    post && !last,
  );
  if (last) endAskTurn($);
}

/**
 * Closes the asks still open with no answer as the main loop's turn ends,
 * said with the turn's end post: its own, and those no call was found for.
 * A subagent's told by its call may still wait in the window (a background
 * agent's), so the turn after asks it again (`reopenAsks`); a foreground
 * subagent's can be open at the turn's end only when the turn was aborted,
 * which ends it too, so an aborted turn closes every ask.
 */
function expireAsks($: Engine, aborted: boolean): void {
  for (const [id, one] of [...asks])
    if (aborted || one.agent === null || looseAsks.has(id))
      closeAsk($, id, "expired", false);
}

/** Closes the permission asks of an agent (null for the main loop) no tool call was found for, as answered in the window: the agent went on, so the dialog was answered. */
function closeLooseAsks($: Engine, agent: string | null): void {
  for (const id of [...looseAsks])
    if (asks.get(id)?.agent === agent)
      closeAsk($, id, { by: "window", said: "" });
}

/** Lets go of every ask with nothing said, as the mirror stops or moves. */
function dropAsks(): void {
  for (const pending of asks.values()) pending.done(null);
  asks.clear();
  looseAsks.clear();
  pageAllowed.clear();
  askLook?.cancel();
  askLook = undefined;
  askTurn = null;
  callsUnderWay.length = 0;
}

/** Whether only the window answers an ask: a subagent's permission, which no hook waits on. */
const byWindowAlone = (ask: Ask): boolean =>
  ask.kind === "permission" && ask.windowOnly;

/** The page's answers a post's answer carries, each handed to its ask's wait once. */
function takeAnswers(answers: unknown[]): void {
  for (const raw of answers) {
    if (raw === null || typeof raw !== "object") continue;
    const { id, answer } = raw as { id?: unknown; answer?: unknown };
    const pending = typeof id === "string" ? asks.get(id) : undefined;
    const read = pageAnswer(answer);
    // A devcorner on the previous code may still take one for an ask that
    // is the window's alone, which nothing here waits for.
    if (
      pending === undefined ||
      pending.taken ||
      read === null ||
      byWindowAlone(pending.ask)
    )
      continue;
    pending.taken = true;
    pending.done(read);
  }
}

/** The page's answer as devcorner sends it, else null. */
export function pageAnswer(value: unknown): PageAnswer | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { allow?: unknown; answers?: unknown };
  if (typeof raw.allow === "boolean") return { allow: raw.allow };
  if (
    Array.isArray(raw.answers) &&
    raw.answers.every(
      (one) => Array.isArray(one) && one.every((o) => typeof o === "string"),
    )
  )
    return { answers: raw.answers as string[][] };
  return null;
}

/** Posts while an ask waits on the page's answer, which a post's answer carries: soon, then less often (`ASK_LOOK_MS`, `ASK_LOOK_MAX_MS`). */
function lookForAnswers($: Engine): void {
  if (askLook !== undefined) return;
  askLook = $.clock.after(askLookMs, () => {
    askLook = undefined;
    askLookMs = Math.min(ASK_LOOK_MAX_MS, Math.round(askLookMs * 1.5));
    if (mirror === null || mirror.turn === null) return;
    if (
      ![...asks.values()].some((one) => !one.taken && !byWindowAlone(one.ask))
    )
      return;
    void mirrorPost($, {}).then(() => lookForAnswers($));
  });
}

// ---- What holds a window chat's turn ----
//
// The page's words wait while the window's turn runs, and a turn runs on
// while a tool call of its main loop does: a dev server or a build run in
// the foreground, up to its timeout, or a dialog only the window answers (a
// plan's approval, a question the page cannot show). Such a call, once it
// held the turn `HOLD_AFTER_MS`, or a dialog at once, is told to the page as
// a hold (`data-hold`), so the page says what its words wait for. A
// foreground Bash command may be moved to the background from the page: the
// post's answer names it (`background`), and the plugin aborts the turn,
// which moves a running Bash command to the background rather than stopping
// it (`backgroundedByTurnAbort`). Unlike a stop, the words that waited are
// kept and typed in once the turn ended, after a note that says the command
// runs on (`backgroundNote`); with none waiting, the note alone goes, so the
// model carries on as it does after Ctrl+B.
//
// A call is kept from `classic.PreToolUse`, which fires before it runs and
// wraps nothing, until `classic.PostToolUse`, the main loop's next step or
// its turn's end.

/** How long a tool call of the main loop runs before the page is told it holds the turn: past most calls, so the page does not flicker. */
export const HOLD_AFTER_MS = 10_000;

/** One hold of the mirrored turn: its call's id, the turn, what it is, whether the page was told, and its timer until then. */
interface HeldCall {
  id: string;
  turn: string;
  hold: Hold;
  told: boolean;
  timer: Timer | null;
}

/** The main loop's tool calls under way in the mirrored turn, by their ids, each a hold once told. */
const holds = new Map<string, HeldCall>();
/** The ids of the tool calls the mirrored main loop's last step made, as its stream names them: `classic.PreToolUse` names no agent. */
const mainCalls = new Set<string>();
/** The turn the page asked to move a held command of to the background, which this window aborted; null otherwise. */
let backgroundedFromPage: string | null = null;
/** The labels of the commands the page moved to the background, the ids of their background tasks once their results named them, until the note after them is typed. */
let movedFromPage: { labels: string[]; tasks: string[] } | null = null;
/** Set while the note `backgroundNote` submitted alone waits for its turn to begin, which is then kept as the harness's line `BACKGROUND_LINE`. */
let carryingOn = false;
/** Set while devcorner's request is held for the holds the page may move to the background (`tellHold`). */
let holdingForPage = false;

/** The line a turn begun by the note alone (`backgroundNote`) is kept as on the page. */
export const BACKGROUND_LINE =
  "Moved to the background from the page; Claude Code goes on";

/**
 * What one tool call of the main loop holds, from what `classic.PreToolUse`
 * gives: a dialog only the window answers, a command (a foreground Bash call
 * may go to the background), or nothing, for one that never holds the turn
 * (a Bash call already in the background, a question the page shows) or the
 * page lists apart (a subagent).
 */
export function holdOf(tool: string, input: unknown): Hold | null {
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (tool === "ExitPlanMode")
    return {
      kind: "dialog",
      tool,
      label: "Its plan waits for approval in the window",
      background: false,
    };
  if (tool === "AskUserQuestion")
    return askQuestions(args.questions) === null
      ? {
          kind: "dialog",
          tool,
          label: "A question the page cannot answer waits in the window",
          background: false,
        }
      : null;
  if (tool === "Bash" && args.run_in_background === true) return null;
  // A subagent is the page's line from its start (`agentOf`), in the
  // foreground or the background, so it is shown once, never as a hold too.
  if (tool === "Agent") return null;
  return {
    kind: "command",
    tool: shortToolName(tool),
    label: argsLabel(args),
    background: tool === "Bash",
  };
}

/**
 * The words that tell the model what the page did: its foreground commands
 * (`labels`) moved to the background, which run on as the background tasks
 * named (`tasks`), or, with no task named, that its turn was ended for that
 * and the command may have stopped; then to carry on, with the person's
 * words after it when `words`.
 */
export function backgroundNote(
  moved: { labels: string[]; tasks: string[] },
  words: boolean,
): string {
  const what = movedWhat(moved.labels);
  const why = words ? ", so their words below could reach you" : "";
  const then = words
    ? "Carry on from where you were, taking their words into account."
    : "Carry on from where you were.";
  if (moved.tasks.length > 0)
    return `[devcorner: your person moved ${what} to the background from devcorner's page${why}. It keeps running as background task ${moved.tasks.join(", ")}. ${then}]`;
  return `[devcorner: your person ended your turn from devcorner's page to move ${what} to the background${why}; it may not have started, or may have stopped, so check whether it runs before you rely on it. ${then}]`;
}

/** The commands moved to the background, by their labels in code: `pnpm dev`. */
function movedWhat(labels: readonly string[]): string {
  const named = labels
    .filter((label) => label !== "")
    .map((label) => `\`${label}\``)
    .join(", ");
  return named === "" ? "a foreground command" : named;
}

/** The reply of a turn ended to move its commands to the background from the page: what it had said, then a line of what moved. */
export function withMovedLine(
  answer: string,
  labels: readonly string[],
): string {
  const line = `Moved ${movedWhat(labels)} to the background from the page.`;
  return answer.trim() === "" ? line : `${answer.trimEnd()}\n\n${line}`;
}

/** Says one state of a hold to the page with the turn's next post, at once. */
function sayHold($: Engine, data: HoldState): void {
  if (mirror === null || mirror.turn === null) return;
  mirror.parts.push({ type: "data-hold", data });
  void mirrorPost($, {});
}

/**
 * Keeps a tool call of the main loop that may hold the mirrored turn, and
 * tells the page once it held it `HOLD_AFTER_MS`, a dialog at once.
 */
function beginHold($: Engine, id: string, tool: string, input: unknown): void {
  const m = mirror;
  if (m === null || m.turn === null || holds.has(id)) return;
  const hold = holdOf(tool, input);
  if (hold === null) return;
  const held: HeldCall = { id, turn: m.turn, hold, told: false, timer: null };
  holds.set(id, held);
  if (hold.kind === "dialog") tellHold($, held);
  else held.timer = $.clock.after(HOLD_AFTER_MS, () => tellHold($, held));
}

/**
 * Tells the page of a hold still under way in its turn and, for one the page
 * may move to the background, holds devcorner's request while any such hold
 * lasts, one hold of the request for them all (`holdingForPage`), so the
 * page's ask comes at once (`holdWhile`). A call held this long may still
 * wait on its permission dialog rather than run; moved then, its turn ends
 * without running it, which the note says (`backgroundNote`).
 */
function tellHold($: Engine, held: HeldCall): void {
  held.timer = null;
  if (holds.get(held.id) !== held || mirror?.turn !== held.turn) return;
  held.told = true;
  sayHold($, { id: held.id, state: "held", hold: held.hold });
  if (!held.hold.background || holdingForPage) return;
  holdingForPage = true;
  void holdWhile(
    $,
    () =>
      [...holds.values()].some(
        (one) => one.told && one.hold.background && one.turn === mirror?.turn,
      ),
    () => undefined,
  ).finally(() => {
    holdingForPage = false;
  });
}

/** Ends one hold: its timer stops, and the page, if told, is told it is over. */
function endHold($: Engine, id: string): void {
  const held = holds.get(id);
  if (held === undefined) return;
  holds.delete(id);
  held.timer?.cancel();
  if (held.told) sayHold($, { id, state: "over" });
}

/**
 * Ends every hold, and forgets the main loop's calls: it went on to its next
 * step, or its turn ended. A call whose result has not come by then keeps no
 * output to fill: nothing after the end posts it.
 */
function endHolds($: Engine): void {
  for (const id of [...holds.keys()]) endHold($, id);
  mainCalls.clear();
  callOutputs.clear();
}

/**
 * Moves the held commands of the mirrored turn to the background as the
 * page asked, by the hold's id: only a foreground Bash command still held in
 * the turn under way, once, and never a turn the page stopped. Aborting the
 * turn moves a running Bash command to the background; the turn's end then
 * keeps the page's words and types them in after the note.
 */
async function backgroundFromPage(
  $: Engine,
  turnId: string,
  id: string,
): Promise<void> {
  const held = holds.get(id);
  if (
    held === undefined ||
    !held.hold.background ||
    held.turn !== turnId ||
    mirror?.turn !== turnId ||
    stoppedFromPage === turnId ||
    backgroundedFromPage === turnId
  )
    return;
  backgroundedFromPage = turnId;
  movedFromPage = {
    labels: [...holds.values()]
      .filter((one) => one.turn === turnId && one.hold.background)
      .map((one) => one.hold.label),
    tasks: [],
  };
  await $.turn.abort({ turnId }).catch(() => {
    // A turn that ended meanwhile was not aborted: nothing moved.
    if (backgroundedFromPage === turnId) {
      backgroundedFromPage = null;
      movedFromPage = null;
    }
  });
}

/**
 * What a window chat's page lists while it runs, by its id, with one short
 * label: a command of the main loop's in the background, by its task's id,
 * or a subagent the main loop started, in the foreground or the background.
 */
export interface WindowRunning {
  id: string;
  label: string;
  kind: "command" | "subagent";
}

/**
 * What this window's main loop runs that its page lists, in the order each
 * began. Each Bash call whose result names its background task (started
 * there, or moved there by Ctrl+B or from the page), by that task's id. Each
 * subagent an Agent call of the main loop starts (`agentOf`), from the call's
 * `classic.PreToolUse`, by the call's id while the call runs (`agentCalls`):
 * one run in the foreground leaves at the call's result, or at its turn's
 * end; one launched in the background goes on by its agent's id
 * (`launchedOf`), which its task's notification names. A background task
 * leaves at its notification, at a call of the main loop that says it ended
 * (`endedBy`), or at a stop of the main loop that no longer counts it in
 * flight (`endedAtStop`). Every post of the window chat says them once they
 * changed (`saysOfWindow`).
 */
const runningWork = new Map<string, WindowRunning>();

/** The Agent calls of the main loop whose subagent `runningWork` holds by the call's id, until the call's result or its turn's end. */
const agentCalls = new Set<string>();

/**
 * Lets go of the subagents still listed by their call's id: the main loop
 * went on, or its turn ended, so each call came back or never will. One
 * launched in the background was moved to its agent's id at its result.
 */
function endAgentCalls(): void {
  for (const id of agentCalls) runningWork.delete(id);
  agentCalls.clear();
}

/** A line's label: its first line, with no paths, cut as `taskLine` cuts one. */
function runningLabel(named: string): string {
  return withoutPaths(named.split("\n")[0]!).trim().slice(0, MAX_LABEL);
}

/** What names a subagent in its line, as Claude Code's notification of its end does: its call's description, else its type. */
function agentLabel(input: unknown): string {
  const args = (input ?? {}) as {
    description?: unknown;
    subagent_type?: unknown;
  };
  return runningLabel(
    typeof args.description === "string" && args.description.trim() !== ""
      ? args.description
      : typeof args.subagent_type === "string"
        ? args.subagent_type
        : "",
  );
}

/**
 * The subagent an Agent call of the main loop starts, by the call's id, as
 * it is about to run: shown the same way whether it runs in the foreground
 * or the background, and whether or not it ever calls devcorner. Null for
 * any other call.
 */
export function agentOf(
  tool: unknown,
  id: string,
  input: unknown,
): WindowRunning | null {
  if (tool !== "Agent" || id === "") return null;
  return { id, label: agentLabel(input), kind: "subagent" };
}

/**
 * The subagent an Agent call's result says goes on in the background
 * (`async_launched`), by its agent's id, which its task's notification and
 * a stop's list of work in flight name; null for a call whose subagent ran
 * in the foreground and has ended, and for any other call.
 */
export function launchedOf(
  tool: unknown,
  input: unknown,
  response: unknown,
): WindowRunning | null {
  if (tool !== "Agent") return null;
  const result = response as { status?: unknown; agentId?: unknown } | null;
  if (
    result === null ||
    typeof result !== "object" ||
    result.status !== "async_launched" ||
    typeof result.agentId !== "string" ||
    result.agentId === ""
  )
    return null;
  return { id: result.agentId, label: agentLabel(input), kind: "subagent" };
}

/**
 * The background command a Bash call's result says it runs as, labelled as
 * Claude Code's own notification names it: by its description, else its
 * command's first line, with no paths, as `taskLine` cuts that one; null for
 * any other call or result.
 */
export function runningOf(
  tool: unknown,
  input: unknown,
  response: unknown,
): WindowRunning | null {
  if (tool !== "Bash") return null;
  const result = response as { backgroundTaskId?: unknown } | null;
  if (
    result === null ||
    typeof result !== "object" ||
    typeof result.backgroundTaskId !== "string" ||
    result.backgroundTaskId === ""
  )
    return null;
  const args = (input ?? {}) as { description?: unknown; command?: unknown };
  const named =
    typeof args.description === "string" && args.description.trim() !== ""
      ? args.description
      : typeof args.command === "string"
        ? args.command
        : "";
  return {
    id: result.backgroundTaskId,
    label: runningLabel(named),
    kind: "command",
  };
}

/** What a background task's status says once it runs no more, as `TaskOutput` and the notification give it. */
const TASK_ENDED = new Set(["completed", "failed", "killed"]);

/**
 * The background task a call of the main loop says runs no more, before
 * or without its notification: one `TaskStop` (`KillShell`, `KillBash`
 * before it) stopped, or one whose output `TaskOutput` (`BashOutput`) read
 * at its end; null for any other call or result.
 */
export function endedBy(
  tool: unknown,
  input: unknown,
  response: unknown,
): string | null {
  const args = (input ?? {}) as { task_id?: unknown; shell_id?: unknown };
  const asked =
    typeof args.task_id === "string" && args.task_id !== ""
      ? args.task_id
      : typeof args.shell_id === "string" && args.shell_id !== ""
        ? args.shell_id
        : null;
  if (tool === "TaskStop" || tool === "KillShell" || tool === "KillBash")
    return asked;
  if (tool !== "TaskOutput" && tool !== "BashOutput") return null;
  const result = (response ?? {}) as {
    task?: { status?: unknown };
    status?: unknown;
  };
  const status =
    typeof result.task === "object" && result.task !== null
      ? result.task.status
      : result.status;
  return typeof status === "string" && TASK_ENDED.has(status) ? asked : null;
}

/** The ids of the background tasks a prompt's notifications say ended, each `<task-id>` inside a `<task-notification>`. */
export function endedTasks(text: string): string[] {
  const ended: string[] = [];
  for (const block of text.matchAll(
    /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g,
  )) {
    const id = tagWords(block[1]!, "task-id");
    if (id) ended.push(id);
  }
  return ended;
}

/**
 * The background tasks of `running` that a stop's own list of the work
 * still in flight (`background_tasks`) leaves out, or names as ended: each
 * ended, by any means.
 * A kill from Claude Code's tasks dialog sends no notification and no call
 * of the main loop's, so this is the first the window hears of it. None when
 * the stop carries no list (a Claude Code before it).
 */
export function endedAtStop(
  running: Iterable<string>,
  tasks: unknown,
): string[] {
  if (!Array.isArray(tasks)) return [];
  const live = new Set(
    tasks.flatMap((task: unknown) => {
      const one = task as { id?: unknown; status?: unknown } | null;
      return typeof one?.id === "string" && !TASK_ENDED.has(String(one.status))
        ? [one.id]
        : [];
    }),
  );
  return [...running].filter((id) => !live.has(id));
}

/**
 * Keeps what a call of the main loop's printed, so its page shows it as it
 * comes and its kept reply shows it once the turn ends: the part the page
 * draws under the call (`tool-output-available`), and the call's own output
 * in the reply its end carries (`MirrorTool.output`). A subagent's calls are
 * not the chat's, and a call that printed nothing the page shows tells it
 * nothing.
 */
function keepOutput(
  $: Engine,
  e: {
    tool_name?: unknown;
    tool_use_id?: unknown;
    tool_response?: unknown;
    error?: unknown;
    agent_id?: unknown;
  },
  failed: boolean,
): void {
  const m = mirror;
  const id = typeof e.tool_use_id === "string" ? e.tool_use_id : "";
  if (m === null || e.agent_id !== undefined || id === "" || !mainCalls.has(id))
    return;
  const name = typeof e.tool_name === "string" ? e.tool_name : "";
  const output = failed
    ? cutToolText(typeof e.error === "string" ? e.error : "")
    : toolOutput(name, e.tool_response);
  mainCalls.delete(id);
  const tool = callOutputs.get(id);
  callOutputs.delete(id);
  if (output === null || output === "") return;
  if (tool !== undefined) tool.output = output;
  m.parts.push({
    type: "tool-output-available",
    toolCallId: id,
    output,
    isError: failed,
  });
  mirrorSoon($);
}

/** Keeps the background task a command the page moved runs on as, as its result names it. */
function keepMoved(response: unknown): void {
  const result = response as {
    backgroundTaskId?: unknown;
    backgroundedByTurnAbort?: unknown;
  } | null;
  if (
    movedFromPage === null ||
    result === null ||
    typeof result !== "object" ||
    result.backgroundedByTurnAbort !== true ||
    typeof result.backgroundTaskId !== "string"
  )
    return;
  if (!movedFromPage.tasks.includes(result.backgroundTaskId))
    movedFromPage.tasks.push(result.backgroundTaskId);
}

/**
 * The model's AskUserQuestion questions as the page can answer them, each a
 * choice among its options' labels, which go and come back exactly as
 * asked; null when any is not one (a free text or a number) or holds more
 * than devcorner keeps, which the page cannot answer as asked, or when two
 * ask the same words: AskUserQuestion's result holds each answer under its
 * question's words, so the page's answer to one would be the other's too.
 */
export function askQuestions(value: unknown): AskQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > ASK_MAX_QUESTIONS) return null;
  if (
    new Set(value.map((q) => (q as { question?: unknown } | null)?.question))
      .size !== value.length
  )
    return null;
  const questions: AskQuestion[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") return null;
    const q = raw as {
      question?: unknown;
      header?: unknown;
      kind?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (q.kind !== undefined && q.kind !== "choice") return null;
    if (typeof q.question !== "string" || !Array.isArray(q.options))
      return null;
    const options = q.options.flatMap((o: unknown) => {
      const option = o as { label?: unknown; description?: unknown } | null;
      return option !== null &&
        typeof option === "object" &&
        typeof option.label === "string"
        ? [
            {
              label: option.label,
              description:
                typeof option.description === "string"
                  ? option.description
                  : "",
            },
          ]
        : [];
    });
    const labels = options.map((o) => o.label);
    if (
      labels.length === 0 ||
      labels.length !== q.options.length ||
      labels.length > ASK_MAX_OPTIONS ||
      new Set(labels).size !== labels.length ||
      labels.some((o) => o.trim() === "" || o.length > ASK_MAX_OPTION)
    )
      return null;
    questions.push({
      header: typeof q.header === "string" ? q.header : "",
      question: q.question,
      options,
      multi: q.multiSelect === true,
    });
  }
  return questions;
}

/** What AskUserQuestion's result answered, in a few words: each question's answer, in order. */
function answeredWords(ran: { result?: unknown }): string {
  const answers = (ran.result as { answers?: unknown } | undefined)?.answers;
  if (answers === null || typeof answers !== "object") return "";
  return Object.values(answers)
    .filter((one): one is string => typeof one === "string")
    .join("; ");
}

/** A `tool.call` input's own arguments, as the tool is given them. */
function callArguments(input: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !CALL_KEYS.has(key)),
  );
}

/** A tool's input as one string, its keys sorted at every depth, so a call's input and its permission ask's compare equal however each was ordered. */
function inputKey(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** The person's words from the page a post's answer gives, each with the files it carries or the command it runs; anything else in it is left out. */
function pageWordsOf(given: unknown[]): PageWords[] {
  return given.flatMap((w) => {
    const one = w as {
      key?: unknown;
      text?: unknown;
      files?: unknown;
      command?: unknown;
      at?: unknown;
    } | null;
    if (
      one === null ||
      typeof one !== "object" ||
      typeof one.key !== "string" ||
      typeof one.text !== "string"
    )
      return [];
    const files = (Array.isArray(one.files) ? one.files : []).flatMap((f) => {
      const file = f as Partial<PageFile> | null;
      return file !== null &&
        typeof file === "object" &&
        typeof file.id === "string" &&
        typeof file.name === "string"
        ? [
            {
              id: file.id,
              name: file.name,
              type: typeof file.type === "string" ? file.type : "",
              size: typeof file.size === "number" ? file.size : 0,
            },
          ]
        : [];
    });
    const command = one.command as Partial<PageCommand> | null | undefined;
    return [
      {
        key: one.key,
        text: one.text,
        files,
        command:
          command !== null &&
          typeof command === "object" &&
          typeof command.name === "string" &&
          command.name !== ""
            ? {
                name: command.name,
                args: typeof command.args === "string" ? command.args : "",
              }
            : null,
        at:
          typeof one.at === "number" && Number.isFinite(one.at) ? one.at : null,
      },
    ];
  });
}

/**
 * Where a file the page sent is kept for the window to read: in the
 * plugin's folder (`stateDir`), under the conversation, named by its id and
 * its name, each made safe for a path. Undefined with no home to keep it in.
 */
export function pageFilePath(
  env: StateEnv,
  conversation: string,
  file: Pick<PageFile, "id" | "name">,
): string | undefined {
  const base = stateDir(env);
  const safe = (part: string) =>
    part
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 120);
  return base
    ? `${base}/laptop-files/${safe(conversation)}/${safe(file.id)}-${safe(file.name)}`
    : undefined;
}

/**
 * Fetches a file the page sent from devcorner (`ChatFile`, of the chat this
 * window holds, its bytes themselves) and keeps it where `pageFilePath`
 * says, readable by its owner alone and written whole, by curl, so no byte
 * passes through this module (`PAGE_FILE_SCRIPT`): the line the typed words
 * name it by, its path, or why it was not fetched (`pageFileProblem`), so
 * the words still go.
 */
async function fetchPageFile(
  $: Engine,
  thread: string,
  file: PageFile,
): Promise<string> {
  const missed = (why: string) => `- ${file.name} (not fetched: ${why})`;
  const held = await tokenOf($).catch(() => null);
  if (!held) return missed("this machine is not signed in to devcorner");
  const conversation = await $.session.id();
  const path = pageFilePath(await stateEnvOf($), conversation, file);
  if (!path) return missed("no folder to keep it in");
  const event = JSON.stringify({
    hook_event_name: "ChatFile",
    thread,
    file: file.id,
    raw: true,
    generation: GENERATION,
    session_id: conversation,
  });
  try {
    const ran = await $.process.run(
      [
        "sh",
        "-c",
        PAGE_FILE_SCRIPT,
        "sh",
        path,
        `${await baseOf($)}/mcp/hooks/claude-code`,
        event,
        String(PAGE_FILE_SECONDS),
      ],
      {
        stdin: `Authorization: Bearer ${held.token}\ncontent-type: application/json\n`,
        // curl gives up first, and says so.
        timeoutMs: (PAGE_FILE_SECONDS + 15) * 1000,
      },
    );
    const problem = pageFileProblem(ran);
    return problem === null ? `- ${path}` : missed(problem);
  } catch (error) {
    // The run itself was refused or cut ($.process is the CLI's alone).
    return missed(
      `it could not be fetched on this machine (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * The words the window types for one message of the person's from the page:
 * its words as devcorner gave them (what it quotes as Markdown, then the
 * words), and after them the paths of the files it sent, fetched first, so
 * Claude Code reads them.
 */
async function pageText(
  $: Engine,
  thread: string,
  message: PageWords,
): Promise<string> {
  const lines: string[] = [];
  for (const file of message.files)
    lines.push(await fetchPageFile($, thread, file));
  return [
    message.text,
    lines.length === 0 ? "" : `Files sent from devcorner:\n${lines.join("\n")}`,
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

/**
 * Types the person's words from devcorner's page in as their own prompt, one
 * message at a time, the oldest first, once the window is idle and nothing is
 * drafted: never over what the person is typing, never mid-turn, whose end
 * types the next (and nothing else while that end is posted, `endingTurn`),
 * and never while a stop holds them (`pageHeld`). Each
 * message is a turn of its own, as the page drew it a bubble of its own:
 * typed together, a burst said while the window answered would reach the
 * model as one prompt. The files it sent are fetched first and named by path,
 * the words held as typed (`typedFromPage`) meanwhile, so no other call types
 * them. A slash command from the page waits in its place among them and runs
 * alone when its turn comes (`runPageCommand`), never typed in. After a
 * move to the background from the page (`backgroundFromPage`), its note
 * (`backgroundNote`) goes first: before the next message's words, or alone
 * when none waits or a command is next, so the model carries on. Words never
 * go in behind a prompt the window is already holding for its turn (a wake, a
 * command, `/dc`'s ask): that prompt's turn comes first, and words typed now
 * would wait behind it while the words said after them joined it, out of the
 * order they were said.
 */
async function typePageWords($: Engine): Promise<void> {
  const waiting = () =>
    (pageWords.length > 0 || movedFromPage !== null) &&
    backgroundedFromPage === null &&
    commandFromPage === null &&
    pageHeld === null &&
    endingTurn === null &&
    !fetchingPage;
  if (!waiting()) return;
  // A prompt the window submitted has not begun its turn yet, or the page's
  // words it typed in wait for theirs: it goes first. Each wait is bounded, so
  // a turn that never begins lets the words go after `WAKE_SETTLE_MS` rather
  // than hold them for the window's life.
  const now = await $.clock.now();
  const until = Math.max(
    settling(now) ? wokeAt! + WAKE_SETTLE_MS : 0,
    typedHolding(now) ? typedFromPage!.since + WAKE_SETTLE_MS : 0,
  );
  if (until > now) {
    typedWait ??= $.clock.after(until - now, () => {
      typedWait = undefined;
      void typePageWords($);
    });
    return;
  }
  typedWait?.cancel();
  typedWait = undefined;
  if ((await read($, turn)) !== null) return;
  const draft = await $.prompt.read().catch(() => ({ text: "x" }));
  if (draft.text.trim() !== "") {
    $.clock.after(WAITING_MS, () => void typePageWords($));
    return;
  }
  // Two calls may wait above at once (a post's answer and a turn's end both
  // type the words in): the check and the take go together, with no wait
  // between, so only one takes them and the other submits nothing. The words
  // the one before it typed in hold the next until their turn begins, as they
  // do after the settle (`typedHolding`): a second call that passed the check
  // before them must not take another message meanwhile.
  if (!waiting() || typedHolding(now)) return;
  // After a move to the background from the page, the note goes with the
  // next words typed, or alone first when none waits or a command is next.
  if (
    movedFromPage !== null &&
    (pageWords.length === 0 || takesAlone(pageWords[0]!))
  ) {
    const moved = movedFromPage;
    movedFromPage = null;
    carryingOn = true;
    wokeAt = await $.clock.now();
    wakingFor = null;
    await submitFromPage($, { text: backgroundNote(moved, false) }, () => {
      carryingOn = false;
      movedFromPage ??= moved;
      wokeAt = null;
    });
    return;
  }
  if (takesAlone(pageWords[0]!)) {
    await runPageCommand($, pageWords.shift()!);
    return;
  }
  const message = pageWords.shift()!;
  // Read before any wait, while the message is still this window's to type.
  const during = replyDuring.get(message.key) ?? null;
  // Files fetched while the turn before ran (`readyPageFiles`) are not
  // fetched again.
  const ready = pageTextReady.get(message.key);
  pageTextReady.delete(message.key);
  let text = ready ?? message.text;
  if (message.files.length > 0 && ready === undefined) {
    const from = mirror;
    fetchingPage = true;
    try {
      text = await pageText($, from?.thread ?? "", message);
      // A turn begun in the window meanwhile, or one whose end is being
      // posted, which types them, words drafted meanwhile, or a stop that
      // holds them, leaves them waiting as ever; a post's answer meanwhile
      // named them again among those waiting. No other call takes a message
      // while these are read (`fetchingPage`), so the oldest goes in first.
      const running = (await read($, turn)) !== null;
      const drafted =
        !running &&
        (await $.prompt.read().catch(() => ({ text: "x" }))).text.trim() !== "";
      // Mirroring that stopped or moved to another chat meanwhile (`/dc chat
      // off`, a takeover, a detach) dropped its chat's words (`leaveMirror`):
      // these belong to a chat the window no longer mirrors. Words a chat
      // opened since was given meanwhile found this fetch under way, so they
      // are typed now.
      if (mirror !== from) {
        fetchingPage = false;
        if (pageWords.length > 0) void typePageWords($);
        return;
      }
      const since = pageWords.filter((w) => w.key !== message.key);
      if (running || drafted || pageHeld !== null || endingTurn !== null) {
        pageWords = [message, ...since];
        if (drafted) $.clock.after(WAITING_MS, () => void typePageWords($));
        return;
      }
      pageWords = since;
    } finally {
      fetchingPage = false;
    }
  }
  replyDuring.delete(message.key);
  // The note of a move to the background goes before the words, never into
  // what devcorner keeps of them (`typedFromPage`). It says the person ended
  // that turn so their words could reach it, so they are not marked as sent
  // before its reply (`sentBefore`).
  const moved = movedFromPage;
  movedFromPage = null;
  const said = moved === null ? sentBefore(message, text, during) : text;
  const typed: TypedPageWords = {
    keys: [message.key],
    text: said,
    prompt: moved === null ? said : `${backgroundNote(moved, true)}\n\n${said}`,
    // The time the words were taken, read before the waits above: set before
    // any wait between the take and here, so a second call finds them held.
    since: now,
  };
  typedFromPage = typed;
  for (const key of typed.keys) handedFromPage.add(key);
  wokeAt = typed.since;
  wakingFor = null;
  await submitFromPage($, { text: typed.prompt, asUser: true }, () => {
    pageWords = [message, ...pageWords.filter((w) => w.key !== message.key)];
    for (const key of typed.keys) handedFromPage.delete(key);
    if (during !== null && !replyDuring.has(message.key))
      replyDuring.set(message.key, during);
    if (typedFromPage === typed) typedFromPage = null;
    movedFromPage ??= moved;
    wokeAt = null;
  });
}

/**
 * Submits the prompt that types the page's words, or a move's note; when
 * Claude Code does not take it, `putBack` gives back what it took. Refused
 * that way, `$.prompt.submit` rejects; but a Stop pressed in the window (Esc,
 * or Ctrl+C at an idle prompt) makes it resolve `{ drop }` for every prompt a
 * plugin submits until the person types there, and so do the host's limits.
 * Typed again at once, the words would be dropped again, so they wait as
 * after a turn stopped in the window (`pageHeld`): words the person says
 * since on the page try again, a turn they begin in the window lets them go,
 * and the window says why.
 */
async function submitFromPage(
  $: Engine,
  prompt: { text: string; asUser?: true },
  putBack: () => void,
): Promise<void> {
  const entered = await $.prompt.submit(prompt).catch(() => null);
  if (entered !== null && entered.drop === undefined) return;
  putBack();
  if (entered === null) return;
  pageHeld = new Set(pageWords.map((w) => w.key));
  $.ui.toast(
    `dc: Claude Code refused your words from the page: ${entered.drop}`,
  );
  tellHolds($);
}

/**
 * The reply each of the page's words was said while the mirrored window
 * wrote, by its key: words that came after that reply's turn began
 * (`waitedAtStart`) and waited as it ended, or that its end post's answer
 * named (devcorner answers that post once it kept the reply). Words held
 * past a later reply (a stop, a wake's turn) keep the first. What
 * `sentBefore` marks.
 */
const replyDuring = new Map<string, string>();
/** The keys of the page's words that waited as the mirrored turn began: said before its reply, not during it. */
let waitedAtStart = new Set<string>();

/** Keeps `reply` as the one the words under `keys` were said during, for each not marked yet that came after its turn began. A reply with no words proposed nothing to mark against. */
function markDuring(keys: readonly string[], reply: string): void {
  if (reply.trim() === "") return;
  for (const key of keys)
    if (!waitedAtStart.has(key) && !replyDuring.has(key))
      replyDuring.set(key, reply);
}

/** How much of a reply the line before words sent while it was written quotes. */
const SENT_BEFORE_QUOTE = 200;

/**
 * The page's words as the window types them, after the reply they were sent
 * while it was being written (`replyDuring`): opened with a line saying when
 * they were sent, on this machine's clock, and quoting that reply, so a
 * "yes" said before the person read it is never taken as their go for what
 * it proposed. Words said during no reply (null) are typed as they are.
 */
export function sentBefore(
  message: Pick<PageWords, "at">,
  text: string,
  reply: string | null,
): string {
  const flat = reply?.replace(/\s+/g, " ").trim() ?? "";
  if (flat === "") return text;
  const cut = flat.slice(0, SENT_BEFORE_QUOTE);
  // Cut at a word, unless the words hold no space to cut at.
  const quote =
    flat.length <= SENT_BEFORE_QUOTE
      ? flat
      : `${cut.replace(/\s+\S*$/, "") || cut}…`;
  const when = message.at === null ? null : new Date(message.at);
  const time =
    when === null
      ? ""
      : ` at ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `[Sent from devcorner's page${time}, while you were still writing your reply that begins "${quote}", before your person had read it: these words do not answer that reply, so a yes or a go-ahead in them is no approval of what it proposed. If they could be read as one, ask.]\n\n${text}`;
}

/** What joins the page's words to a running turn's tool result, before them (`joinPageWords`). */
export const JOINED_FROM_PAGE =
  "Your person wrote this to you on devcorner's page of this chat while you were working: these are their own words, sent mid-turn. Take them into account now, as if they had typed them here:";

/**
 * The keys of the page's words the window has handed the model, typed in as a
 * prompt (`typePageWords`) or joined to a turn (`joinPageWords`): devcorner's
 * answers may still name them waiting until the post that took them reaches
 * it, so they are left out of every answer until the turn they are part of has
 * ended and every post went. A word is handed once, never typed or joined
 * again from an answer read before devcorner heard of it.
 */
const handedFromPage = new Set<string>();

/** The page's messages with files, fetched while a turn runs so they are ready to join it, by key: their words with the files' paths (`pageText`). */
const pageTextReady = new Map<string, string>();

/**
 * When each of the page's messages first reached this window, by key, on its
 * own clock: the answer that first named it. Its turn's beginning, or the
 * post that joins it, tells devcorner how long the window held it
 * (`windowHeld`), so a message that waited can be measured apart from its way
 * here.
 */
const pageHeardAt = new Map<string, number>();
/** How long the window held each of the page's messages a turn took or joined, by key, until a post tells devcorner (`heldFor`). */
const windowHeld = new Map<string, number>();

/** Notes the page's messages a turn took or joined now: how long the window held each since it reached it. */
function heldUntil(keys: readonly string[], now: number): void {
  for (const key of keys) {
    const heard = pageHeardAt.get(key);
    if (heard === undefined) continue;
    pageHeardAt.delete(key);
    windowHeld.set(key, Math.max(0, Math.round(now - heard)));
  }
}

/** How long the window held each of `keys` (`heldUntil`), for the post that names them, each given once. */
function heldFor(keys: readonly string[]): Record<string, number> {
  const held: Record<string, number> = {};
  for (const key of keys) {
    const ms = windowHeld.get(key);
    if (ms === undefined) continue;
    windowHeld.delete(key);
    held[key] = ms;
  }
  return held;
}
/** The keys of the messages whose files `readyPageFiles` is fetching. */
const readying = new Set<string>();

/**
 * Fetches, while the mirrored turn runs, the files of the page's messages
 * that wait, so each is ready to join the turn at its next tool result: a
 * tool's result is never held up for a fetch. A message whose files are
 * still on their way waits for the result after.
 */
function readyPageFiles($: Engine): void {
  // A message taken back on the page waits no more.
  for (const key of pageTextReady.keys())
    if (!pageWords.some((w) => w.key === key)) pageTextReady.delete(key);
  const m = mirror;
  if (m === null || m.turn === null) return;
  for (const w of pageWords) {
    if (
      w.files.length === 0 ||
      takesAlone(w) ||
      pageTextReady.has(w.key) ||
      readying.has(w.key)
    )
      continue;
    readying.add(w.key);
    void pageText($, m.thread, w)
      .then((text) => {
        if (mirror === m) pageTextReady.set(w.key, text);
      })
      .catch(() => undefined)
      .finally(() => readying.delete(w.key));
  }
}

/**
 * Joins the page's words that wait to the mirrored turn at a tool call's
 * result, as words typed into Claude Code mid-turn reach it: the
 * result goes on with them after it (`context`), which the model reads in
 * the turn's next request, marked as the person's own words. Only the main
 * loop's result, never a subagent's; never a denied call's, which takes no
 * context; never while a stop holds them, the page stopped the turn or moved
 * its command to the background (its words go in after that turn's end,
 * behind the note), or the window types or runs one of them alone; and only
 * while the call's turn is
 * the one mirrored. Every message that waits joins, in order, up to the
 * first slash command, which waits for the window to be idle, and up to the
 * first whose files are not fetched yet. devcorner is asked first, by a
 * post whose answer says whether the page stopped the turn and which words
 * still wait: a Stop since its last answer holds them, and a turn the window
 * has not heard was stopped would otherwise take words devcorner holds and
 * hands again once the person says more. Told of the join at the next post
 * (`Mirror.join`); the window says so on a toast.
 */
async function joinPageWords<
  R extends { deny?: unknown; context?: readonly string[] },
>($: Engine, agent: string | undefined, ran: R): Promise<R> {
  const m = mirror;
  const at = m?.turn ?? null;
  if (
    m === null ||
    at === null ||
    agent !== undefined ||
    ran.deny !== undefined
  )
    return ran;
  /** The words that may join now, in order; none while anything holds them. */
  const ready = (now: number): { key: string; text: string }[] => {
    if (
      mirror !== m ||
      m.turn !== at ||
      pageHeld !== null ||
      stoppedFromPage === at ||
      backgroundedFromPage === at ||
      typedHolding(now) ||
      commandFromPage !== null
    )
      return [];
    const ones: { key: string; text: string }[] = [];
    for (const w of pageWords) {
      if (takesAlone(w)) break;
      const text = w.files.length === 0 ? w.text : pageTextReady.get(w.key);
      if (text === undefined) break;
      ones.push({ key: w.key, text });
    }
    return ones;
  };
  if (ready(await $.clock.now()).length === 0 || (await read($, turn)) !== at)
    return ran;
  // A post that fails is kept and sent again by the mirror itself; the words
  // then join as the last answer left them.
  await mirrorPost($, {}).catch(() => undefined);
  const now = await $.clock.now();
  const joining = ready(now);
  if (joining.length === 0) return ran;
  const keys = new Set(joining.map((one) => one.key));
  heldUntil([...keys], now);
  pageWords = pageWords.filter((w) => !keys.has(w.key));
  for (const key of keys) {
    handedFromPage.add(key);
    pageTextReady.delete(key);
    replyDuring.delete(key);
  }
  m.join.push(...keys);
  $.ui.toast("dc: your words from the page reached this turn");
  void mirrorPost($, {});
  return {
    ...ran,
    context: [
      ...(ran.context ?? []),
      `${JOINED_FROM_PAGE}\n\n${joining.map((one) => one.text).join("\n\n---\n\n")}`,
    ],
  };
}

/**
 * The built-ins of Claude Code a window chat's page runs in the window: any
 * other built-in is refused, so one Claude Code adds stays off until
 * devcorner takes it. A skill, a plugin's command or an MCP prompt runs as
 * the window lists it. devcorner offers the same, and refuses any other as
 * it is said once the window sent its commands (`PAGE_BUILTINS`,
 * src/hub/laptop-commands.ts, which test/laptop-chats.test.ts keeps equal to
 * this): this is the window's last gate, for a command devcorner took
 * before it knew the window's list.
 */
const PAGE_BUILTINS: ReadonlySet<string> = new Set([
  "compact",
  "context",
  "model",
  "effort",
  "reload-plugins",
  "restart",
]);

/**
 * The command the window runs for one from the page, by the commands it
 * lists (null when they could not be read), under the name it lists it by;
 * or why it does not: one it does not have, or a built-in not in
 * `PAGE_BUILTINS`.
 */
export function pageCommandIn(
  name: string,
  listed: readonly CommandInfo[] | null,
): { name: string } | { refused: string } {
  if (listed === null)
    return { refused: "the window's commands could not be read" };
  const info = listed.find((one) => one.name.toLowerCase() === name);
  if (info === undefined)
    return { refused: `no command named /${name} in this window` };
  if (info.source === "builtin" && !PAGE_BUILTINS.has(info.name))
    return {
      refused: `/${name} is one of Claude Code's own commands, which a window chat's page does not run: run it in the window itself`,
    };
  return { name: info.name };
}

/** The effort levels `/effort` takes by name, as a model call's `effort` says them. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * The effort a command the window ran sets: the level `/effort <level>`
 * names, else null (another command, or words that name no level, which the
 * window's next model call tells).
 */
function effortSet(name: string, args: string): string | null {
  const level = args.trim().toLowerCase();
  return name === "effort" && EFFORT_LEVELS.has(level) ? level : null;
}

/**
 * What a command the window ran came to, for the page: what it printed, else
 * the notes it left the model (`/context` leaves its whole breakdown, in
 * Markdown), else that it ran.
 */
export function commandOutcome(line: string, ran: CommandRunResult): string {
  const printed = ran.text?.trim() ?? "";
  if (printed !== "") return printed;
  const notes = (ran.context ?? [])
    .map((note) => note.trim())
    .filter((note) => note !== "")
    .join("\n\n");
  return notes !== "" ? notes : `Ran ${line} in the window.`;
}

/** Why Claude Code refused to run a command, without the plugin's and the call's names it puts first. */
export function commandRefused(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  return said.replace(/^[\s\S]*?\$\.command\.run:\s*/, "").trim() || said;
}

/**
 * A command from the page that began no turn, as one post: the person's
 * line, taking its words by their key, and the window's answer, so the page
 * shows the line as theirs and what it came to under it. It has a turn key of
 * its own, from the words', so a post sent again is the same turn.
 */
function commandTurn(
  m: Mirror,
  key: string,
  line: string,
  end: { text: string; outcome: "done" | "failed" },
): MirrorPayload {
  return {
    thread: m.thread,
    turn: `page-command-${key}`,
    of: null,
    begin: { text: line, from: "page", took: [key], images: [] },
    parts: [],
    join: [],
    held: heldFor([key]),
    post: 0,
    end: { text: end.text, tools: [], steps: [], outcome: end.outcome },
    tries: 0,
  };
}

/**
 * Whether the window takes one of the page's messages alone, never joined
 * with words: a slash command, and words that begin with a slash all the
 * same (said before devcorner marked commands, or moved here from another
 * chat), which Claude Code refuses from a plugin.
 */
const takesAlone = (w: PageWords): boolean =>
  w.command !== null || w.text.trimStart().startsWith("/");

/** The keys of the page's messages the window took alone (`runPageCommand`), so none is taken twice, though an answer sent before devcorner heard of it names it; dropped as mirroring stops (`leaveMirror`). */
const takenAlone = new Set<string>();

/**
 * The command from the page running in the window now, by the name the
 * window lists it by, and the line and key the turn its prompt begins takes
 * as the page's: the `prompt.submit` hook hands them over (`typedFromPage`)
 * as Claude Code submits that prompt. Null while none runs. For `/model`,
 * whether its run is under way (`runs`), so its PreModelSwitch hook takes
 * that switch alone and never one the person makes in the window meanwhile,
 * the switch the hook held back to ask the page first (`switching`), and
 * whether the person said yes there (`confirmed`).
 */
let commandFromPage: {
  name: string;
  typed: TypedPageWords;
  runs: boolean;
  switching: ModelSwitch | null;
  confirmed: boolean;
} | null = null;

/** The keys of the page's commands whose turn began before they ended, as they waited on their person (`beginAskTurn`): each ends as that turn, never posted whole. */
const commandTurnsBegun = new Set<string>();

/** What the page is told of words that begin with a slash but are no command devcorner marked. */
const SLASH_WORDS =
  'Not run in the window: Claude Code takes no words from the page that begin with "/". To send them as words, put a word before the slash.';

/**
 * Takes one of the page's messages the window takes alone (`takesAlone`), once:
 * a slash command runs in the window (`runInWindow`); words that begin with
 * a slash are not typed in. One that begins no turn is answered at once:
 * what it came to, or why the window did not run it, is posted with the
 * person's line (`commandTurn`). Either way it never waits again, so the
 * messages after it go on.
 */
async function runPageCommand($: Engine, words: PageWords): Promise<void> {
  takenAlone.add(words.key);
  heldUntil([words.key], await $.clock.now());
  const command = words.command;
  const line =
    command === null
      ? words.text.trim()
      : slashLine(command.name, command.args);
  const from = mirror;
  // A reload or a restart from the page is said before it runs: this copy
  // never sees it end, and the new one rejoins the chat.
  const reload =
    command !== null && RELOADS_FROM_PAGE.has(command.name)
      ? await reloadFromPage($, command.name)
      : null;
  const end =
    command === null
      ? { text: SLASH_WORDS, outcome: "failed" as const }
      : (reload?.end ?? (await runInWindow($, words.key, command, line)));
  // Its prompt was submitted: the turn it begins takes the line.
  if (end === null) return;
  // One whose turn began as it waited on its person ends as that turn, and
  // as nothing once the window's own turn ended it.
  if (commandTurnsBegun.delete(words.key)) {
    endHold($, `dialog-${words.key}`);
    if (askTurn?.id === `page-command-${words.key}`) endAskTurn($, end);
  } else if (mirror !== null && mirror === from)
    await mirrorPost($, { whole: commandTurn(mirror, words.key, line, end) });
  if (reload !== null && reload.run !== null) {
    // Only once devcorner heard the line: a new copy would find it waiting
    // and reload or restart again.
    if (mirror !== null && mirror === from && mirror.unsent.length === 0) {
      if (reload.run === "restart") restartNow($, mirror.thread, line);
      else reloadNow($, `the page's ${line}`);
    } else
      $.ui.toast(
        `dc: devcorner did not hear the window's answer to the page's ${line}, so nothing was reloaded: send it again, or type /reload-plugins`,
      );
    return;
  }
  void typePageWords($);
}

/**
 * The commands a window chat's page sends that reload the window's plugins:
 * `/reload-plugins`, and `/restart`, which a plugin cannot run: a
 * background session is restarted as itself by another launcher of its
 * machine (`restartNow`), and any other window reloads its plugins.
 * src/hub/laptop-commands.ts offers them among `PAGE_BUILTINS`.
 */
const RELOADS_FROM_PAGE: ReadonlySet<string> = new Set([
  "reload-plugins",
  "restart",
]);

/**
 * What the page is told of a reload or a restart it sent, before it runs,
 * and which runs once devcorner heard that: for a background session's
 * `/restart`, that another launcher of the machine restarts it as itself
 * (`restart`); otherwise that the window reloads its plugins and rejoins the
 * chat (`reload`), and for `/restart` that a restart of the whole session is
 * typed in the window; or, where Claude Code here has no reload, what to
 * type in the window instead (none).
 */
async function reloadFromPage(
  $: Engine,
  name: string,
): Promise<{
  end: { text: string; outcome: "done" | "failed" };
  run: "reload" | "restart" | null;
}> {
  const listed = await $.command.list().catch(() => null);
  if (!listed?.some((one) => one.name === "reload-plugins"))
    return {
      end: {
        text: `Not run in the window: Claude Code there offers no /reload-plugins. Type /${name === "restart" ? "restart" : "reload-plugins"} in the window.`,
        outcome: "failed",
      },
      run: null,
    };
  const reloading = `Reloading the window's plugins: devcorner's loads the version on disk (it ran ${PLUGIN_VERSION}), and the window rejoins this chat on it.`;
  if (name !== "restart")
    return { end: { text: reloading, outcome: "done" }, run: "reload" };
  if ((await backgroundHere($)) === true)
    return {
      end: {
        text: "Restarting this background session as itself: another devcorner window or the launcher of this machine runs claude respawn once it is quiet, and it rejoins this chat with its whole context on the plugin on disk. Where none can, the window reloads its plugins instead.",
        outcome: "done",
      },
      run: "restart",
    };
  return {
    end: {
      text: `${reloading} A plugin cannot restart its own session: to restart it whole, type /restart in the window.`,
      outcome: "done",
    },
    run: "reload",
  };
}

/**
 * How long a window waits after devcorner opened its restart before it takes
 * the restart for not done: the time a launcher has to take it
 * (`LAUNCH_TAKE_MS`) and to run `claude respawn` (`LAUNCH_START_MS`), and a
 * margin.
 */
export const RESTART_WAIT_MS = 75_000;

/**
 * Asks devcorner to restart this background session as itself
 * (`ChatRestart`): a revive of its own chat, which another launcher of the
 * machine runs with `claude respawn` (`reviveLaunch`), never this window,
 * whose process the restart ends. Where no launcher can take it, or
 * devcorner refuses, the window reloads its plugins instead, and a toast
 * says why and the command to run.
 */
function restartNow($: Engine, thread: string, line: string): void {
  $.clock.after(0, async () => {
    const asked = await postAsYou(
      $,
      { hook_event_name: "ChatRestart", thread },
      { command: `the page's ${line}`, nothing: "nothing was restarted" },
    );
    const body = (typeof asked === "string" ? {} : (asked.body ?? {})) as {
      state?: unknown;
      words?: unknown;
      problem?: unknown;
      error?: unknown;
    };
    if (
      typeof asked !== "string" &&
      asked.status === 200 &&
      body.state === "opening"
    ) {
      // A restart ends this process, so a window still running once the
      // launchers had their time was not restarted: no launcher took it, the
      // session was busy, or `claude respawn` failed. The chat's page says
      // which.
      $.clock.after(RESTART_WAIT_MS, async () => {
        if (mirror === null || mirror.thread !== thread) return;
        $.ui.toast(
          `dc: devcorner did not restart this session after the page's ${line}: its chat's page says why, so the window reloads its plugins instead: run claude respawn ${await $.session.id()} on the laptop to restart it whole`,
        );
        reloadNow($, `the page's ${line}`);
      });
      return;
    }
    const why =
      typeof asked === "string"
        ? asked
        : body.problem === "asleep" || body.problem === "no-launcher"
          ? "no other devcorner window or launcher of this machine was heard lately"
          : ([body.error, body.words].find(
              (one): one is string => typeof one === "string" && one !== "",
            ) ?? `devcorner answered ${asked.status}`);
    $.ui.toast(
      `dc: the page's ${line} found no launcher here to restart this session (${why}), so the window reloads its plugins instead: run claude respawn ${await $.session.id()} on the laptop to restart it whole`,
    );
    reloadNow($, `the page's ${line}`);
  });
}

/**
 * Runs Claude Code's reload once the hook that asked has returned: this
 * copy is torn down and never sees it end. One Claude Code refuses is said
 * in the window, with what to type.
 */
function reloadNow($: Engine, asked: string): void {
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: "reload-plugins" });
    } catch (error) {
      $.ui.toast(
        `dc: ${asked} did not run (${commandRefused(error)}): type /reload-plugins`,
      );
    }
  });
}

/**
 * Runs a slash command from the page with `$.command.run`, as the person
 * would type it, when the window runs it (`pageCommandIn`); held meanwhile
 * (`commandFromPage`), so no other call takes the page's words. A skill, a
 * plugin's command or an MCP prompt submits its prompt before the run
 * resolves and begins a turn after (Claude Code 2.1.325), which takes the
 * line as the person's, as typed words are: null then. Else what it came to,
 * or why it did not run.
 */
async function runInWindow(
  $: Engine,
  key: string,
  command: PageCommand,
  line: string,
): Promise<{ text: string; outcome: "done" | "failed" } | null> {
  const typed: TypedPageWords = {
    keys: [key],
    text: line,
    prompt: "",
    since: await $.clock.now(),
  };
  const running: NonNullable<typeof commandFromPage> = {
    name: command.name,
    typed,
    runs: false,
    switching: null,
    confirmed: false,
  };
  commandFromPage = running;
  try {
    const found = pageCommandIn(
      command.name,
      await $.command.list().catch(() => null),
    );
    if ("refused" in found)
      return {
        text: `Not run in the window: ${found.refused}.`,
        outcome: "failed",
      };
    running.name = found.name;
    wokeAt = await $.clock.now();
    wakingFor = null;
    // Claude Code may ask its person to confirm a switch in the window, where
    // no hook of the plugin's sees it: the page is told once it waits.
    const dialog = CONFIRMED_BUILTINS.has(found.name)
      ? $.clock.after(COMMAND_DIALOG_MS, () => dialogOnPage($, running, line))
      : undefined;
    let end = await runOnce($, running, command.args, line);
    dialog?.cancel();
    if (typedFromPage === typed) return null;
    wokeAt = null;
    if (running.switching !== null)
      end = await switchOnPage($, key, line, running.switching, () => {
        running.confirmed = true;
        return runOnce($, running, command.args, line);
      });
    return end;
  } finally {
    commandFromPage = null;
  }
}

/** What a command from the page came to, as its turn's end says it. */
type CommandEnd = { text: string; outcome: "done" | "failed" };

/**
 * Runs a command from the page once, as `runInWindow` found it: what it came
 * to, or why it did not run. A skill's prompt the `prompt.submit` hook handed
 * over as the page's line, then refused (a later hook blocked it), begins no
 * turn to take it: left handed over, it would hold the page's words and take
 * the next turn begun in the window for this line.
 */
async function runOnce(
  $: Engine,
  running: NonNullable<typeof commandFromPage>,
  args: string,
  line: string,
): Promise<CommandEnd> {
  running.runs = true;
  try {
    const ran = await $.command.run({
      command: running.name,
      ...(args === "" ? {} : { args }),
    });
    // The effort is known only from a model call (`turn.step`), so the one
    // `/effort` set is what the chat's head is told now, with this post.
    windowEffort = effortSet(running.name, args) ?? windowEffort;
    return { text: commandOutcome(line, ran), outcome: "done" };
  } catch (error) {
    if (typedFromPage === running.typed) typedFromPage = null;
    return {
      text: `Not run in the window: ${commandRefused(error)}.`,
      outcome: "failed",
    };
  } finally {
    running.runs = false;
  }
}

// ---- A page command Claude Code asks to confirm ----
//
// `/model` and `/effort` switch what the window's next request runs on, and
// with a prompt cache still warm Claude Code asks its person in the window
// first, since the switch re-reads the whole conversation uncached
// ("Switch model?", "Yes, switch to <model>" or "No, go back"). Sent from the
// page, that dialog would wait in a window nobody watches. A model switch
// raises Claude Code's PreModelSwitch hook before its dialog, whose answer
// decides it: allow switches with no dialog, deny cancels. That hook times
// out after 30 s, so it never waits on the page: it holds the switch back
// (`commandFromPage.switching`) and the page is asked in the command's own
// turn, with the window's two choices (`switchOnPage`), and a yes runs the
// command again, which the hook then lets through. A switch with nothing
// cached goes at once. Where no hook reaches the dialog (`/effort`'s, or a
// Claude Code with no PreModelSwitch), a command still running after
// `COMMAND_DIALOG_MS` is said on the page as waiting at the laptop
// (`dialogOnPage`), never a silent wait.

/** The built-ins of `PAGE_BUILTINS` Claude Code may ask its person to confirm in the window before they run. */
const CONFIRMED_BUILTINS: ReadonlySet<string> = new Set(["model", "effort"]);
/** How long a page's `/model` or `/effort` may run before the page is told the window waits on its person: either ends at once unless Claude Code asks to confirm it. */
export const COMMAND_DIALOG_MS = 3_000;
/** The page's answer to a switch held back that keeps the window's model, as Claude Code's dialog words it. */
export const SWITCH_NO = "No, go back";

/** A model switch the window's PreModelSwitch hook held back for its person's word on the page: from and to which model, and how many tokens of context it re-reads. */
interface ModelSwitch {
  from: string;
  to: string;
  tokens: number;
}

/**
 * The switch a PreModelSwitch hook's input names, held back to ask the page,
 * or null when the window would not ask: nothing cached to lose, or a model
 * it does not name.
 */
function switchToAsk(input: unknown): ModelSwitch | null {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.prompt_cache_warm !== true || typeof raw.to_model !== "string")
    return null;
  return {
    from: typeof raw.from_model === "string" ? raw.from_model : "",
    to: raw.to_model,
    tokens:
      typeof raw.context_tokens === "number" && raw.context_tokens > 0
        ? Math.round(raw.context_tokens)
        : 0,
  };
}

/** The page's ask for a switch held back, in Claude Code's own words and with its two choices. */
function switchAsk(sw: ModelSwitch): Ask {
  const tokens =
    sw.tokens > 0 ? ` (about ${sw.tokens.toLocaleString("en-US")} tokens)` : "";
  return {
    kind: "question",
    questions: [
      {
        header: "Switch model?",
        question: `This conversation is cached for the current model${sw.from === "" ? "" : `, ${sw.from}`}. Switching to ${sw.to} means the full history gets re-read${tokens}: your next response will be slower and use more tokens.`,
        options: [
          { label: `Yes, switch to ${sw.to}`, description: "" },
          { label: SWITCH_NO, description: "" },
        ],
        multi: false,
      },
    ],
  };
}

/**
 * Asks the page about a switch the PreModelSwitch hook held back, in the
 * command's own turn, and makes it on a yes (`again`); what it came to. No
 * answer, as the page stopped it or the mirror ended, switches nothing.
 */
async function switchOnPage(
  $: Engine,
  key: string,
  line: string,
  sw: ModelSwitch,
  again: () => Promise<CommandEnd>,
): Promise<CommandEnd> {
  const kept = `Not switched: the window stays on ${sw.from || "its model"}.`;
  // Its turn may have begun already, for a dialog hold the hooks beneath
  // were slow enough to raise (`dialogOnPage`): the ask takes its place.
  const begun =
    askTurn?.id === `page-command-${key}` && mirror?.turn === askTurn.id;
  if (!begun && !(await beginAskTurn($, { key, line })))
    return {
      text: `Not run in the window: Claude Code asks there to confirm it, as the switch re-reads the whole conversation. Type ${line} in the window.`,
      outcome: "failed",
    };
  endHold($, `dialog-${key}`);
  const id = `switch-${key}`;
  const page = openAsk($, id, switchAsk(sw), null);
  void holdForPage($, id);
  const answer = await page;
  const chosen =
    answer !== null && "answers" in answer ? answer.answers[0]?.[0] : undefined;
  if (chosen === undefined) {
    closeAsk($, id, "expired");
    return { text: kept, outcome: "done" };
  }
  closeAsk($, id, { by: "page", said: chosen });
  return chosen === SWITCH_NO ? { text: kept, outcome: "done" } : again();
}

/**
 * Tells the page that a command of `CONFIRMED_BUILTINS` it sent still runs
 * once `COMMAND_DIALOG_MS` passed, so Claude Code waits on its person in the
 * window: a dialog hold in the command's own turn, which ends as the command
 * does (`runPageCommand`). Only while that command still runs, checked with
 * no wait before its turn begins, so a command that ended meanwhile, posted
 * whole, begins none.
 */
async function dialogOnPage(
  $: Engine,
  running: NonNullable<typeof commandFromPage>,
  line: string,
): Promise<void> {
  const key = running.typed.keys[0]!;
  if (commandFromPage !== running || !(await beginAskTurn($, { key, line })))
    return;
  const held: HeldCall = {
    id: `dialog-${key}`,
    turn: mirror!.turn!,
    hold: {
      kind: "dialog",
      tool: `/${running.name}`,
      label: `Claude Code asks there to confirm ${line}, as the switch re-reads the whole conversation`,
      background: false,
    },
    told: false,
    timer: null,
  };
  holds.set(held.id, held);
  tellHold($, held);
}

/**
 * What an opening's answer gives: the chat, its page and how to resume it.
 * A window that mirrored no chat before (`/dc chat`, `/dc continue`, a
 * rejoin after a restart, a resume or a reload) is told where its replies
 * are read (`instructWindow`) as its mirroring begins.
 */
async function mirrorOpened(
  $: Engine,
  posted: { status: number; body: unknown },
  nothing: string,
  commands: WindowCommand[] | undefined,
  background: boolean | null,
): Promise<string> {
  const body = (posted.body ?? {}) as {
    chat?: { thread?: unknown; machineName?: unknown };
    url?: unknown;
    resume?: unknown;
    started?: unknown;
    movedFrom?: unknown;
    error?: unknown;
  };
  if (posted.status !== 200 || typeof body.chat?.thread !== "string") {
    return `dc: ${typeof body.error === "string" ? body.error : `devcorner did not answer, so ${nothing}.`}`;
  }
  const began = mirror === null;
  // Nothing of a chat the window mirrored before goes into this one.
  leaveMirror();
  // Its held request hears for the window now, with the chat's state: the
  // helper's socket would take its wakes past it (`listen`). While a helper
  // ran, nothing else asked (`hold` and `carryOn` leave to it), and one
  // stopped here hands nothing back as one that ends does, so the asking
  // starts again below, once the chat is mirrored: an idle window holds with
  // it. Without that, a window that rejoined its chat at a reload heard
  // nothing until its next turn, and its chat lapsed offline. One stopped
  // before its child started left its caller to hold, which it does.
  const parked = listener?.running === true;
  stopListening();
  mirror = {
    thread: body.chat.thread,
    background,
    turn: null,
    key: null,
    part: 0,
    next: null,
    begin: null,
    parts: [],
    join: [],
    tools: [],
    steps: [],
    said: [],
    open: null,
    blocks: 0,
    tool: null,
    posted: 0,
    tasksSent: "[]",
    commandsSent: commands === undefined ? null : JSON.stringify(commands),
    runningSent: null,
    taken: null,
    holdsSent: null,
    sending: Promise.resolve(),
    unsent: [],
    lookTries: 0,
  };
  // A hold put off before (one that failed or answered at once while no chat
  // was mirrored) would put off the chat's, which is what keeps it online:
  // the next ask holds, at once after a helper, else at the poll's next.
  holdAfter = 0;
  if (parked) askIn($, 0, true);
  void $.session
    .id()
    .then((id) => $.store.set(mirroredKey(id), body.chat!.thread))
    .catch(() => undefined);
  // A rejoin the window's memory waited on is settled by any chat opened.
  void update($, rejoining, () => null).catch(() => undefined);
  const id = body.chat.thread;
  void update($, laptop, () => ({
    thread: id,
    url: typeof body.url === "string" ? body.url : null,
    reconnecting: false,
  })).catch(() => undefined);
  if (began) await instructWindow($, id);
  // One look, whether or not the opening's answer named any words. devcorner
  // hands a chat's words in the answer of every post until a turn of the
  // window takes them, and a window's opening is often the first post after
  // the words were handed to a copy that is gone (a reload, a restart, a chat
  // moved from another window): that post's answer cleared their mark, so
  // nothing else tells the copy that mirrors now of them.
  void mirrorPost($, { look: true }).catch(() => undefined);
  return [
    `dc: ${body.started === true ? "This window is now" : "This window mirrors"} window chat ${id}${typeof body.url === "string" ? `: ${body.url}` : "."}`,
    typeof body.movedFrom === "string"
      ? `It moved here from ${body.movedFrom}, which no longer mirrors it.`
      : null,
    "Your words there are typed in here as yours while the window is idle; its replies stream there. /dc chat off stops it.",
    `Another window continues it with /dc continue ${id}${typeof body.resume === "string" ? `; this exact session, ${body.resume}` : ""}.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// Laptop launches: devcorner's page asks to start a window chat on this
// machine, or to move a chat here, so the person can begin or carry on a
// chat from the page without typing in a terminal, and a window of this
// plugin that holds devcorner's held request (any idle window, or the
// background launcher `/dc launcher on` keeps) takes it. The script, never
// the model, runs `claude --bg` in the repo's folder with a first prompt
// that joins the chat, and says how that went, so the page never waits in
// silence. The new session is the child of no window: the launching
// window's own session variables are cleared for it.

/** The name the always-on background launcher runs under, which `/dc launcher off` stops. */
export const LAUNCHER_NAME = "devcorner-launcher";

/**
 * Asks the person to pin the launcher once. Claude Code's supervisor parks a
 * background session left idle and unattached for about an hour, and the
 * launcher idles by design, holding devcorner's request; a pinned session
 * is never parked, and pinning is a key in agent view alone, with no flag
 * or setting. Nothing keeps it awake by spending model turns.
 */
export const LAUNCHER_PIN = `Pin it once so Claude Code never parks it after an hour idle: in claude agents, select ${LAUNCHER_NAME} and press Ctrl+T.`;

/** How long `claude --bg` may take: under a second once its service runs, about 3 s when it starts it. */
const LAUNCH_RUN_MS = 20_000;

/** The machine's record of where each repo's folder is ($.store, shared by every window of this plugin here). */
const FOLDERS_KEY = "launch-folders";

/** The most repos that record keeps, the newest heard. */
const MAX_FOLDERS = 50;

/** The variables a window gives a child it starts that would make the child think it runs inside that window. */
const NESTED_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];

/** The command that starts a background session: run with no shell, the window's own session variables cleared. */
export function launchArgv(name: string, prompt: string): string[] {
  return [
    "env",
    ...NESTED_VARIABLES.flatMap((one) => ["-u", one]),
    "claude",
    "--bg",
    "-n",
    name,
    prompt,
  ];
}

/**
 * The command that revives a window chat's parked background session as
 * itself: `claude respawn <id>`, which restarts it under the same id, in its
 * saved folder with its saved options (its name among them), so it rejoins
 * its chat with its whole context. Never `claude --bg --resume <id>` with a
 * flag, which starts a copy under a new id. Run with no shell, the window's
 * own session variables cleared.
 */
export function respawnArgv(id: string): string[] {
  return [
    "env",
    ...NESTED_VARIABLES.flatMap((one) => ["-u", one]),
    "claude",
    "respawn",
    id,
  ];
}

/** Reads `claude respawn`'s answer: exit 0 restarted the session `id`; anything else failed, said in its own words. */
export function respawnOutcome(
  ran: { exitCode: number; stdout: string; stderr: string },
  id: string,
): LaunchOutcome {
  if (ran.exitCode === 0) return { problem: null, words: null, bg: id };
  const said = `${ran.stdout}\n${ran.stderr}`.trim();
  return {
    problem: "failed",
    words:
      said === ""
        ? `claude respawn exited ${ran.exitCode}`
        : said.slice(0, 400),
    bg: null,
  };
}

/** One session as `claude agents --json` lists it, its fields as it prints them, each read with a check. */
type ListedAgent = Record<string, unknown>;

/**
 * The sessions `claude agents --json` printed (a list, or one under
 * `agents`); null when what it printed cannot be read as either.
 */
export function agentsListed(printed: string): ListedAgent[] | null {
  let listed: unknown;
  try {
    listed = JSON.parse(printed);
  } catch {
    return null;
  }
  const all = Array.isArray(listed)
    ? listed
    : Array.isArray((listed as { agents?: unknown } | null)?.agents)
      ? (listed as { agents: unknown[] }).agents
      : null;
  return all === null
    ? null
    : all.filter(
        (one): one is ListedAgent => one !== null && typeof one === "object",
      );
}

/**
 * Whether `claude agents --json` lists the session `id` as a background
 * one (`kind` `background`; any other kind reads as a window, so a kind
 * Claude Code adds later never holds a watched window's dialog blank): a
 * window chat whose window is one can be revived from its page once Claude
 * Code parks it, and a background session's subagent asks wait for the page.
 * Null when the list does not name the session, or cannot be read.
 */
export function backgroundOf(printed: string, id: string): boolean | null {
  const kind = agentsListed(printed)?.find((one) => one.sessionId === id)?.kind;
  return typeof kind === "string" ? kind === "background" : null;
}

/** How long `claude agents --json` may take as a chat opens, which waits on it. */
const AGENTS_READ_MS = 5_000;

/**
 * Whether this window is a background session of the machine, as a chat's
 * opening tells devcorner (`ChatOpen`'s `background`), read from `claude
 * agents --json`; null when it cannot be read, which keeps what the same
 * session told devcorner before and leaves the mirror treating the session
 * as a window (`Mirror.background`).
 */
async function backgroundHere($: Engine): Promise<boolean | null> {
  try {
    const id = await $.session.id();
    const ran = await $.process.run(["claude", "agents", "--json"], {
      timeoutMs: AGENTS_READ_MS,
    });
    return ran.exitCode === 0 ? backgroundOf(ran.stdout, id) : null;
  } catch {
    return null;
  }
}

/** What a launcher says `claude --bg` came to: started (with the id it printed), or why not, in its own words. */
export interface LaunchOutcome {
  problem: "untrusted" | "failed" | null;
  words: string | null;
  bg: string | null;
}

/**
 * Reads `claude --bg`'s answer: exit 0 with "backgrounded · <id> · <name>"
 * started one; "Workspace not trusted" is a folder Claude Code never
 * trusted, fixed by opening `claude` there once; anything else failed, said
 * in its own words.
 */
export function launchOutcome(ran: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): LaunchOutcome {
  const said = `${ran.stdout}\n${ran.stderr}`.trim();
  if (ran.exitCode === 0) {
    const bg = /backgrounded\s*·\s*([0-9a-f]{6,40})/i.exec(said)?.[1] ?? null;
    return { problem: null, words: null, bg };
  }
  return {
    problem: /workspace not trusted/i.test(said) ? "untrusted" : "failed",
    words:
      said === "" ? `claude --bg exited ${ran.exitCode}` : said.slice(0, 400),
    bg: null,
  };
}

/**
 * A git remote folded to the form devcorner's repos are matched by: its
 * host and path, lower-case, with no scheme, user or `.git`
 * ("github.com/acme/shop").
 */
export function foldRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):/, "$1/")
    .toLowerCase();
}

/** The folder a repo devcorner names (acme/shop, gitlab.com/g/x) is in on this machine, from the record; undefined for none. */
export function folderFor(
  folders: Record<string, { folder: string; at: number }>,
  repo: string,
): string | undefined {
  const want = repo.trim().toLowerCase();
  const found = Object.entries(folders)
    .filter(([key]) => key === want || key.endsWith(`/${want}`))
    .sort((a, b) => b[1].at - a[1].at)[0];
  return found?.[1].folder;
}

async function foldersOf(
  $: Engine,
): Promise<Record<string, { folder: string; at: number }>> {
  const kept = await $.store.get(FOLDERS_KEY).catch(() => undefined);
  return kept !== null && typeof kept === "object" && !Array.isArray(kept)
    ? (kept as Record<string, { folder: string; at: number }>)
    : {};
}

/**
 * Keeps where this window's repo is on the machine, so a launcher here finds
 * the folder of a repo devcorner names. Only a folder a git remote names:
 * the home folder, which Claude Code trusts one session at a time, never is.
 */
async function noteFolder($: Engine): Promise<void> {
  const cwd = await $.session.cwd().catch(() => undefined);
  if (!cwd) return;
  const remote = await repoIn($, cwd).catch(() => undefined);
  if (!remote) return;
  const folders = await foldersOf($);
  folders[foldRemote(remote)] = { folder: cwd, at: await $.clock.now() };
  const kept = Object.fromEntries(
    Object.entries(folders)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_FOLDERS),
  );
  await $.store.set(FOLDERS_KEY, kept);
}

/**
 * The launches this window took last, so a frame given twice starts one
 * session. A frame comes again within seconds, so the newest few are enough,
 * and a window that runs for weeks keeps no more than these.
 */
const launching = new Set<string>();

/** How many launches a window remembers taking (`launching`). */
const MAX_LAUNCHING = 20;

/**
 * Takes a launch devcorner's held request told of, and starts it: the first
 * window of the machine to take it runs `claude --bg` in the repo's folder
 * (the one devcorner knows, else this machine's record), and every outcome is
 * said to devcorner, which the page shows with its fix. A launch another
 * window took is left to it, quietly.
 */
async function takeLaunch($: Engine, launch: string): Promise<void> {
  if (launching.has(launch)) return;
  launching.add(launch);
  // A Set iterates in insertion order: the first is the oldest.
  if (launching.size > MAX_LAUNCHING)
    launching.delete(launching.values().next().value!);
  const taken = await postAsYou(
    $,
    { hook_event_name: "LaunchTake", launch },
    { command: "a window chat's launch", nothing: "nothing was started" },
  );
  if (typeof taken === "string" || taken.status !== 200) return;
  const body = (taken.body ?? {}) as {
    repo?: unknown;
    folder?: unknown;
    name?: unknown;
    prompt?: unknown;
    respawn?: unknown;
    restart?: unknown;
  };
  if (typeof body.respawn === "string" && body.respawn !== "") {
    await reviveLaunch($, launch, body.respawn, body.restart === true);
    return;
  }
  // A launch's prompt joins its chat: one with none (a revive a devcorner
  // that cannot revive answered without its session) would start a session
  // that joins nothing.
  if (
    typeof body.name !== "string" ||
    typeof body.prompt !== "string" ||
    body.prompt.trim() === ""
  )
    return;
  const repo = typeof body.repo === "string" ? body.repo : null;
  const folder =
    (typeof body.folder === "string" && body.folder !== ""
      ? body.folder
      : undefined) ??
    (repo === null ? undefined : folderFor(await foldersOf($), repo));
  let outcome: Omit<LaunchOutcome, "problem"> & {
    problem: LaunchOutcome["problem"] | "no-folder";
  };
  if (folder === undefined) {
    outcome = {
      problem: "no-folder",
      words: `No folder of ${repo ?? "the chat's repo"} is known on this machine: no Claude Code window with the devcorner plugin has opened in it yet.`,
      bg: null,
    };
  } else {
    const ran = await $.process
      .run(launchArgv(body.name, body.prompt), {
        cwd: folder,
        timeoutMs: LAUNCH_RUN_MS,
      })
      .catch((error: unknown) => ({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
    outcome = launchOutcome(ran);
  }
  await postAsYou(
    $,
    {
      hook_event_name: "LaunchDone",
      launch,
      problem: outcome.problem,
      words: outcome.words,
      bg: outcome.bg,
      folder: folder ?? null,
    },
    { command: "a window chat's launch", nothing: "its outcome was not said" },
  );
  $.ui.toast(
    outcome.problem === null
      ? `dc: started ${body.name} in the background for devcorner's page (claude attach "${body.name}")`
      : `dc: devcorner's page asked for a window chat here, and it did not start: ${outcome.words ?? outcome.problem}`,
  );
}

/** The status `claude agents --json` gives a session whose process ended, as 2.1.325 and 2.1.326 listed a parked one. */
const ENDED_STATUS = "done";

/**
 * What `claude agents --json --all` says of session `id` (the one whose id
 * begins with it): its process, by its pid, when it names one, as it does
 * for an interactive window; `runs` when it names a status of a live
 * session and no pid, as 2.1.327 lists a background session that runs
 * (`busy`, `idle`); `parked` when it names neither, as 2.1.327 lists a
 * parked one (no status, `state` "blocked", which a running one keeps too),
 * or only `done`, or when it lists no such session, which `claude respawn`
 * then says in its own words.
 */
export function listedLife(
  agents: ListedAgent[],
  id: string,
): { pid: number } | "runs" | "parked" {
  const found = agents.find(
    (one) => typeof one.sessionId === "string" && one.sessionId.startsWith(id),
  );
  if (typeof found?.pid === "number") return { pid: found.pid };
  return typeof found?.status === "string" && found.status !== ENDED_STATUS
    ? "runs"
    : "parked";
}

/**
 * Whether background session `id` is parked here, so a revive may restart
 * it: `parked` when `claude agents --json --all` lists no live session of
 * it (`listedLife`); `runs` when it does, or its process is alive, as when
 * devcorner stopped hearing it for another reason (a long command in its
 * turn, its held request failing), which a restart would cut; `unknown`
 * when either could not be read, which restarts nothing either.
 */
async function parkedHere(
  $: Engine,
  id: string,
): Promise<"parked" | "runs" | "unknown"> {
  const agents = await agentsHere($);
  if (agents === null) return "unknown";
  const life = listedLife(agents, id);
  if (typeof life === "string") return life;
  const alive = await $.process
    .run(["kill", "-0", String(life.pid)], { timeoutMs: AGENTS_READ_MS })
    .catch(() => null);
  return alive === null ? "unknown" : alive.exitCode === 0 ? "runs" : "parked";
}

/** What `claude agents --json --all` lists on this machine; null when it could not be read. */
async function agentsHere($: Engine): Promise<ListedAgent[] | null> {
  const listed = await $.process
    .run(["claude", "agents", "--json", "--all"], { timeoutMs: AGENTS_READ_MS })
    .catch(() => null);
  return listed === null || listed.exitCode !== 0
    ? null
    : agentsListed(listed.stdout);
}

/** The status `claude agents --json` gives a background session in a turn, as 2.1.327 lists one. */
const BUSY_STATUS = "busy";

/**
 * Whether background session `id` (the one whose id begins with it) is in a
 * turn now, as `claude agents --json --all` lists it: a restart its own
 * window asked waits for a quiet moment, so one in a turn is left as it is.
 */
function listedBusy(agents: ListedAgent[], id: string): boolean {
  return (
    agents.find(
      (one) =>
        typeof one.sessionId === "string" && one.sessionId.startsWith(id),
    )?.status === BUSY_STATUS
  );
}

/** A Claude Code session id as devcorner names one to revive: hex digits alone, never a word `claude respawn` would read as a flag. */
const SESSION_ID = /^[0-9a-f]{6,40}$/i;

/**
 * A revive this window took: `claude respawn <id>` restarts the chat's
 * parked background session, which rejoins its chat by itself, and how it
 * went is said to devcorner, as a launch's is. A session whose process
 * still runs is left as it is, said as `running`, whose fix on devcorner's
 * page is `claude attach <id>`; one whose state could not be read is left
 * too, said as `failed`. A `restart`, which the session's own window asked
 * at a quiet moment, restarts it while it runs, unless it is in a turn by
 * now, said as `running` too.
 */
async function reviveLaunch(
  $: Engine,
  launch: string,
  id: string,
  restart: boolean,
): Promise<void> {
  // A restart reads a session in no turn as `parked`: one it may restart.
  const quiet = async (): Promise<"parked" | "runs" | "unknown"> => {
    const agents = await agentsHere($);
    if (agents === null) return "unknown";
    return listedBusy(agents, id) ? "runs" : "parked";
  };
  const parked = !SESSION_ID.test(id)
    ? null
    : restart
      ? await quiet()
      : await parkedHere($, id);
  type Revived = Omit<LaunchOutcome, "problem"> & {
    problem: LaunchOutcome["problem"] | "running";
  };
  const left = (problem: "running" | "failed", words: string): Revived => ({
    problem,
    words,
    bg: null,
  });
  const outcome: Revived =
    parked === null
      ? left(
          "failed",
          `${id} is no Claude Code session id: nothing was restarted.`,
        )
      : parked === "runs"
        ? left(
            "running",
            restart
              ? `Background session ${id} is in a turn now, so it was not restarted: send /restart again once it is quiet.`
              : `Background session ${id} still runs on this machine, so it is not parked and was not restarted: claude attach ${id} opens it.`,
          )
        : parked === "unknown"
          ? left(
              "failed",
              `claude agents could not say whether background session ${id} still runs on this machine, so it was not restarted. claude agents shows it.`,
            )
          : respawnOutcome(
              await $.process
                .run(respawnArgv(id), { timeoutMs: LAUNCH_RUN_MS })
                .catch((error: unknown) => ({
                  exitCode: -1,
                  stdout: "",
                  stderr:
                    error instanceof Error ? error.message : String(error),
                })),
              id,
            );
  await postAsYou(
    $,
    {
      hook_event_name: "LaunchDone",
      launch,
      problem: outcome.problem,
      words: outcome.words,
      bg: outcome.bg,
      folder: null,
    },
    { command: "a window chat's revive", nothing: "its outcome was not said" },
  );
  $.ui.toast(
    outcome.problem === null
      ? `dc: revived background session ${id} for devcorner's page (claude attach ${id})`
      : `dc: devcorner's page asked to revive background session ${id} here, and it did not restart: ${outcome.words ?? outcome.problem}`,
  );
}

/** What `claude agents --json` lists of the background launcher: its state, or null when it is not listed. */
export function launcherListed(printed: string): string | null {
  const found = agentsListed(printed)?.find(
    (one) => one.name === LAUNCHER_NAME,
  );
  if (found === undefined) return null;
  const state = [found.status, found.state].filter(
    (one): one is string => typeof one === "string",
  );
  return state.length === 0 ? "listed" : state.join(", ");
}

/**
 * /dc launcher [on | off]: the always-on background launcher, one Claude
 * Code session in the background (`claude --bg -n devcorner-launcher`) whose
 * plugin keeps devcorner's held request open, so devcorner's page reaches
 * this machine with every window closed. It sits in this window's project
 * folder, one Claude Code trusts, never the home folder. With no word, says
 * whether it runs. `serve` is its own first prompt, answered by this script.
 */
async function launcherHere($: Engine, words: string): Promise<string> {
  const arg = words.trim();
  if (arg === "serve")
    return `dc: this background session is devcorner's launcher on this machine: devcorner's page starts window chats here through it, even with every window closed. ${LAUNCHER_PIN} /dc launcher off stops it.`;
  const run = (argv: string[], cwd?: string) =>
    $.process
      .run(argv, { ...(cwd ? { cwd } : {}), timeoutMs: LAUNCH_RUN_MS })
      .catch((error: unknown) => ({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
  const listed = async () =>
    launcherListed((await run(["claude", "agents", "--json"])).stdout);
  if (arg === "") {
    const state = await listed();
    return state === null
      ? "dc: the launcher is off: devcorner's page reaches this machine only while a Claude Code window with the devcorner plugin is open and idle. /dc launcher on starts it in this project's folder."
      : `dc: the launcher runs (${state}): devcorner's page reaches this machine with every window closed. claude attach ${LAUNCHER_NAME} shows it; /dc launcher off stops it.`;
  }
  if (arg === "off") {
    const stopped = await run(["claude", "stop", LAUNCHER_NAME]);
    return stopped.exitCode === 0
      ? "dc: the launcher is off: devcorner's page reaches this machine only while a Claude Code window with the devcorner plugin is open and idle."
      : `dc: the launcher was not stopped: ${`${stopped.stdout}\n${stopped.stderr}`.trim() || `claude stop exited ${stopped.exitCode}`}. claude agents lists what runs.`;
  }
  if (arg !== "on")
    return "dc: /dc launcher on starts the background launcher, /dc launcher off stops it, /dc launcher says whether it runs.";
  if (!(await tokenOf($)))
    return "dc: this machine is not signed in to devcorner, so no launcher would reach it. /dc login signs it in.";
  const cwd = await $.session.cwd().catch(() => undefined);
  const remote = cwd ? await repoIn($, cwd).catch(() => undefined) : undefined;
  if (!cwd || !remote)
    return "dc: run /dc launcher on in a project's folder, one Claude Code trusts: the launcher never sits in the home folder, which Claude Code trusts one session at a time.";
  const state = await listed();
  if (state !== null)
    return `dc: the launcher runs already (${state}). /dc launcher off stops it.`;
  await noteFolder($).catch(() => {});
  const outcome = launchOutcome(
    await run(launchArgv(LAUNCHER_NAME, "/dc launcher serve"), cwd),
  );
  if (outcome.problem === "untrusted")
    return `dc: Claude Code does not trust ${cwd} for background sessions yet. Run claude once in it and accept the trust prompt, then /dc launcher on again.`;
  if (outcome.problem !== null)
    return `dc: the launcher did not start: ${outcome.words ?? "claude --bg failed"}.`;
  return `dc: the launcher is on, in the background in ${cwd}: devcorner's page reaches this machine with every window closed. ${LAUNCHER_PIN} claude attach ${LAUNCHER_NAME} shows it; /dc launcher off stops it.`;
}

/** A launch's number in `/dc chat` or `/dc continue`'s words (`--launch N`), and the words without it. */
export function launchArg(words: string): {
  launch: string | null;
  rest: string;
} {
  const found = /(?:^|\s)--launch\s+(\d+)(?=\s|$)/.exec(words);
  if (found === null) return { launch: null, rest: words };
  return {
    launch: found[1]!,
    rest: `${words.slice(0, found.index)} ${words.slice(found.index + found[0].length)}`
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/**
 * Whether devcorner refused a launch's join: a 4xx other than 408 and 429,
 * which say to ask again rather than that the join is over.
 */
function refusedJoin(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** /dc chat [title] and /dc chat off. */
async function chatHere($: Engine, words: string): Promise<string> {
  // A session a launch started names it, and the chat it begins joins it.
  const { launch, rest } = launchArg(words.trim());
  const arg = rest;
  if (arg === "off") {
    if (mirror === null) return "dc: this window mirrors no window chat.";
    const thread = mirror.thread;
    const posted = await postAsYou(
      $,
      { hook_event_name: "ChatClose", thread },
      { command: "/dc chat off", nothing: "it was not turned off" },
    );
    if (typeof posted === "string") return posted;
    stopMirror($, null);
    void $.session
      .id()
      .then((id) => $.store.delete(mirroredKey(id)))
      .catch(() => undefined);
    return posted.status === 200
      ? `dc: window chat ${thread} is off: nothing more is mirrored. /dc continue ${thread} turns it on again.`
      : `dc: ${(posted.body as { error?: string } | null)?.error ?? "devcorner did not turn it off."}`;
  }
  // Read beside the rest, so its process never adds to the opening's wait.
  const background = backgroundHere($);
  const cwd = await $.session.cwd().catch(() => undefined);
  const commands = await windowCommands($);
  const posted = await postAsYou(
    $,
    {
      hook_event_name: "ChatOpen",
      title: arg,
      ...(launch !== null ? { launch } : {}),
      ...(await boundTo($)),
      history: exchanges,
      runsOn: await windowModel($),
      commands,
      ...(await windowWhere($)),
      repo: cwd
        ? ((await repoIn($, cwd).catch(() => undefined)) ?? null)
        : null,
      background: await background,
    },
    { command: "/dc chat", nothing: "no window chat was opened" },
  );
  if (typeof posted === "string") return posted;
  const said = await mirrorOpened(
    $,
    posted,
    "no window chat was opened",
    commands,
    await background,
  );
  // A session a launch started exists only to join its chat. Once devcorner
  // refused that join it would run on unseen, so it ends itself. A 5xx, an
  // updating devcorner or no answer leaves it up: it may still join, or its
  // card gives the command that stops it. A 408 or 429 may pass, so it is
  // worth asking again.
  if (launch !== null && refusedJoin(posted.status)) {
    $.ui.toast(
      "dc: devcorner refused this session's join to its chat, so it ends",
    );
    endSession($);
  }
  return launch === null ? withRename(said, posted) : said;
}

/**
 * The line that names a chat's session as a launch names it (`<title> ·
 * me-k3`), so agent view, `claude attach me-k3` and `claude --resume` find it
 * by the chat's id: Claude Code gives a plugin no call that renames its
 * session, so the person runs `/rename` once. A session a launch started
 * was named as it started, and is not asked.
 */
export function renameLine(name: string): string {
  return `To find this session by the chat's id in agent view and with claude attach, name it once: /rename ${name}`;
}

/** An opening's words with `renameLine` after them, when the chat opened and devcorner named its session. */
function withRename(
  said: string,
  posted: { status: number; body: unknown },
): string {
  const name = (posted.body as { name?: unknown } | null)?.name;
  return posted.status === 200 && typeof name === "string" && name !== ""
    ? `${said}\n${renameLine(name)}`
    : said;
}

/** /dc continue <id> [--takeover]: an existing window chat continued in this window. */
async function continueHere($: Engine, words: string): Promise<string> {
  // A session a launch started names it: the move it joins.
  const { launch, rest } = launchArg(words.trim());
  const parts = rest.split(/\s+/).filter(Boolean);
  const takeover = parts.includes("--takeover");
  const thread = parts.find((p) => p !== "--takeover");
  if (!thread)
    return "dc: name the window chat to continue here, as /dc continue me-k3.";
  const background = backgroundHere($);
  const cwd = await $.session.cwd().catch(() => undefined);
  const commands = await windowCommands($);
  const posted = await postAsYou(
    $,
    {
      hook_event_name: "ChatOpen",
      thread,
      takeover,
      ...(launch !== null ? { launch } : {}),
      ...(await boundTo($)),
      runsOn: await windowModel($),
      commands,
      ...(await windowWhere($)),
      repo: cwd
        ? ((await repoIn($, cwd).catch(() => undefined)) ?? null)
        : null,
      background: await background,
    },
    { command: "/dc continue", nothing: "nothing was continued" },
  );
  if (typeof posted === "string") return posted;
  const said = await mirrorOpened(
    $,
    posted,
    "nothing was continued",
    commands,
    await background,
  );
  // A session a launch started exists only to join its chat. Once devcorner
  // refused that join it would run on unseen, so it ends itself. A 5xx, an
  // updating devcorner or no answer leaves it up: it may still join, or its
  // card gives the command that stops it. A 408 or 429 may pass, so it is
  // worth asking again.
  if (launch !== null && refusedJoin(posted.status)) {
    $.ui.toast(
      `dc: devcorner refused this session's join to ${thread}, so it ends`,
    );
    endSession($);
  }
  await briefWindow($, posted.body);
  return launch === null ? withRename(said, posted) : said;
}

/**
 * Adds a row the model reads, and the person does not see, to this window's
 * conversation, or to subagent `agentId`'s (`$.session.append`): null once
 * it is kept, else why not.
 */
async function addRow(
  $: Engine,
  text: string,
  agentId?: string,
): Promise<string | null> {
  try {
    const kept = await $.session.append({
      message: { type: "user", content: [{ type: "text", text }] },
      ...(agentId === undefined ? {} : { agentId }),
    });
    return kept.deny ?? null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Tells the model where its replies are read (`LAPTOP_CHAT_INSTRUCTION`) as
 * its mirroring of window chat `thread` begins, as a row of its conversation.
 * Where the row cannot be added, the person is told, since the model goes on
 * without it.
 */
async function instructWindow($: Engine, thread: string): Promise<void> {
  const why = await addRow($, LAPTOP_CHAT_INSTRUCTION);
  if (why !== null)
    $.ui.toast(
      `dc: how to write for ${thread} did not reach this window: ${why}`,
    );
}

/**
 * Hands the model the briefing devcorner answered a `/dc continue` with,
 * once the chat moved here from another window, as a row of its
 * conversation (`$.session.append`), and toasts it: the chat's summary,
 * where that window left its folder, and its last exchanges, so this
 * window's next turn knows what the chat was doing. None for a chat that
 * did not move. Where the row cannot be added, the person is told, since
 * the model goes on without it.
 */
async function briefWindow($: Engine, body: unknown): Promise<void> {
  const answer = (body ?? {}) as {
    briefing?: unknown;
    chat?: { thread?: unknown };
  };
  if (typeof answer.briefing !== "string" || answer.briefing === "") return;
  const id =
    typeof answer.chat?.thread === "string" ? answer.chat.thread : "the chat";
  const why = await addRow($, answer.briefing);
  $.ui.toast(
    why === null
      ? `dc: this window was briefed on ${id} from its summary`
      : `dc: ${id}'s briefing did not reach this window: ${why}`,
  );
}

/**
 * A restart or a resume of a session that mirrored a chat rejoins it,
 * quietly: one moved, turned off or ended meanwhile (a refusal with its code)
 * stays where it is and is forgotten here. Any other failure, such as a
 * rejoin that came before devcorner heard this window's start, or devcorner
 * down, tries again a few times and keeps the chat for the next start: in
 * the session's store, or for a chat the window's own memory named, in the
 * window's `rejoining`, which outlives a reload and a new conversation.
 */
async function rejoinMirror(
  $: Engine,
  life: number,
  kept: string | null,
  tries = 1,
): Promise<void> {
  if (mirror !== null || life !== sessionLife) return;
  // A copy a reload replaced never binds the chat back to itself: a retry
  // of its rejoin still runs after the reload.
  if (await superseded($)) return;
  const id = await $.session.id();
  // The chat this session mirrored, or else the one this window mirrored
  // under the conversation before (`kept`, from the row a reload or a new
  // conversation left): devcorner takes the window back by its own key.
  const saved = await $.store.get(mirroredKey(id));
  const thread = typeof saved === "string" ? saved : kept;
  if (thread === null) return;
  const byWindow = typeof saved !== "string";
  // The start clears the row, so the window's memory of the chat is kept
  // apart until this rejoin settles: devcorner down around a reload or a
  // /clear leaves it for the next copy's or conversation's start.
  if (byWindow) await update($, rejoining, () => thread).catch(() => {});
  // What it runs on and where it works now, which a resume may have changed
  // (`--model`, a worktree), so the chat's head says them from the rejoin
  // rather than its next turn, and the commands it has now. A revived
  // background session says it is one again, so it can be revived once more
  // when Claude Code parks it next.
  const background = backgroundHere($);
  const commands = await windowCommands($);
  const posted = await postAsYou(
    $,
    {
      hook_event_name: "ChatOpen",
      thread,
      rejoin: true,
      ...(await boundTo($)),
      // Named by this window's own memory, not this session's store: a chat
      // an older plugin bound with no window key is still this window's.
      ...(byWindow ? { windowKept: true } : {}),
      runsOn: await windowModel($),
      commands,
      ...(await windowWhere($)),
      background: await background,
    },
    { command: "the window chat's rejoin", nothing: "it was not rejoined" },
  );
  // A copy a reload replaced meanwhile leaves the chat to the newer copy.
  if (life !== sessionLife || (await superseded($))) return;
  if (typeof posted !== "string") {
    if (posted.status === 200) {
      if (mirror === null)
        await mirrorOpened(
          $,
          posted,
          "it was not rejoined",
          commands,
          await background,
        );
      return;
    }
    const code = (posted.body as { code?: unknown } | null)?.code;
    if (posted.status === 409 && typeof code === "string") {
      if (byWindow) await update($, rejoining, () => null).catch(() => {});
      else await $.store.delete(mirroredKey(id));
      return;
    }
  }
  if (tries < MIRROR_TRIES)
    $.clock.after(MIRROR_RETRY_MS, () => {
      void rejoinMirror($, life, kept, tries + 1).catch(() => {});
    });
}

/**
 * Hands the model a hand-over of messages the hook script gave at a stop as
 * a row of its conversation (`$.session.append`), which the person does not
 * see, and toasts it. Claude Code shows a Stop hook's context to the person
 * whole, as "Stop hook feedback", and a block's reason as "Stop hook error",
 * so what is left there is one line (`handOverLine`), and the stop is still
 * carried on, since devcorner has marked the messages handed. Where the row
 * cannot be added, the text stays as the script gave it: the model must
 * have it.
 */
async function asideAtStop(
  $: Engine,
  text: string,
  agentId: string | undefined,
): Promise<string> {
  $.ui.toast(handOverToast(text));
  const why = await addRow($, text, agentId);
  if (why === null) return handOverLine(text);
  $.ui.log(`devcorner: a hand-over stays in the stop hook's text: ${why}`, {
    to: "debug",
  });
  return text;
}

/**
 * A stop hook's answer with each hand-over of messages in it put aside
 * (`asideAtStop`): the Stop hook's context, and a subagent's block, which
 * the hook script carries its last tool calls' messages in.
 */
async function handedAtStop<
  R extends { block?: string; additionalContext?: string[] },
>($: Engine, ran: R, agentId?: string): Promise<R> {
  const block =
    ran.block !== undefined && isHandOver(ran.block)
      ? await asideAtStop($, ran.block, agentId)
      : ran.block;
  // One at a time, so the rows keep the order the hook gave them in.
  const contexts: string[] = [];
  for (const text of ran.additionalContext ?? []) {
    contexts.push(
      isHandOver(text) ? await asideAtStop($, text, agentId) : text,
    );
  }
  return {
    ...ran,
    ...(block === undefined ? {} : { block }),
    ...(ran.additionalContext === undefined
      ? {}
      : { additionalContext: contexts }),
  };
}

/** A hook's answer as it is, with a toast for each hand-over of messages in its context. */
function toastHandOvers<R extends { additionalContext?: string[] }>(
  $: Engine,
  ran: R,
): R {
  for (const text of ran.additionalContext ?? []) {
    if (isHandOver(text)) $.ui.toast(handOverToast(text));
  }
  return ran;
}

// Local subagents (docs/architecture/plugin.md, 0.50.0, and
// docs/architecture/local-subagents.md). devcorner lists its one `subagent`
// tool read-only, so several calls in one answer run side by side, and the
// plugin answers each before it leaves the laptop: it runs the child with
// devcorner's local agent, Pi in a clone of the checkout, and hands back its
// answer and its patch. A call a hook answers meets no permission prompt of
// Claude Code's, so the plugin asks `$.tool.check` itself. The window's
// subagent token, made on the hook route with this machine's hook token,
// stays in the module's memory alone; each round's child credential goes to
// the launcher on its standard input, and the launcher builds Pi's
// environment from an allowlist, so neither the hook token nor any other
// key of the session's reaches the child.

/** An error's own words. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** devcorner's subagent tool, on a server named for devcorner, as `CARRIER`'s: the connector's or this plugin's own. */
export const SUBAGENT_CALL = /^mcp__[\w-]*devcorner[\w-]*__subagent$/i;

/**
 * The local agent this plugin runs, by npm's name, the version it pins and
 * its tarball's integrity, which an install is checked against. Null until
 * the package is published, which is its person's decision: until then a
 * launcher is named with `LOCAL_AGENT_ENV`.
 */
export const LOCAL_AGENT = {
  name: "@devcorner/agent",
  version: "0.1.0",
  integrity: null as string | null,
};

/** The oldest Node the local agent runs on: Pi's own floor. */
export const LOCAL_AGENT_NODE = [22, 19] as const;

/**
 * A launcher to run in place of the installed package, by its path: a stub
 * that prints a round's lines, or the launcher built from devcorner's repo
 * while the package is not published. Whoever sets the session's
 * environment already runs what they like as its person. `$.env.get` takes
 * its name written out (`localLauncherOf`).
 */
export const LOCAL_AGENT_ENV = "DEVCORNER_LOCAL_AGENT";

/** The plugin's store: the person's answer to the first-use question ("yes" or "no"), and the Node found. */
export const LOCAL_AGENT_ANSWER = "localAgent";
const LOCAL_AGENT_NODE_KEY = "localAgentNode";

/** The most of a child's answer the result holds, as a box's child's (`childAnswer`). */
const MAX_CHILD_ANSWER_BYTES = 16 * 1024;
/** The most changed files the result names; the rest are counted. */
const MAX_CHILD_FILES = 20;

/** Where `$.process` is refused: the desktop app's and an IDE's Claude Code. */
export const LOCAL_CLI_ONLY =
  "Local subagents need Claude Code's command line on this machine; use the Agent tool here.";
/** A machine with no hook token: signed in through a connector alone, or not at all. */
export const LOCAL_SIGNED_OUT =
  "Local subagents need this machine signed in to devcorner: run /dc login, or ask Claude to sign it in.";
/** A cloud session, never signed in: its plugin runs no child, and a retry goes the same way. */
export const LOCAL_IN_CLOUD =
  "A cloud session runs no local subagents, and calling again goes the same way: use the Agent tool here.";
/** A window that has not called start. */
export const LOCAL_NO_SESSION =
  "Call devcorner's start first: a local child runs under this conversation's session.";
/** The person said "Not now" to the first-use question. */
export const LOCAL_DECLINED =
  "The person declined devcorner's local subagents on this machine: do the work yourself or use the Agent tool. /dc local-agent install turns them on.";
/** Where nobody can answer the first-use question (`claude -p`). */
export const LOCAL_NOBODY_FIRST =
  "devcorner's local subagents need their person's yes once on this machine, and nobody can be asked here: run /dc local-agent install in an interactive Claude Code window first.";

/** The person closed the first-use question without answering: not a no, so nothing is kept and a call in a later turn asks again. */
export const LOCAL_DISMISSED_FIRST =
  "The person closed devcorner's first-use question without answering: not now. Do this work yourself or with the Agent tool; a subagent call in a later turn asks again, or /dc local-agent install answers it.";

/**
 * The first-use question: the trust before the size, which is said only
 * when the yes installs the package. `$.ui.ask` takes a question that ends
 * in its question mark, so the trust comes first.
 */
export function localFirstUse(installs: boolean): string {
  return `A local subagent runs commands and edits files on this machine as you, without asking you first, like Claude Code with its permission prompts off. It works in a copy of your checkout, but can reach any file you can. Its model calls are billed to your workspace's gateway.${installs ? " Installing it downloads Pi (about 26 MB, 160 MB on disk)." : ""} Run devcorner's subagents on this laptop?`;
}
const INSTALL = "Install";
const RUN_THEM = "Run them";
const NOT_NOW = "Not now";

/** A call's own question, where no rule allows the tool: it meets no permission prompt of Claude Code's. */
export function localAskText(ask: SubagentCall): string {
  const what =
    ask.resume !== null
      ? `resume the local subagent ${ask.resume}`
      : `start a local subagent (${ask.kind}: ${ask.description})`;
  return `devcorner's plugin would ${what}. It runs commands and edits files in a copy of your checkout, as you, without asking. Run it?`;
}
const RUN_IT = "Run it";
const DONT_RUN = "Don't run it";

/** The person closed a call's own question without answering. */
export const LOCAL_DISMISSED_ASK =
  "The person closed devcorner's question without answering: not now. Do this work yourself or with the Agent tool, and call subagent again only when the person asks for it.";

/** Why a call that needed the person's yes was refused where nobody can be asked. */
export const localNobodyText = (tool: string) =>
  `devcorner's subagent runs without Claude Code's permission prompt, so the plugin asks you itself, and nobody can be asked here. Allow the tool with a rule (--allowedTools ${tool}, or permissions.allow in settings) to run local subagents in this session.`;

/** A subagent call's arguments, as the plugin reads them: the rest are devcorner's to check. */
export interface SubagentCall {
  /** The child to continue, or null for a new one. */
  resume: string | null;
  kind: string | null;
  description: string | null;
  prompt: string;
  /** As the call gave them, for devcorner to check. */
  minutes: unknown;
  budget_usd: unknown;
}

/**
 * A subagent call's arguments, or what is wrong with them: the task, and
 * either the child to continue or a kind and a few words. devcorner checks
 * the kind, the words' length and the limits as it begins the round.
 */
export function subagentCallOf(
  args: Record<string, unknown>,
): SubagentCall | string {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "")
    return "prompt must say the whole task: the child knows nothing else.";
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const resume = text(args.resume);
  const kind = text(args.subagent_type);
  const description = text(args.description);
  if (resume === null && (kind === null || description === null))
    return "A new child needs subagent_type and description; resume names an earlier child to continue.";
  return {
    resume,
    kind,
    description,
    prompt: args.prompt,
    minutes: args.minutes,
    budget_usd: args.budget_usd,
  };
}

/** A Node version, `v22.19.0` or a version manager's folder `22.19.0`, as its major, minor and patch; null for anything else. */
function nodeVersionOf(printed: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(printed.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether a Node version runs the local agent. */
export function nodeRunsLocalAgent(printed: string): boolean {
  const v = nodeVersionOf(printed);
  if (v === null) return false;
  const [major, minor] = LOCAL_AGENT_NODE;
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

/** The Node the launcher runs on: its path and its version as it prints it. */
type LocalNode = { path: string; version: string };

/** A Node at `path`, with its version as it prints it (empty when it prints none). */
async function nodeAt($: Engine, path: string): Promise<LocalNode> {
  const printed = await $.process.run([path, "--version"], {
    timeoutMs: 10_000,
  });
  return { path, version: printed.stdout.trim() };
}

/**
 * A node in a version manager's own folder of versions: the folder, the
 * version's folder in it, named as `v24.7.0` or `24.7.0`, and the binary's
 * path under that, as nvm's `~/.nvm/versions/node/v24.7.0/bin/node`, which
 * its login shell finds. A shim (asdf's, Volta's, fnm's per-shell link) is
 * no such path.
 */
const VERSIONED_NODE = /^(.+)\/(v?\d+\.\d+\.\d+)(\/.+)$/;

/**
 * The newest Node that runs the local agent among the versions installed
 * beside `path` in its version manager's folder, its version read from the
 * binary itself; null when none does, or `path` is in no such folder. A
 * login shell resolves the manager's default, which may be older than a
 * version installed beside it (nvm's default 22.18 with 24 installed). A
 * pre-release's folder (`v25.0.0-nightly…`) is not taken.
 */
async function newerNodeBeside(
  $: Engine,
  path: string,
): Promise<LocalNode | null> {
  const m = VERSIONED_NODE.exec(path);
  if (m === null) return null;
  const [, folder, , below] = m;
  const versions = (await $.fs.list(folder!))
    .filter(
      ({ name }) => /^v?\d+\.\d+\.\d+$/.test(name) && nodeRunsLocalAgent(name),
    )
    .map(({ name }) => ({ name, version: nodeVersionOf(name)! }))
    .sort(
      ({ version: x }, { version: y }) =>
        y[0] - x[0] || y[1] - x[1] || y[2] - x[2],
    );
  for (const { name } of versions) {
    const candidate = `${folder}/${name}${below}`;
    if (!(await $.fs.exists(candidate))) continue;
    const node = await nodeAt($, candidate);
    if (nodeRunsLocalAgent(node.version)) return node;
  }
  return null;
}

/** The person's login shell, which finds the node a version manager puts on its PATH alone. */
async function loginShellOf($: Engine): Promise<string> {
  return (await $.env.get("SHELL")) || "/bin/sh";
}

/** The path of the node the person's login shell finds, or null when it finds none. */
async function loginShellNode($: Engine): Promise<string | null> {
  const where = await $.process.run(
    [await loginShellOf($), "-ilc", "command -v node"],
    { timeoutMs: 15_000 },
  );
  // An interactive shell may print its own lines first: the path is the
  // last line that is one.
  const path = where.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .at(-1);
  return where.exitCode !== 0 || path === undefined ? null : path;
}

/**
 * The Node the launcher runs on: the path kept, while it is there and runs
 * the local agent, else the one the person's login shell finds (nvm puts it
 * on that shell's PATH alone), else the newest that runs it installed beside
 * that one (`newerNodeBeside`), kept for the next call. Its version is read
 * at each call, since an upgrade may keep its path. With none, it is refused,
 * naming the shell's and what makes a newer one found.
 */
async function localNodeOf(
  $: Engine,
  again = false,
): Promise<LocalNode | string> {
  const kept = await $.store.get(LOCAL_AGENT_NODE_KEY);
  let keptNode: LocalNode | undefined;
  if (!again && typeof kept === "string" && (await $.fs.exists(kept))) {
    keptNode = await nodeAt($, kept);
    if (nodeRunsLocalAgent(keptNode.version)) return keptNode;
  }
  const shell = await loginShellOf($);
  const path = await loginShellNode($);
  if (path === null)
    return `Local subagents need Node ${LOCAL_AGENT_NODE.join(".")} or later, and your login shell (${shell}) finds no node.`;
  const found = path === keptNode?.path ? keptNode : await nodeAt($, path);
  const node = nodeRunsLocalAgent(found.version)
    ? found
    : await newerNodeBeside($, path);
  if (node === null) {
    const fix = VERSIONED_NODE.test(path)
      ? "No newer version is installed beside it: install one with its version manager, as `nvm install --lts` does with nvm, and try again."
      : "Put a newer one first on your login shell's PATH, and try again.";
    return `Local subagents need Node ${LOCAL_AGENT_NODE.join(".")} or later; your login shell's node, ${path}, is ${found.version || "of no version it says"}. ${fix}`;
  }
  await $.store.set(LOCAL_AGENT_NODE_KEY, node.path);
  return node;
}

/** The folder the local agent and its children are kept in: `<stateDir>/local-agent`. */
async function localAgentDir($: Engine): Promise<string | undefined> {
  const base = stateDir(await stateEnvOf($));
  return base ? `${base}/local-agent` : undefined;
}

/** Where the pinned version's launcher is once installed under `dir`. */
export const installedLauncher = (dir: string) =>
  `${dir}/${LOCAL_AGENT.version}/node_modules/${LOCAL_AGENT.name}/bin/local-agent.js`;

/** The launcher a round runs: the one `LOCAL_AGENT_ENV` names, else the installed package's, else null. */
async function localLauncherOf(
  $: Engine,
  dir: string,
): Promise<{ path: string; named: boolean } | null> {
  const named = await $.env.get("DEVCORNER_LOCAL_AGENT");
  if (named) return { path: named, named: true };
  const path = installedLauncher(dir);
  return (await $.fs.exists(path)) ? { path, named: false } : null;
}

/**
 * Installs the pinned version under `dir` with npm, beside the Node found,
 * running no package's scripts, and checks the installed tarball's
 * integrity against the pinned one: a mismatch removes it. Once in, the
 * other versions are removed, children kept. Null once installed, else why
 * not.
 */
async function installLocalAgent(
  $: Engine,
  node: LocalNode,
  dir: string,
): Promise<string | null> {
  const { name, version, integrity } = LOCAL_AGENT;
  if (integrity === null) return localAgentUnpublished();
  const at = `${dir}/${version}`;
  // npm beside the Node found, run by its own path with that Node first on
  // its PATH: a version manager's npm may be a shim or a binary, not npm's
  // own script.
  const bin = node.path.replace(/\/[^/]+$/, "");
  const removeIt = () =>
    $.process.run(["rm", "-rf", at], { timeoutMs: 60_000 });
  const done = await $.process.run(
    [
      `${bin}/npm`,
      "install",
      "--prefix",
      at,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${name}@${version}`,
    ],
    {
      env: { PATH: `${bin}:${(await $.env.get("PATH")) ?? ""}` },
      timeoutMs: 600_000,
    },
  );
  if (done.exitCode !== 0) {
    await removeIt();
    return `npm could not install devcorner's local agent ${version}: ${(done.stderr.trim() || done.stdout.trim()).slice(-800)}`;
  }
  let got: unknown;
  try {
    const lock = JSON.parse(String(await $.fs.read(`${at}/package-lock.json`)));
    got = lock?.packages?.[`node_modules/${name}`]?.integrity;
  } catch {
    got = undefined;
  }
  if (got !== integrity) {
    await removeIt();
    return `The local agent npm installed is not the one this plugin pins (its integrity is ${typeof got === "string" ? got : "not recorded"}), so it was removed.`;
  }
  // One version is kept; its children stay.
  await $.process.run(
    [
      "sh",
      "-c",
      'for d in "$1"/*; do case "${d##*/}" in children|"$2") ;; *) rm -rf "$d" ;; esac; done',
      "sh",
      dir,
      version,
    ],
    { timeoutMs: 60_000 },
  );
  $.ui.log(`Installed devcorner's local agent ${version}.`);
  return null;
}

/** The first-use question and install under way: calls side by side wait for the one, so the person is asked once and npm runs once. */
let firstUse: Promise<{ path: string; asked: boolean } | string> | null = null;

/**
 * The launcher a call runs, once its person said yes on this machine: the
 * one `LOCAL_AGENT_ENV` names or the pinned version installed, installed
 * now when it is not there. A machine whose person never answered is asked
 * the first-use question, whose yes stands for the asking call's own too
 * (`asked`); with their earlier yes, a plugin update's new version installs
 * with no question. "Not now" is kept, and refuses until
 * `/dc local-agent install`; where nobody can be asked, it is refused with
 * how to say yes. While nothing can be installed, nothing is asked.
 */
async function localLauncherFor(
  $: Engine,
  node: LocalNode,
  dir: string,
): Promise<{ path: string; asked: boolean } | string> {
  const there = await localLauncherOf($, dir);
  if (there === null && LOCAL_AGENT.integrity === null)
    return localAgentUnpublished();
  if (there !== null && (await $.store.get(LOCAL_AGENT_ANSWER)) === "yes")
    return { path: there.path, asked: false };
  if (firstUse !== null) {
    const got = await firstUse;
    return typeof got === "string" ? got : { path: got.path, asked: false };
  }
  firstUse = askAndInstall($, node, dir, there?.path ?? null);
  try {
    return await firstUse;
  } finally {
    firstUse = null;
  }
}

/** Why nothing can be installed while the package is not published. */
const localAgentUnpublished = () =>
  `devcorner's local agent ${LOCAL_AGENT.version} is not on npm yet: publishing it is your person's decision. Until it is, ${LOCAL_AGENT_ENV} names a launcher for this plugin to run.`;

/**
 * The first-use question, its answer kept: null once the person said yes,
 * else why not. "Not now" is kept as a no; a window with a surface whose
 * question was closed with Esc is a dismissal, not a no, and keeps nothing.
 */
async function askFirstUse(
  $: Engine,
  installs: boolean,
): Promise<string | null> {
  const yes = installs ? INSTALL : RUN_THEM;
  let said: string;
  try {
    said = await $.ui.ask(localFirstUse(installs), [yes, NOT_NOW]);
  } catch {
    return (await draws($)) ? LOCAL_DISMISSED_FIRST : LOCAL_NOBODY_FIRST;
  }
  if (said !== yes) {
    await $.store.set(LOCAL_AGENT_ANSWER, "no");
    return LOCAL_DECLINED;
  }
  await $.store.set(LOCAL_AGENT_ANSWER, "yes");
  return null;
}

/** `localLauncherFor`'s question, kept answer and install, one at a time; `there` is a launcher already on the machine. */
async function askAndInstall(
  $: Engine,
  node: LocalNode,
  dir: string,
  there: string | null,
): Promise<{ path: string; asked: boolean } | string> {
  const answer = await $.store.get(LOCAL_AGENT_ANSWER);
  if (answer === "no") return LOCAL_DECLINED;
  let asked = false;
  if (answer !== "yes") {
    const refused = await askFirstUse($, there === null);
    if (refused !== null) return refused;
    asked = true;
  }
  if (there !== null) return { path: there, asked };
  const failed = await installLocalAgent($, node, dir);
  return failed ?? { path: installedLauncher(dir), asked };
}

/**
 * `/dc local-agent install`: the first-use question asked when no yes is
 * kept, then the pinned version installed, or what is in use said: the
 * launcher, its folder and the Node it runs on. While the package is not
 * published and no launcher is named, nothing can be installed, so it says
 * so and keeps no yes.
 */
async function localAgentHere($: Engine): Promise<string> {
  const refused = await processRefused($);
  if (refused !== null) return refused;
  const dir = await localAgentDir($);
  if (dir === undefined)
    return "This machine has no home folder to keep devcorner's local agent in.";
  const node = await localNodeOf($, true);
  if (typeof node === "string") return node;
  const there = await localLauncherOf($, dir);
  // Nothing to install and no launcher named: there is nothing to say yes
  // to, so no yes is kept.
  if (there === null && LOCAL_AGENT.integrity === null)
    return localAgentUnpublished();
  if ((await $.store.get(LOCAL_AGENT_ANSWER)) !== "yes") {
    const refused = await askFirstUse($, there === null);
    if (refused !== null) return refused;
  }
  if (there?.named)
    return `Local subagents run the launcher ${LOCAL_AGENT_ENV} names, ${there.path}, with Node ${node.version} at ${node.path}. Nothing is installed while it is set.`;
  if (there === null) {
    const failed = await installLocalAgent($, node, dir);
    if (failed !== null) return failed;
  }
  return `devcorner's local agent ${LOCAL_AGENT.version} is installed in ${dir}/${LOCAL_AGENT.version}, run with Node ${node.version} at ${node.path}. Its children are kept in ${dir}/children.`;
}

/** `$.process` ran once in this load: the surface does not change under a module. */
let processRuns = false;

/**
 * Why `$.process` cannot run here, in 2.5's words, or null when it can: the
 * desktop app's and an IDE's Claude Code refuse it.
 */
async function processRefused($: Engine): Promise<string | null> {
  if (processRuns) return null;
  try {
    await $.process.run(["true"], { timeoutMs: 5_000 });
    processRuns = true;
    return null;
  } catch (error) {
    return `${LOCAL_CLI_ONLY} (${errorText(error)})`;
  }
}

/** The lines of a round the result is made of, as the launcher writes them (packages/local-agent/src/round.ts). */
export interface RoundLines {
  started: {
    child: string;
    kind: string;
    model: string;
    effort: string | null;
  } | null;
  answer: {
    answer: string;
    change: {
      files: string[];
      patch: string | null;
      kept: { dir: string; why: string } | null;
    };
  } | null;
  ended: {
    outcome: string;
    ms: number;
    usd: number | null;
    reason: string | null;
  } | null;
}

/** Keeps what one line of the launcher's says of the round in `kept`; any other line is passed over. */
export function readRoundLine(kept: RoundLines, line: string): void {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (v === null || typeof v !== "object") return;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  if (v.type === "child-started")
    kept.started = {
      child: str(v.child) ?? "",
      kind: str(v.kind) ?? "",
      model: str(v.model) ?? "",
      effort: str(v.effort),
    };
  else if (v.type === "child-answer") {
    const change = (v.change ?? {}) as Record<string, unknown>;
    const clone = change.kept as { dir?: unknown; why?: unknown } | null;
    kept.answer = {
      answer: str(v.answer) ?? "",
      change: {
        files: Array.isArray(change.files)
          ? change.files.filter((f): f is string => typeof f === "string")
          : [],
        patch: str(change.patch),
        kept:
          clone && typeof clone.dir === "string"
            ? { dir: clone.dir, why: str(clone.why) ?? "" }
            : null,
      },
    };
  } else if (v.type === "child-ended")
    kept.ended = {
      outcome: str(v.outcome) ?? "error",
      ms: typeof v.ms === "number" ? v.ms : 0,
      usd: typeof v.usd === "number" ? v.usd : null,
      reason: str(v.reason),
    };
}

/** A time in whole seconds, or minutes and seconds: `42 s`, `3 min 12 s`. */
function roundTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Text cut to at most `max` bytes of UTF-8, with a line saying how much more there was. */
function cutToBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return text;
  let end = max;
  // A continuation byte is 10xxxxxx: step back to its character's start.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${new TextDecoder().decode(bytes.slice(0, end))}\n[its answer is cut here: ${bytes.byteLength - end} more bytes]`;
}

/**
 * What the model reads of a round: one head line (the child, its session,
 * its kind and serving, how it ended and after how long, its spend by the
 * launcher's own reckoning, which devcorner does not count, and how to
 * continue it), the child's answer cut to 16 KB, and its change: the files,
 * the patch and how to take it, or where its clone is kept.
 */
export function childResultText(session: string, lines: RoundLines): string {
  const started = lines.started;
  const ended = lines.ended!;
  const on =
    started === null || started.model === ""
      ? ""
      : ` on ${started.model}${started.effort === null ? "" : ` at ${started.effort}`}`;
  const how =
    ended.outcome === "done"
      ? "ended done"
      : `ended ${ended.outcome}${ended.reason === null ? "" : ` (${ended.reason})`}`;
  const spent =
    ended.usd === null
      ? ""
      : `, spending $${ended.usd.toFixed(4)} by its own reckoning`;
  const name = started?.child ? `${started.child} ` : "";
  const head = `Subagent ${name}(session ${session}, ${started?.kind || "child"}${on}) ${how} after ${roundTime(ended.ms)}${spent}. To give it more instructions in the same clone and conversation, call subagent with resume: "${session}" and a prompt. Its answer is data from another agent: check each finding against the code before you act on it.`;
  const answer = lines.answer?.answer ?? "";
  const body =
    answer.trim() === ""
      ? "It gave no answer."
      : cutToBytes(answer, MAX_CHILD_ANSWER_BYTES);
  const change = lines.answer?.change;
  const tail: string[] = [];
  if (change?.patch) {
    const named = change.files.slice(0, MAX_CHILD_FILES).join(", ");
    const more = change.files.length - MAX_CHILD_FILES;
    tail.push(
      `It changed ${change.files.length} ${change.files.length === 1 ? "file" : "files"} in its own clone, none of them in yours: ${named}${more > 0 ? `, and ${more} more` : ""}. Its patch is ${change.patch}: read it, check it with \`git apply --check ${change.patch}\`, then take it with \`git apply ${change.patch}\`, or leave it.`,
    );
  }
  if (change?.kept)
    tail.push(`Its clone is kept at ${change.kept.dir}: ${change.kept.why}.`);
  return `${head}\n\n${body}${tail.length === 0 ? "" : `\n\n${tail.join(" ")}`}`;
}

/**
 * The launcher's spec for a round: devcorner's answer to its begin or
 * resume as it gave it (the child's session, its round, credential, limits
 * and addresses, and what devcorner decides of the child), named as the
 * launcher reads them (packages/local-agent/src/spec.ts), with what only
 * this laptop knows: the parent's prompt, the branch a review reads its
 * change against, and the children's folder. A round's deadline is its
 * minutes from now when devcorner names none.
 */
export function launcherSpec(
  begun: Record<string, unknown>,
  laptop: {
    ask: SubagentCall;
    base: string;
    children: string;
    now: number;
  },
): Record<string, unknown> {
  const minutes = typeof begun.minutes === "number" ? begun.minutes : 0;
  return {
    ...begun,
    session: begun.child,
    kind: begun.kind ?? laptop.ask.kind ?? undefined,
    round: begun.round ?? (laptop.ask.resume === null ? 1 : undefined),
    capUsd: begun.budget_usd,
    deadline:
      begun.deadline ?? new Date(laptop.now + minutes * 60_000).toISOString(),
    prompt: laptop.ask.prompt,
    base: laptop.base,
    children: laptop.children,
  };
}

/**
 * The window's subagent token (dc-d2050 4.1), in this module's memory alone,
 * for the session the window claims on this devcorner. Concurrent calls
 * share one mint, since a second mint ends the first and its children.
 */
let subagentHeld: {
  claim: string;
  base: string;
  token: Promise<string | { refused: string }>;
} | null = null;

/** Reads a hook route answer's JSON body, or `{}`. */
function bodyOf(res: { text: string }): Record<string, unknown> {
  try {
    const v = JSON.parse(res.text) as unknown;
    return v !== null && typeof v === "object"
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** devcorner's words for a refused hook event, or the status it answered. */
function refusalOf(res: {
  status: number;
  headers: Record<string, string>;
  text: string;
}): string {
  if (updatingFor(res) !== null)
    return `${UPDATING_LINE}: try the subagent again in a minute.`;
  const error = bodyOf(res).error;
  return typeof error === "string" && error.trim() !== ""
    ? error
    : `devcorner answered ${res.status}.`;
}

/**
 * The longest a subagent token waits for devcorner, while it says it is
 * updating, to hear the window's claim (`sayClaim`).
 */
const CLAIM_SAID_WAIT_MS = 2 * 60_000;

/** A subagent call's answer when its turn was interrupted before its round began. */
const INTERRUPTED_BEFORE =
  "The turn was interrupted before the subagent started.";

/**
 * Says the window's claim on a Status of its own before a subagent token is
 * asked for: devcorner makes one only for the session a window of this
 * machine is tied to, and ties it from the claim a Status carries. The
 * Status a start sends may not have landed yet, or was answered that
 * devcorner is updating, so a subagent call made just after a start was
 * refused for a tie a moment behind. While devcorner says it is updating it
 * is asked again when it said, up to `CLAIM_SAID_WAIT_MS`; any other answer
 * is left to the token's own request, whose refusal says why. False when
 * `signal` aborted, the turn interrupted, before or while it waited.
 */
async function sayClaim($: Engine, signal: AbortSignal): Promise<boolean> {
  const until = (await $.clock.now()) + CLAIM_SAID_WAIT_MS;
  for (;;) {
    const wait = (await refresh($, true))?.retryIn ?? null;
    if (wait === null || (await $.clock.now()) + wait > until) break;
    const waited = await new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const stop = () => {
        timer.cancel();
        resolve(false);
      };
      const timer = $.clock.after(wait, () => {
        signal.removeEventListener("abort", stop);
        resolve(true);
      });
      signal.addEventListener("abort", stop, { once: true });
    });
    if (!waited) return false;
  }
  return !signal.aborted;
}

/**
 * The window's subagent token for the session it claims: the one it holds,
 * else one made with this machine's hook token. `stale` is a token devcorner
 * refused as expired or revoked: one is made in its place only while it is
 * still the one held, so calls side by side refused together share the one
 * new token, never ending each other's children with a mint of their own.
 * A mint says the claim first (`sayClaim`), stopping at `signal`, the
 * minting call's: an interrupt aborts every call of its turn alike.
 */
async function subagentTokenOf(
  $: Engine,
  claimed: string,
  hook: string,
  stale: string | null,
  signal: AbortSignal,
): Promise<string | { refused: string }> {
  const base = await baseOf($);
  for (;;) {
    const held = subagentHeld;
    if (held === null || held.claim !== claimed || held.base !== base) break;
    const got = await held.token.catch(() => null);
    // Another call changed the token meanwhile: look again.
    if (subagentHeld !== held) continue;
    if (got !== null && (typeof got !== "string" || got !== stale)) return got;
    break;
  }
  const token = (async (): Promise<string | { refused: string }> => {
    if (!(await sayClaim($, signal))) return { refused: INTERRUPTED_BEFORE };
    const res = await postEvent($, hook, {
      hook_event_name: "SubagentToken",
      claim: claimed,
    });
    const body = bodyOf(res);
    return res.status === 200 && typeof body.token === "string"
      ? body.token
      : { refused: refusalOf(res) };
  })();
  const held = { claim: claimed, base, token };
  subagentHeld = held;
  // A refusal or a failure is not kept: the next call asks again.
  void token
    .then((got) => {
      if (typeof got !== "string" && subagentHeld === held) subagentHeld = null;
    })
    .catch(() => {
      if (subagentHeld === held) subagentHeld = null;
    });
  return token;
}

/**
 * Begins or resumes the round on the hook route with the window's subagent
 * token: devcorner's answer, or its refusal. A held token refused as no
 * longer valid (401: expired at its 24 hours, or revoked) is made again
 * once; any other refusal stands, so a mint never stops the window's other
 * children for a refusal it would not cure.
 */
async function beginRound(
  $: Engine,
  claimed: string,
  hook: string,
  event: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ token: string; begun: Record<string, unknown> } | string> {
  let stale: string | null = null;
  for (let tries = 0; tries < 2; tries++) {
    const token = await subagentTokenOf($, claimed, hook, stale, signal);
    if (typeof token !== "string") return token.refused;
    const res = await postEvent($, token, event);
    if (res.status === 200) return { token, begun: bodyOf(res) };
    if (res.status !== 401) return refusalOf(res);
    stale = token;
  }
  return "devcorner refused this window's new subagent token too: sign this machine in again with /dc login.";
}

/**
 * The branch a review child reads its change against: origin's default
 * branch as the clone knows it, else origin's main or master, else the
 * branch the checkout is on.
 */
async function reviewBaseIn(
  $: Engine,
  root: string,
  branch: string | undefined,
): Promise<string> {
  const git = (args: string[]) =>
    $.process.run(["git", ...args], { cwd: root, timeoutMs: 5_000 });
  const head = await git([
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const named = head.exitCode === 0 ? head.stdout.trim() : "";
  if (named.startsWith("origin/")) return named.slice("origin/".length);
  for (const name of ["main", "master"])
    if (
      (
        await git([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${name}`,
        ])
      ).exitCode === 0
    )
      return name;
  return branch ?? "HEAD";
}

/** A folder made for its owner alone. */
async function privateFolder($: Engine, dir: string): Promise<void> {
  await $.process.run(["sh", "-c", 'umask 077 && mkdir -p "$1"', "sh", dir], {
    timeoutMs: 5_000,
  });
}

/**
 * The children's folder cleaned (dc-d2050 8.3): a Pi whose launcher was
 * killed outright is stopped, by its process group, once its pid file is
 * older than any round runs and its command line still names its child's
 * folder, so no other process is ever signalled; and a child whose folder
 * nothing touched for 24 hours (its last round's patch, or a launcher's pid
 * file, is written into it) goes with its clone, its Pi conversation and
 * its patches.
 */
async function sweepChildren($: Engine, children: string): Promise<void> {
  const swept = await $.process.run(
    [
      "sh",
      "-c",
      [
        '[ -d "$1" ] || exit 0',
        'for f in "$1"/*/pi.pid; do',
        '  [ -f "$f" ] || continue',
        '  [ -n "$(find "$f" -mmin +70)" ] || continue',
        '  d="${f%/pi.pid}"; p="$(cat "$f")"',
        '  case "$(ps -o args= -p "$p" 2>/dev/null)" in *"$d"*) kill -TERM -- "-$p" 2>/dev/null ;; esac',
        '  rm -f "$f"',
        "done",
        // Each folder's age is read just before it is removed, since a resume
        // touches its child's folder (`keepChild`). A folder kept, or gone to
        // another sweep, is no failure; only a removal that fails is. A glob
        // lists them, not find, which fails on a folder gone under it.
        "s=0",
        'for d in "$1"/*/; do',
        '  d="${d%/}"',
        '  [ -n "$(find "$d" -maxdepth 0 -mmin +1440 2>/dev/null)" ] || continue',
        '  rm -rf "$d" || s=1',
        "done",
        "exit $s",
      ].join("\n"),
      "sh",
      children,
    ],
    { timeoutMs: 60_000 },
  );
  if (swept.exitCode !== 0)
    throw new Error(
      `the sweep ended with ${swept.exitCode}: ${swept.stderr.trim().slice(-800)}`,
    );
}

/**
 * Marks a resumed child's folder as in use as soon as devcorner answers the
 * resume, so a sweep running beside it, from another round's end, does not
 * remove it. The folder is named by the child's full session id, which
 * devcorner's answer gives (`begun.child`), not by the call's own spelling;
 * a name that no session id can be is left alone.
 */
async function keepChild(
  $: Engine,
  children: string,
  child: string,
): Promise<void> {
  if (!/^[\w][\w.@-]*$/.test(child) || child.includes("..")) return;
  await $.process.run(
    [
      "sh",
      "-c",
      '[ -d "$1" ] && touch "$1"; exit 0',
      "sh",
      `${children}/${child}`,
    ],
    {
      timeoutMs: 10_000,
    },
  );
}

/** `sweepChildren` at a session's start, when there is a children's folder. */
async function sweepAtStart($: Engine): Promise<void> {
  const dir = await localAgentDir($);
  if (dir !== undefined && (await $.fs.exists(`${dir}/children`)))
    await sweepChildren($, `${dir}/children`);
}

/**
 * Answers a subagent call on this laptop (dc-d2050 2.2): the call's own
 * gate, what it needs here, the launcher (installed on the person's first
 * yes), the round begun on devcorner, then the launcher run to its end in
 * the repo's root with the spec on its standard input and the session's
 * DEVCORNER_TOKEN blanked, its lines read, the round ended on devcorner and
 * the child's answer and patch answered as the tool's result. An interrupt
 * aborts `signal`: Claude Code then stops the launcher and its whole tree
 * and never runs this hook's code after the loop again, so the round's end
 * is posted from the abort listener at once.
 */
async function answerSubagent(
  $: Engine,
  e: { tool: string } & Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ result: string } | { deny: string }> {
  const args = callArguments(e);
  const ask = subagentCallOf(args);
  if (typeof ask === "string") return { deny: ask };

  // A call a hook answers meets no permission prompt, so the session's own
  // rules are asked here: a deny refuses, an ask is the person's below.
  const verdict = await $.tool.check({ tool: e.tool, input: args });
  if (verdict.decision === "deny")
    return {
      deny:
        verdict.reason ??
        "A permission rule of this session denies devcorner's subagent.",
    };

  const refused = await processRefused($);
  if (refused !== null) return { deny: refused };
  const hook = await tokenOf($);
  if (hook === null)
    return { deny: (await inCloud($)) ? LOCAL_IN_CLOUD : LOCAL_SIGNED_OUT };
  const claimed = await claimOf($);
  if (claimed === null) return { deny: LOCAL_NO_SESSION };
  const dir = await localAgentDir($);
  if (dir === undefined)
    return {
      deny: "This machine has no home folder to keep devcorner's local agent and its children in.",
    };
  const node = await localNodeOf($);
  if (typeof node === "string") return { deny: node };
  const launcher = await localLauncherFor($, node, dir);
  if (typeof launcher === "string") return { deny: launcher };
  if (verdict.decision === "ask" && !launcher.asked) {
    let said: string;
    try {
      said = await $.ui.ask(localAskText(ask), [RUN_IT, DONT_RUN]);
    } catch {
      return {
        deny: (await draws($)) ? LOCAL_DISMISSED_ASK : localNobodyText(e.tool),
      };
    }
    if (said !== RUN_IT)
      return { deny: "The person did not let devcorner's subagent run." };
  }

  const cwd = await $.session.cwd();
  const top = await $.process.run(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: 5_000,
  });
  const root = top.exitCode === 0 ? top.stdout.trim() : "";
  if (root === "")
    return {
      deny: "A local subagent works in a clone of this conversation's git checkout, and this folder is in none.",
    };
  const branch = (await branchIn($, root).catch(() => undefined)) ?? undefined;
  const base = await reviewBaseIn($, root, branch);
  const children = `${dir}/children`;
  await privateFolder($, children);

  const begin = await beginRound(
    $,
    claimed,
    hook.token,
    ask.resume !== null
      ? {
          hook_event_name: "ChildResume",
          child: ask.resume,
          minutes: ask.minutes,
          budget_usd: ask.budget_usd,
        }
      : {
          hook_event_name: "ChildBegin",
          subagent_type: ask.kind,
          description: ask.description,
          minutes: ask.minutes,
          budget_usd: ask.budget_usd,
          branch,
        },
    signal,
  );
  if (typeof begin === "string") return { deny: begin };
  const { token, begun } = begin;
  const child = typeof begun.child === "string" ? begun.child : "";
  // Only the sweep gains from the touch, so its failure is logged and the
  // round, already begun on devcorner, goes on.
  if (ask.resume !== null && child !== "")
    await keepChild($, children, child).catch((error: unknown) =>
      $.ui.log(`marking ${child}'s folder in use failed: ${errorText(error)}`, {
        to: "debug",
      }),
    );
  const started = Date.now();

  // The round's end is posted once, whichever comes first: the launcher's
  // end, read after its loop, or an interrupt, from the abort listener.
  let ending: Promise<void> | null = null;
  const endRound = (
    outcome: string,
    reason: string | null,
    ms: number,
  ): Promise<void> => {
    ending ??= postEvent($, token, {
      hook_event_name: "ChildEnd",
      child,
      round: begun.round,
      outcome,
      reason,
      ms,
    })
      .then((res) => {
        if (res.status !== 200)
          $.ui.log(
            `devcorner did not take the end of ${child}'s round: ${refusalOf(res)}`,
            { to: "debug" },
          );
      })
      .catch((error: unknown) =>
        $.ui.log(
          `the end of ${child}'s round did not reach devcorner: ${errorText(error)}`,
          { to: "debug" },
        ),
      )
      .then(() => sweepChildren($, children))
      .catch((error: unknown) =>
        $.ui.log(
          `cleaning the children's folder after ${child}'s round failed: ${errorText(error)}`,
          { to: "debug" },
        ),
      );
    return ending;
  };
  const stopped = () =>
    void endRound(
      "stopped",
      "the person interrupted the turn",
      Date.now() - started,
    );
  if (signal.aborted) {
    stopped();
    return { deny: INTERRUPTED_BEFORE };
  }
  signal.addEventListener("abort", stopped, { once: true });

  const kept: RoundLines = { started: null, answer: null, ended: null };
  let stderr = "";
  let pending = "";
  let exit: { code: number | null; signal: string | null } | null = null;
  try {
    const run = $.process.spawn({
      argv: [node.path, launcher.path, "run"],
      cwd: root,
      // Laid over the session's environment, which cannot be removed from:
      // the launcher builds Pi's from an allowlist, and gets no hook token.
      env: { DEVCORNER_TOKEN: "" },
      input: JSON.stringify(
        launcherSpec(begun, { ask, base, children, now: started }),
      ),
    });
    for (let step = await run.next(); ; step = await run.next()) {
      if (step.done) {
        exit = step.value;
        break;
      }
      if (step.value.stream === "stderr") {
        stderr = (stderr + step.value.text).slice(-4_000);
        continue;
      }
      pending += step.value.text;
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        readRoundLine(kept, pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    }
  } catch (error) {
    stderr += `\n${errorText(error)}`;
  } finally {
    signal.removeEventListener("abort", stopped);
  }
  readRoundLine(kept, pending);

  if (kept.ended === null) {
    await endRound(
      "error",
      "the launcher ended before its round did",
      Date.now() - started,
    );
    const how =
      exit === null
        ? "could not run"
        : `ended (${exit.signal ?? `exit ${exit.code}`})`;
    return {
      deny: `devcorner's local agent ${how} before its round ended: ${stderr.trim().slice(-1_500) || "it said nothing"}`,
    };
  }
  await endRound(kept.ended.outcome, kept.ended.reason, kept.ended.ms);
  return { result: childResultText(child, kept) };
}

export const register: Register = (on) => {
  // The person sees each hand-over of messages as one toast, and the model
  // gets it whole. Between tool calls and on a prompt Claude Code gives a
  // hook's context to the model without drawing it, so it stays there; at a
  // stop it draws it, so the text goes in a row of its own (`handedAtStop`).
  // A stop a hook carried on splits a mirrored window chat's turn at the
  // reply the window ended there (`carryOnAtStop`).
  on("classic.Stop", async ($, e, next) => {
    const ran = await next(e);
    const stop = e as {
      last_assistant_message?: unknown;
      background_tasks?: unknown;
    };
    // A background command killed with no word to the main loop (from
    // Claude Code's tasks dialog) leaves the list here, so the turn's end
    // tells the page.
    for (const id of endedAtStop(runningWork.keys(), stop.background_tasks))
      runningWork.delete(id);
    carryOnAtStop(ran, stop.last_assistant_message);
    return handedAtStop($, ran);
  });
  on("classic.SubagentStop", async ($, e, next) =>
    handedAtStop($, await next(e), e.agent_id),
  );
  // An API failure ended the window's turn (a usage limit, an overload, a
  // sign-in that failed): its kind is kept for the turn under way, whose
  // `turn.complete` tells the chat (`failureOf`). A subagent's is not the
  // chat's.
  on("classic.StopFailure", async ($, e, next) => {
    const failure = e as { error?: unknown; agent_id?: unknown };
    const turn = mirror?.turn ?? null;
    if (turn !== null && failure.agent_id === undefined) {
      failedTurn = {
        turn,
        words: failureWords(
          $,
          typeof failure.error === "string" ? failure.error : "unknown",
        ),
      };
      failureArrived?.();
    }
    return next(e);
  });
  // What holds a window chat's turn (see that section): a call of the main
  // loop's is kept as it is about to run, and let go as it ends; a Bash
  // command the page moved names its background task in its result.
  on("classic.PreToolUse", async ($, e, next) => {
    const ran = await next(e);
    // Its input names no agent: a call of the main loop's is one its
    // mirrored stream made (`mainCalls`).
    if (
      e.tool_use_id !== undefined &&
      mainCalls.has(e.tool_use_id) &&
      ran.deny === undefined
    ) {
      const args = callArguments(e);
      beginHold($, e.tool_use_id, e.tool, args);
      // A subagent is listed from its start, told to the page at once.
      const agent = agentOf(e.tool, e.tool_use_id, args);
      if (agent !== null) {
        runningWork.set(agent.id, agent);
        agentCalls.add(agent.id);
        mirrorSoon($);
      }
    }
    return ran;
  });
  on("classic.PostToolUse", async ($, e, next) => {
    if (e.agent_id === undefined) {
      // What the call printed, kept before the turn that follows tells the page.
      keepOutput($, e, false);
      keepMoved(e.tool_response);
      // A subagent's call has ended: one run in the foreground ended with
      // it, and one launched in the background goes on by its agent's id.
      if (agentCalls.delete(e.tool_use_id)) runningWork.delete(e.tool_use_id);
      const running =
        runningOf(e.tool_name, e.tool_input, e.tool_response) ??
        launchedOf(e.tool_name, e.tool_input, e.tool_response);
      if (running !== null) runningWork.set(running.id, running);
      const ended = endedBy(e.tool_name, e.tool_input, e.tool_response);
      if (ended !== null) runningWork.delete(ended);
      endHold($, e.tool_use_id);
    }
    return toastHandOvers($, await next(e));
  });
  on("classic.PostToolUseFailure", async ($, e, next) => {
    if (e.agent_id === undefined) {
      // A call that failed came back with what it refused with.
      keepOutput($, e, true);
      if (agentCalls.delete(e.tool_use_id)) runningWork.delete(e.tool_use_id);
      endHold($, e.tool_use_id);
    }
    return next(e);
  });
  on("classic.UserPromptSubmit", async ($, e, next) =>
    toastHandOvers($, await next(e)),
  );
  // A window that mirrors a window chat is told again where its replies are
  // read after each compaction, which Claude Code follows with a
  // SessionStart of source `compact`, after what the hook script gives. A
  // start or a resume mirrors nothing until its rejoin is answered, which
  // tells it then (`mirrorOpened`).
  on("classic.SessionStart", async ($, e, next) => {
    const ran = await next(e);
    if (e.source !== "compact" || mirror === null) return ran;
    return {
      ...ran,
      additionalContext: [
        ...(ran.additionalContext ?? []),
        LAPTOP_CHAT_INSTRUCTION,
      ],
    };
  });

  // The engine raises this when a window moves a whole point, after a turn.
  on("session.measure", async ($, e, next) => {
    if (e.changed.includes("rateLimits")) void reportCapacity($, e.rateLimits);
    return next(e);
  });

  // A cloud session's reading rides on a devcorner call the agent makes
  // anyway, with no step of the agent's (dc-t221): a Bash step to carry it
  // out reads as exfiltration to the cloud's permission check, which refused
  // every one (dc-c383).
  on("tool.call", { tool: CARRIER }, async ($, e, next) => {
    const carried = await carriedCapacity($, e as CarrierCall);
    if (!carried) return next(e);
    const { reading, before } = carried;
    const ran = await next({ ...e, capacity: reading });
    if (ran.deny === undefined && ran.isError !== true) return ran;
    // A failed call may not have kept it: the next one carries it.
    if (capacityCarried === reading) capacityCarried = before;
    if (ran.deny === undefined) return ran;
    // Refused with it: the agent's call goes as it made it, and no later
    // call carries one.
    capacityRefused = true;
    return next(e);
  });

  // devcorner's subagent tool, answered on this laptop and never passed on
  // to devcorner's server, which only refuses it. A failure is the call's
  // error, in its own words.
  on("tool.call", { tool: SUBAGENT_CALL }, async ($, e, next) => {
    try {
      return await answerSubagent(
        $,
        e as { tool: string } & Record<string, unknown>,
        next.signal,
      );
    } catch (error) {
      return {
        deny: `devcorner's plugin could not run the subagent: ${errorText(error)}`,
      };
    }
  });

  on("session.start", async ($, e, next) => {
    try {
      const saved = await $.store.get("dismissed");
      await update($, dismissed, () =>
        Array.isArray(saved) ? (saved as string[]) : [],
      );
      await $.command.register({
        name: "dc",
        description:
          "devcorner: the project's picture (/dc), what this session is on and did lately (/dc now), what waits on you by work stream (/dc waits), your live sessions in every project (/dc sessions), sign this machine in or out (/dc login, /dc logout), rename this machine (/dc machine MacBook Air 1), name this conversation (/dc name reviewer), mirror this window as a window chat you can drive from devcorner (/dc chat [title], /dc chat off, /dc continue me-k3), keep this machine reachable from devcorner's page with every window closed (/dc launcher on, /dc launcher off), send your words to another conversation of yours (/dc send me-h3 text), have another session of yours do something and answer here (/dc ask me-s4 run the tests), copy a paste an agent wrote for you (/dc paste) or list them (/dc pastes), install devcorner's local agent, which runs devcorner's subagents on this laptop (/dc local-agent install), set up a repo devcorner does not know (/dc setup) or hide that offer (/dc hide), or ask it something (/dc board)",
        argumentHint:
          "[now | waits | sessions | login | logout | machine [<name>] | name [<name>] | chat [<title> | off] | continue <chat> [--takeover] | launcher [on | off] | send <to> <text> | ask <to> <task> | paste [<id>] | pastes | local-agent install | setup | hide | what to ask]",
      });
    } catch {
      /* stay silent */
    }
    // The hooks' copy of the machine's token is made what the store says.
    await syncHandOver($).catch(() => {});
    // Local children's leftovers: a Pi a killed launcher left, and files
    // past their 24 hours.
    void sweepAtStart($).catch((error: unknown) =>
      $.ui.log(
        `devcorner could not clean its local children's folder: ${errorText(error)}`,
        { to: "debug" },
      ),
    );
    // With no token, delivery is off: said, and offered once (dc-t576).
    void offerDelivery($);
    forgetSession();
    // A start, a reload's among them, says this plugin's version again.
    pluginTaken = null;
    void sweepReloadKept($);
    // A session's first reading is due, whatever an earlier one wrote.
    capacityCarried = null;
    capacityRefused = false;
    // Where nothing draws the session (a plain -p run, which may resume a
    // conversation that kept a marker), the marker says unknown before any
    // hook can read it, not once a read comes back.
    if (!(await draws($).catch(() => true))) {
      await markWaiting($, null, ++learnt);
    }
    // This copy is the window's newest: a copy a reload replaced finds it
    // named here and stops its timers (`superseded`).
    await update($, generation, () => GENERATION).catch(() => {});
    // A session that mirrored a window chat before a restart or a resume
    // rejoins it, and so does this window under a new conversation, by the
    // chat the row kept; until then the row names none, as a reload left
    // the module mirroring nothing whatever the row kept, or by the chat
    // an earlier start's rejoin did not settle (`rejoining`).
    const kept =
      mirror === null
        ? (endedMirror ??
          (await read($, laptop).catch(() => null))?.thread ??
          (await read($, rejoining).catch(() => null)) ??
          null)
        : null;
    endedMirror = null;
    if (mirror === null) await update($, laptop, () => null).catch(() => {});
    void rejoinMirror($, ++sessionLife, kept).catch(() => {});
    // Where this window's repo is on the machine, for a launcher here.
    void noteFolder($).catch(() => {});
    // The status that refresh reads is the first ask, so it is read once.
    // A reload mid-turn keeps the hooks' marker fresh, as the turn's start did.
    void refresh($, true).then(async (got) => {
      if ((await read($, turn).catch(() => null)) !== null) void keepFresh($);
      return startAsking($, got);
    });
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    stopAsking();
    stopFresh();
    forgetSession();
    // The chat waits for this session's return, or another window's
    // /dc continue; devcorner calls the window gone after two minutes. A
    // new conversation in this window (a /clear) rejoins it by itself.
    sessionLife++;
    endedMirror = mirror?.thread ?? null;
    stopMirror($, null);
    exchanges.length = 0;
    // The task list was this session's: the next one keeps its own.
    windowTasks.clear();
    return next(e);
  });

  // What the engine says of each prompt as it is submitted: where it came
  // from, its slash command, whether the person saw it typed. The turn it
  // begins reads it (`turnWords`), so a window chat keeps a prompt the
  // harness made as a short line, never as the person's words. Only seen,
  // never changed.
  on("prompt.submit", async ($, e, next) => {
    // The images pasted with it are read now, since the engine gives their
    // bytes only while the prompt is submitted, with the image files dragged
    // into the window, which come as their paths in the words; only for the
    // person's own words, typed here (`typedHere`), and only while this
    // window mirrors a window chat, the one place they go: its turn sends
    // them with those words (`begin.images`).
    const images: WindowImage[] = [];
    if (mirror !== null && typedHere(e)) {
      images.push(
        ...(await pastedImages(e.attachments, (id, offset) =>
          $.prompt.media(offset === undefined ? { id } : { id, offset }),
        )),
      );
      // A file the engine attached already, and still named, goes once; no
      // more are read than are left to send.
      const paths = droppedImagePaths(e.text)
        .filter((path) => !images.some((one) => path.endsWith(`/${one.name}`)))
        .slice(0, Math.max(0, MAX_PASTED_IMAGES - images.length));
      images.push(
        ...(await droppedImages(paths, (path) =>
          $.fs.read(path, { as: "bytes" }),
        )),
      );
    }
    // A command from the page that submits a prompt (a skill, a plugin's
    // command, an MCP prompt) begins its turn with it: that turn is the
    // page's line, and this prompt is the one it was submitted as.
    if (
      commandFromPage !== null &&
      e.origin?.kind === "plugin" &&
      e.command?.name === commandFromPage.name
    ) {
      commandFromPage.typed.prompt = e.text;
      commandFromPage.typed.since = await $.clock.now();
      typedFromPage = commandFromPage.typed;
    }
    // A background command's notification says it runs no more, whether it
    // joins a turn under way or begins one; the window's next post tells
    // the page.
    if (e.origin?.kind === "task-notification")
      for (const id of endedTasks(e.text)) runningWork.delete(id);
    noteSubmitted(submitted, {
      text: e.text,
      origin: e.origin ?? null,
      command: e.command ?? null,
      meta: e.isMeta === true,
      at: await $.clock.now(),
      images: withinPost(images),
    });
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    // A subagent's turn is not the conversation's: its prompt is the Agent
    // call's, and its run is a part of the turn under way.
    if (e.agentId !== undefined) return next(e);
    stopAsking();
    // A turn begins the holds again: its session may be tied to a live one,
    // and its start is a fresh attempt after a window chat's hold failed or
    // answered at once in a row. Only that backoff: a held request left to
    // rest after it answered at once is not reopened by a turn's end.
    sessionAside = null;
    if (mirror !== null) {
      holdFailures = 0;
      holdAfter = 0;
    }
    // A wake's turn has begun: its prompt hook hands over what waits.
    wokeAt = null;
    const woke = wakeBy(wakingFor);
    wakingFor = null;
    try {
      await update($, turn, () => e.turnId);
    } catch {
      /* stay silent */
    }
    void keepFresh($);
    // This window's conversation, kept for an opening; and its window chat's
    // turn, begun there at once with its words. A wake's prompt is the
    // plugin's, never the person's words, so an opening's history leaves it
    // out and the chat keeps it as devcorner's line; a prompt the harness or
    // another plugin made (a background task's end, a reminder, another
    // session's message) is left out too, and the chat keeps its short line.
    // Only the turn the page's words were submitted as takes them: a turn
    // that began first, a wake's or the person's own, leaves them waiting for
    // their own, since a page's bubble under another turn's reply, and the
    // same words typed again later, is what this window must never draw.
    const page = takesTyped(typedFromPage, e.text) ? typedFromPage : null;
    if (page !== null) typedFromPage = null;
    if (page !== null) heldUntil(page.keys, await $.clock.now());
    // A background command's end begins a turn with its notification: it
    // runs no more, which this turn's beginning tells the page.
    for (const id of endedTasks(e.text)) runningWork.delete(id);
    // The note of a move to the background, submitted alone, is the page's
    // doing, kept as the harness's line, never as the person's words.
    const carried = carryingOn;
    carryingOn = false;
    const typed = page === null && woke === null;
    const seen = typed ? seenFor(submitted, e.text, await $.clock.now()) : null;
    const words: TurnWords | null = !typed
      ? null
      : carried
        ? { from: "harness", text: BACKGROUND_LINE }
        : turnWords(e.text, seen);
    const from = page !== null ? "page" : woke !== null ? "wake" : words!.from;
    // Who started it, for devcorner's count of a chain of wakes (dc-t312):
    // words typed on the page are the person's too.
    void postTurn(
      $,
      e.turnId,
      woke ?? { by: from === "harness" ? "harness" : "person" },
    );
    // A command from the page begins its turn with the command's own prompt:
    // the person said the line it was typed as.
    const said = words?.text ?? page?.text ?? e.text;
    if (from === "window" || from === "page")
      keepExchange(exchanges, "person", said);
    // A turn the person began lets go of the page's words a stop held.
    if (from === "window") {
      pageHeld = null;
      stoppedInWindow = null;
    }
    if (mirror !== null) {
      // A turn begun for asks ends first; what still waits is asked again in
      // this one.
      endAskTurn($);
      mirror.turn = e.turnId;
      mirror.part = 0;
      mirror.parts = [];
      // Words waiting already came before this turn's reply, not during it.
      waitedAtStart = new Set(pageWords.map((w) => w.key));
      beginPart($, mirror, e.turnId, {
        text: said,
        from,
        took: page?.keys ?? [],
        // Only the person's own words typed here carry what they pasted.
        images: from === "window" ? (seen?.images ?? []) : [],
      });
      reopenAsks($);
      mirrorBeat($);
    }
    return next(e);
  });

  // The model's reply as it streams, for this window's window chat: each
  // chunk passes on as it came, and its parts are posted in batches. A
  // subagent's steps are not the chat's.
  on("turn.step", async function* ($, e, next) {
    const mirrored = () =>
      mirror?.turn === e.turnId && e.agentId === undefined ? mirror : null;
    // A subagent may run at an effort of its own; the window's is the main loop's.
    if (e.agentId === undefined)
      windowEffort = typeof e.effort === "string" ? e.effort : null;
    // An agent going on, the main loop or a subagent, means any dialog it
    // waited on was answered; and after a stop a stop hook carried on, that
    // the next part begins.
    if (mirror !== null) closeLooseAsks($, e.agentId ?? null);
    // The main loop going on means its calls before ended: none holds it,
    // and a subagent call of them that never came back (its permission
    // denied) runs no more.
    if (e.agentId === undefined) {
      endHolds($);
      endAgentCalls();
    }
    const going = mirrored();
    if (going !== null) nextPart($, going);
    for await (const chunk of next(e)) {
      const m = mirrored();
      if (m !== null) mirrorChunk($, m, chunk);
      yield chunk;
    }
    // A response that ended with no stop of its own leaves nothing open for
    // the next one to run into.
    const m = mirrored();
    if (m !== null)
      mirrorChunk($, m, { kind: "stop", stopReason: null, usage: null });
  });

  on("turn.complete", async ($, e, next) => {
    // A subagent's turn is not the conversation's: its end only refreshes
    // the row, at most every 30 s, and closes what it still asked, on the
    // page too.
    if (e.agentId !== undefined) {
      for (const [id, one] of [...asks])
        if (one.agent === e.agentId) closeAsk($, id, "expired");
      void refresh($);
      return next(e);
    }
    stopFresh();
    // A subagent call still listed by its own id never came back (the turn
    // was stopped): it runs no more.
    endAgentCalls();
    // Until its end is posted, this event alone types the page's words
    // (`endingTurn`).
    if (mirror?.turn === e.turnId) endingTurn = e.turnId;
    try {
      await update($, turn, () => null);
    } catch {
      /* stay silent */
    }
    try {
      // The reply, kept for an opening and, for this window's window chat,
      // posted as the turn's end; then the oldest of the page's messages that
      // waited for it is typed in, unless the person stopped it in the window,
      // which holds them as they are. A Stop from the page holds none here:
      // devcorner holds those that waited and hands the window none of them
      // until the person says more or sends them now. A move to the background
      // from the page holds none either: it ended the turn so they could go
      // in, after its note.
      const answer = e.answer;
      keepExchange(exchanges, "window", answer);
      // A turn an API failure ended is told as failed, with its line after
      // what it had said; one the person stopped stays stopped.
      const failed = e.reason === "error" && e.isAborted !== true;
      const failure =
        failed && mirror?.turn === e.turnId
          ? await failureOf($, e.turnId)
          : null;
      if (mirror !== null && mirror.turn === e.turnId) {
        // The part under way ends with the turn.
        const ended = mirror.key;
        const moved =
          backgroundedFromPage === e.turnId && e.isAborted === true
            ? movedFromPage
            : null;
        if (
          e.isAborted === true &&
          stoppedFromPage !== e.turnId &&
          backgroundedFromPage !== e.turnId
        ) {
          pageHeld = new Set(pageWords.map((w) => w.key));
          stoppedInWindow = ended;
        }
        stoppedFromPage = null;
        backgroundedFromPage = null;
        if (moved === null) movedFromPage = null;
        endHolds($);
        // What it asked and nobody answered closes with it, on the page too.
        expireAsks($, e.isAborted === true);
        // What a response cut short left open is closed.
        mirrorChunk($, mirror, { kind: "stop", stopReason: null, usage: null });
        mirror.beat?.cancel();
        // The page's words that wait as this reply ends, and those its end
        // post's answer names, were sent before it: they are typed in marked
        // so (`sentBefore`).
        markDuring(
          pageWords.map((w) => w.key),
          answer,
        );
        // The turn is over here before its end is posted: a turn that begins
        // while the post waits is the next one's, never this one's.
        const posting = mirrorPost($, {
          turn: ended,
          end:
            failure !== null
              ? {
                  text:
                    answer.trim() === ""
                      ? failure
                      : `${answer.trimEnd()}\n\n${failure}`,
                  outcome: "failed",
                }
              : moved !== null
                ? { text: withMovedLine(answer, moved.labels), outcome: "done" }
                : {
                    text: answer,
                    outcome: e.isAborted === true ? "stopped" : "done",
                  },
        });
        mirror.turn = null;
        mirror.key = null;
        mirror.next = null;
        // A subagent's ask still waiting in the window (a background agent's)
        // is asked again in a turn begun for it.
        if (
          [...asks.values()].some((one) => !one.taken) &&
          (await beginAskTurn($))
        )
          reopenAsks($);
        await posting;
        // Its end and every join before it posted, devcorner names no word
        // the window joined as waiting. A word typed in whose own turn has not
        // begun is still that turn's to take, so it stays left out; past its
        // hold's bound (`typedHolding`) it is as any word whose turn never
        // began, and goes with the later words.
        if (mirror?.unsent.length === 0) {
          const pending = new Set(
            typedHolding(await $.clock.now()) ? typedFromPage!.keys : [],
          );
          for (const key of [...handedFromPage])
            if (!pending.has(key)) handedFromPage.delete(key);
        }
      }
    } finally {
      // A later turn's end, begun while this one's post waited, holds on.
      if (endingTurn === e.turnId) {
        endingTurn = null;
        void typePageWords($);
      }
    }
    // The idle asking reads Status first, which keeps the row and the marker
    // as the turn ends; where nothing draws the session the row is not drawn
    // and no marker is kept.
    void startAsking($);
    return next(e);
  });

  // Asks in a window chat (see "Asks in a window chat" above). Each tool
  // call is kept while it runs and the window mirrors a chat, a background
  // agent's between turns too, so a permission ask is told by its call, and
  // closes as the call ends: answered in the window, unless the page's
  // answer closed it first, or with no answer when the call failed.
  on("tool.call", async ($, e, next) => {
    if (
      mirror === null ||
      e.tool_use_id === undefined ||
      WINDOW_ONLY_TOOLS.has(e.tool)
    )
      return next(e);
    const call = {
      id: e.tool_use_id,
      tool: e.tool,
      agent: e.agentId ?? null,
      input: e,
      asked: false,
    };
    callsUnderWay.push(call);
    try {
      const ran = await next(e);
      // The call ran or was refused as whoever answered first said: the
      // page, when its answer is what came of it, else the window.
      const allowed = ran.deny === undefined && ran.isError !== true;
      const page = pageAllowed.get(call.id);
      pageAllowed.delete(call.id);
      closeAsk($, call.id, {
        by: page === allowed ? "page" : "window",
        said: allowed ? "Allowed" : page === false ? "Denied" : "",
      });
      // The page's words that wait reach the turn here, at its next step.
      return await joinPageWords($, e.agentId, ran);
    } finally {
      const at = callsUnderWay.indexOf(call);
      if (at !== -1) callsUnderWay.splice(at, 1);
      pageAllowed.delete(call.id);
      closeAsk($, call.id, "expired");
    }
  });

  // The dialog of a tool's permission, while the window mirrors a chat:
  // shown on the page as well, by the tool's name and label, after any
  // settings hook had its say, in the mirrored turn, or in one begun for it
  // when none is (`beginAskTurn`). Claude Code runs this hook beside its
  // dialog, so the person may answer either; the page's answer is this
  // hook's. It waits for it inside `$` calls (`holdForPage`), so its own
  // time stays short of its budget however long the dialog waits; only where
  // holds fail does it wait on the clock, and then the page answers within
  // that budget. A background agent's dialog in a window waits on this hook
  // instead, so there a subagent's ask is the window's alone and the hook
  // returns as it opens it; a background session has no window to keep
  // blank, so there the ask waits for the page as the main loop's does.
  on("classic.PermissionRequest", async ($, e, next) => {
    if (mirror === null || WINDOW_ONLY_TOOLS.has(e.tool_name)) return next(e);
    // The session this window runs, read before anything waits: an ask
    // opened here belongs to it, whatever chat the mirror moves to.
    const background = mirror.background;
    const settled = await next(e);
    if (settled.decision !== undefined) return settled;
    // Its call: of the same tool and agent, with the same input, or the one
    // such call when a hook beneath rewrote the input it asks for.
    const agent = e.agent_id ?? null;
    // The main loop asks only in a turn of its own, which a window that
    // began mirroring mid-turn does not mirror: such an ask stays here.
    if (agent !== null) await beginAskTurn($);
    const input = inputKey(e.tool_input);
    const alike = callsUnderWay.filter(
      (one) => !one.asked && one.tool === e.tool_name && one.agent === agent,
    );
    const call =
      alike.find((one) => inputKey(callArguments(one.input)) === input) ??
      (alike.length === 1 ? alike[0] : undefined);
    if (call !== undefined) call.asked = true;
    const id = call?.id ?? `ask-${++askCount}`;
    const windowOnly = agent !== null && background !== true;
    const page = openAsk(
      $,
      id,
      {
        kind: "permission",
        tool: e.tool_name,
        label: toolLabel(JSON.stringify(e.tool_input ?? null)),
        windowOnly,
      },
      agent,
    );
    if (call === undefined && asks.has(id)) looseAsks.add(id);
    // Its dialog shows once this returns; its call's end, or its agent's
    // next step, closes it on the page as answered in the window.
    if (windowOnly) return settled;
    // An answer another post took settles it at once; the hold's request
    // still out then ends by itself. A subagent's ask waits at most
    // `BACKGROUND_ASK_HOLD_MS`: its dialog is drawn only once this returns.
    const cap =
      agent === null
        ? undefined
        : $.clock.after(BACKGROUND_ASK_HOLD_MS, () => giveAskToWindow($, id));
    await Promise.race([page, holdForPage($, id)]);
    // Holds that fail hand the looking to the clock, so the ask may still
    // wait here: the cap stands until it is answered or closed.
    const answer = await page;
    cap?.cancel();
    if (answer === null) return settled;
    if (!("allow" in answer)) {
      closeAsk($, id, "expired");
      return settled;
    }
    // Claude Code takes the first answer, the dialog's or this one, and
    // says not which: the call's end tells, unless no call was found.
    if (call === undefined)
      closeAsk($, id, {
        by: "page",
        said: answer.allow ? "Allowed" : "Denied",
      });
    else pageAllowed.set(id, answer.allow);
    return {
      ...settled,
      decision: answer.allow
        ? { behavior: "allow" as const }
        : {
            behavior: "deny" as const,
            message: "The person denied it from devcorner's page.",
          },
    };
  });

  // A model switch the page's `/model` makes, after any settings hook had its
  // say: one Claude Code would confirm in the window, its cache still warm,
  // is held back to ask the page first (`switchOnPage`), and goes with no
  // dialog once the page said yes, or at once with nothing cached to lose.
  // Any other switch, the person's own in the window, is left as it was.
  on("classic.PreModelSwitch", async ($, e, next) => {
    const settled = await next(e);
    const running = commandFromPage;
    if (
      mirror === null ||
      running?.name !== "model" ||
      !running.runs ||
      settled.permissionDecision !== undefined
    )
      return settled;
    const switching = running.confirmed ? null : switchToAsk(e);
    if (switching === null)
      return { ...settled, permissionDecision: "allow" as const };
    running.switching = switching;
    return {
      ...settled,
      permissionDecision: "deny" as const,
      permissionDecisionReason:
        "asked on devcorner's page first, as the switch re-reads the whole conversation",
    };
  });

  // The model's questions, while the window mirrors a chat: shown on the
  // page as well, with their options, in the mirrored turn or one begun for
  // them (a background agent's). An answer from the page closes the dialog
  // (the hook answers while it is open); one in the window settles it
  // there.
  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    const questions = askQuestions(e.questions);
    if (mirror === null || e.tool_use_id === undefined || questions === null)
      return next(e);
    if (e.agentId !== undefined) await beginAskTurn($);
    const id = e.tool_use_id;
    const page = openAsk(
      $,
      id,
      { kind: "question", questions },
      e.agentId ?? null,
    );
    void holdForPage($, id);
    const beneath = next(e);
    const first = await Promise.race([
      beneath.then(
        () => null,
        () => null,
      ),
      page,
    ]);
    if (first !== null && "answers" in first) {
      const answers = Object.fromEntries(
        questions.map((q, i) => [
          q.question,
          (first.answers[i] ?? []).join(", "),
        ]),
      );
      closeAsk($, id, { by: "page", said: Object.values(answers).join("; ") });
      return { result: { questions: e.questions, answers } };
    }
    try {
      const ran = await beneath;
      closeAsk($, id, { by: "window", said: answeredWords(ran) });
      return ran;
    } catch (error) {
      closeAsk($, id, "expired");
      throw error;
    }
  });

  // The window's own task list, from the main loop's task calls as they end:
  // kept whether or not a chat is mirrored, so a chat opened later is sent
  // the list as it stands, and sent with the mirrored turn's parts.
  for (const tool of ["TaskCreate", "TaskUpdate", "TodoWrite"])
    on("tool.call", { tool }, async ($, e, next) => {
      const ran = await next(e);
      if (
        e.agentId === undefined &&
        ran.deny === undefined &&
        ran.isError !== true &&
        keepTasks(windowTasks, tool, callArguments(e), ran.text ?? "")
      )
        mirrorTasks($);
      return ran;
    }).catch(($, e, next) => next(e));

  // An agent signs this machine in through its own devcorner connection
  // (connect_plugin, the user's decision dc-c381). The plugin owns the step,
  // so the model reads no file and never chooses the code: it sends this
  // machine's own code, shown above the prompt for the person's yes, in
  // place of none, refuses any other, and once devcorner approved it asks
  // for its token as soon as the interval allows.
  on("tool.call", { tool: SIGNER }, async ($, e, next) => {
    const sent = e as { action?: unknown; device?: unknown };
    if (sent.action !== "connect_plugin") return next(e);
    const own = await agentCode($, sent.device);
    if ("deny" in own) return { deny: own.deny };
    const ran = await next({ ...e, device: own.code.user_code } as typeof e);
    if (ran.deny === undefined && ran.isError !== true && own.flow === flow) {
      const wait = own.code.interval * 1000;
      pollIn($, own.flow, Math.max(0, polledAt + wait - (await $.clock.now())));
    }
    return ran;
  }).catch(($, e, next) =>
    // Any other call goes on as it was; a sign-in the plugin could not
    // check sends no code.
    next.called || (e as { action?: unknown }).action !== "connect_plugin"
      ? next(e)
      : {
          deny: "This machine's devcorner plugin could not get its sign-in code. Nothing was sent to devcorner.",
        },
  );

  // The main conversation's start says the session this window runs as, and
  // its finish ends that (dc-t588); a subagent's never does. What the
  // model reads is left as it was. It names this window as its harness
  // (dc-t610), so devcorner never opens a second conversation for the
  // window's connection, whatever the model passed.
  on("tool.call", { tool: STARTER }, async ($, e, next) => {
    const ran = await next(
      e.agentId === undefined ? await inThisWindow($, e) : e,
    );
    if (
      e.agentId === undefined &&
      ran.deny === undefined &&
      ran.isError !== true
    ) {
      const started = startedSession(ran.text);
      if (started !== null && started !== (await claimOf($))) {
        await keepClaim($, started);
        // The row names the session at once, not at the next read.
        void refresh($, true);
      }
    }
    return ran;
  }).catch(($, e, next) => next(e));
  // A call of the main conversation's that names its session says it too,
  // while the window states none. What the model reads is left as it was.
  on("tool.call", { tool: DEVCORNER_TOOL }, async ($, e, next) => {
    const ran = await next(e);
    void claimFromCall($, e as Parameters<typeof claimFromCall>[1], ran);
    return ran;
  }).catch(($, e, next) => next(e));
  on("tool.call", { tool: FINISHER }, async ($, e, next) => {
    const ran = await next(e);
    if (
      e.agentId === undefined &&
      ran.deny === undefined &&
      ran.isError !== true
    ) {
      await finishedHere($, (e as { session?: unknown }).session);
    }
    return ran;
  }).catch(($, e, next) => next(e));
  // A devcorner call of the main conversation's that names no session goes
  // as the one this window states it runs as and devcorner took, so a window
  // that reconnects (a plugin reload) still acts as its session though its
  // new connection holds none. Only a tool that takes a session is given
  // one, and a start, a call that names a session, a subagent's call and a
  // window whose session devcorner has not taken go as they were made.
  on("tool.call", { tool: DEVCORNER_TOOL }, async ($, e, next) =>
    next(await withWindowSession($, e)),
  ).catch(($, e, next) => next(e));

  // The session wrote a paste for its person (dc-t490): the transcript says so
  // in one line the model never reads, and /dc paste copies it.
  on("tool.call", { tool: PASTER }, async ($, e, next) => {
    const ran = await next(e);
    const written =
      ran.deny === undefined && ran.isError !== true
        ? pasteWritten(ran.text)
        : null;
    if (written !== null) void notePaste($, written);
    return ran;
  }).catch(($, e, next) =>
    // The call goes on as the agent made it, and one already made is never
    // made again: `next` replays what it settled to.
    next(e),
  );

  // Earlier work before research: a web search or fetch runs at once, beside
  // devcorner's Recall, and its result carries the line when the answer came
  // by the time the tool was done, or within RECALL_AFTER_MS of it.
  // Neither handler has a fallback that calls `next` again: the lookups are
  // total (they fail open to no line), so there is nothing to recover from,
  // and a tool is never run a second time.
  on("tool.call", { tool: RECALL_WEB }, async ($, e, next) => {
    const window = e.agentId ?? "";
    const session = sessionNo;
    const asked = recallFor($, e);
    const ran = await next(e);
    const recalled = await answerOf(
      $,
      asked,
      RECALL_AFTER_MS,
      keepLate(window, session),
    );
    return deliver($, ran, window, recalled);
  });
  // A subagent's spawn waits up to RECALL_WAIT_MS for the line, which ends
  // its prompt, so the subagent reads it before it begins. Nothing is marked
  // seen for the spawning window or the subagent: the subagent may be pointed
  // to an item once more by its own first search, which costs a repeat, never
  // a line lost. A line that came after the wait is dropped. A late web line
  // waiting for the spawning window rides on the spawn's result.
  on("tool.call", { tool: "Agent" }, async ($, e, next) => {
    const window = e.agentId ?? "";
    const recalled = await answerOf($, recallFor($, e), RECALL_WAIT_MS);
    const ran =
      recalled === null || typeof e.prompt !== "string"
        ? await next(e)
        : await next({ ...e, prompt: `${e.prompt}\n\n${recalled.line}` });
    return deliver($, ran, window, null);
  });

  // Claude Code's own memory: a read, grep or glob of its auto-memory folder
  // runs at once beside devcorner's Memory, and its result carries
  // devcorner's memories when the answer came by the tool's end or within
  // RECALL_AFTER_MS of it; a write or an edit there carries the module's
  // line that it stays on this machine, asking nothing. A late answer is
  // dropped: nothing marked it seen, so the window's next read is given it.
  // Any other call of these tools, nearly all of them, goes on at once,
  // asking nothing. As for the web tools, the lookup is total, so there is
  // no fallback that calls the tool again.
  on("tool.call", { tool: AUTO_MEMORY_TOOL }, async ($, e, next) => {
    const lookup = autoMemoryLookup(
      e as Parameters<typeof autoMemoryLookup>[0],
    );
    if (lookup === null) return next(e);
    const window = e.agentId ?? "";
    if (lookup === "write") {
      const ran = await next(e);
      return deliver($, ran, window, { line: LOCAL_MEMORY_LINE, items: [] });
    }
    const asked = memoryFor($, e);
    const ran = await next(e);
    const answered = await answerOf($, asked, RECALL_AFTER_MS);
    return deliver(
      $,
      ran,
      window,
      ran.deny === undefined ? carryMemory(answered) : null,
    );
  });

  on("command.run", { command: "dc" }, async ($, e) => {
    const arg = e.args.trim();
    // Each word is whole and exact (dc-t225); any other words ask.
    if (arg === "login") return { text: await startSignIn($) };
    if (arg === "logout") return { text: await signOut($) };
    // Your own words to another conversation of yours (dc-t312).
    if (/^send(?:\s|$)/.test(arg)) {
      return { text: await sendAsYou($, arg.slice("send".length)) };
    }
    // Your own ask of another session of yours, answered here (dc-t611).
    if (/^ask(?:\s|$)/.test(arg)) {
      return { text: await askAsYou($, arg.slice("ask".length)) };
    }
    // A noisy sender turned down for this conversation, or lifted.
    const turning = /^(mute|quiet|unmute)(?:\s|$)/.exec(arg);
    if (turning !== null) {
      const change = turning[1] as "mute" | "quiet" | "unmute";
      return { text: await muteHere($, change, arg.slice(change.length)) };
    }
    if (arg === "mutes") return { text: await muteHere($, "mutes", "") };
    // This window as a window chat in devcorner, or off.
    if (/^chat(?:\s|$)/.test(arg)) {
      return { text: await chatHere($, arg.slice("chat".length)) };
    }
    if (/^continue(?:\s|$)/.test(arg)) {
      return { text: await continueHere($, arg.slice("continue".length)) };
    }
    // The background launcher, which keeps this machine reachable from
    // devcorner's page with every window closed.
    if (/^launcher(?:\s|$)/.test(arg)) {
      return { text: await launcherHere($, arg.slice("launcher".length)) };
    }
    // This conversation's name, or none (dc-t312, part 5).
    if (/^name(?:\s|$)/.test(arg)) {
      return { text: await nameHere($, arg.slice("name".length)) };
    }
    // This machine's name, or a new one (dc-t590).
    if (/^machine(?:\s|$)/.test(arg)) {
      return { text: await machineHere($, arg.slice("machine".length)) };
    }
    // What this conversation's session is on and did lately (dc-t489).
    if (arg === "now") {
      const got = await refresh($, true, { now: true });
      if ((await read($, updating)) !== null) {
        return { text: got?.problem ?? UPDATING_LINE };
      }
      const s = got?.status;
      return {
        text: s ? nowText(s) : (got?.problem ?? NO_STATUS_LINE),
      };
    }
    // What waits on you by work stream, every stream with its things
    // (dc-t492).
    if (arg === "waits") {
      const got = await refresh($, true, { picture: true });
      if ((await read($, updating)) !== null) {
        return { text: got?.problem ?? UPDATING_LINE };
      }
      const s = got?.status;
      return {
        text: s
          ? waitsText(s, await $.clock.now().catch(() => undefined))
          : (got?.problem ?? NO_STATUS_LINE),
      };
    }
    // A paste to copy, and the person's pastes (dc-t490).
    if (/^paste(?:\s|$)/.test(arg)) {
      return { text: await pasteHere($, arg.slice("paste".length)) };
    }
    if (arg === "pastes") return { text: await listPastes($) };
    // Every live session of the person's, in every project (dc-t491).
    if (arg === "sessions") {
      const got = await refresh($, true, { others: true });
      if ((await read($, updating)) !== null) {
        return { text: got?.problem ?? UPDATING_LINE };
      }
      const s = got?.status;
      return {
        text: s ? sessionsText(s) : (got?.problem ?? NO_STATUS_LINE),
      };
    }
    // A repo devcorner does not know: set it up, or hide the row's offer
    // (dc-t533, in place of the row's buttons).
    // Local subagents on this machine: the person's yes and the install.
    if (arg === "local-agent install") return { text: await localAgentHere($) };
    if (arg === "setup") return { text: await setUpHere($) };
    if (arg === "hide") return { text: await hideNudge($) };
    if (arg) {
      askDevcorner($, `devcorner: ${arg}`);
      return { text: `Asking devcorner: ${arg}` };
    }
    // The project's picture, whatever the row shows: Claude Code's [-] may
    // hide the row, and a plugin cannot tell (dc-t218).
    const got = await refresh($, true, { picture: true });
    if ((await read($, updating)) !== null) {
      return { text: got?.problem ?? UPDATING_LINE };
    }
    // Its own read's answer, which holds the picture, even when a poll that
    // ran beside it holds the row.
    const s = got?.status ?? (await read($, status));
    if (!s) return { text: got?.problem ?? NO_STATUS_LINE };
    // Which person and which machine this is (dc-t224), when devcorner says.
    const held = await tokenOf($);
    const who = held ? await whoLine($, held) : null;
    const text = dcText(s, await $.clock.now().catch(() => undefined));
    return { text: who ? `${who}\n${text}` : text };
  });

  // Whether the terminal draws links (dc-t577), read once a load: the
  // terminal does not change under a session.
  const linksOnTerminal: LinksRead = {};

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Link, Text } = $.ui.resolve(e);
    // Another surface draws a link as an anchor; a terminal draws it as a
    // link only where Claude Code says it can, and else as its words then
    // its whole address, which would make the row long, so there the row is
    // its words alone (dc-t577).
    const links =
      e.surface !== "terminal" || (await terminalLinks($, linksOnTerminal));
    // The row's words, dim, each part linked to the page devcorner named
    // (dc-t533): links and nothing to press.
    const linked = (segments: Segment[]) =>
      segments.map(({ text, href }, i) =>
        href && links ? (
          <Link key={`link-${i}`} href={href}>
            {text}
          </Link>
        ) : (
          text
        ),
      );
    // For the minute after a deploy devcorner answers that it is updating:
    // the row says so, whatever it showed, until devcorner answers again.
    if ((await read($, updating)) !== null) {
      return (
        <Box>
          <Text color="yellow">● </Text>
          <Text dimColor>{UPDATING_LINE}</Text>
        </Box>
      );
    }
    // Signing in (dc-t224): signed out, the code to enter, or why it ended.
    // /dc login signs in and /dc logout stops a sign-in under way.
    const at = await read($, signIn);
    if (at) {
      if (at.step === "asking") {
        return (
          <Box>
            <Text color="cyan">● </Text>
            <Text dimColor>devcorner · getting a sign-in code…</Text>
          </Box>
        );
      }
      if (at.step === "code") {
        return (
          <Box>
            <Text color="cyan">● </Text>
            <Text dimColor>
              devcorner · Open{" "}
              {links ? (
                <Link href={at.link}>{shownAddress(at.page)}</Link>
              ) : (
                at.link
              )}{" "}
              and enter{" "}
            </Text>
            <Text weight="bold">{at.code}</Text>
          </Box>
        );
      }
      const color =
        at.why === "denied" ? "red" : at.why === "expired" ? "yellow" : "gray";
      return (
        <Box>
          <Text color={color}>● </Text>
          <Text dimColor>{signedOutText(at)}</Text>
        </Box>
      );
    }

    const s = await read($, status);
    if (!s) return next(e);

    // A repo devcorner does not know: /dc setup sets it up, and /dc hide
    // stops this, remembered for the repo.
    if (!s.known) {
      if ((await read($, dismissed)).includes(s.repo)) return next(e);
      return (
        <Box>
          <Text color="cyan">● </Text>
          <Text dimColor>{linked(nudgeSegments(s))}</Text>
        </Box>
      );
    }

    // devcorner's own line, so there is no ⚠ and no mod name in front of
    // it: one line of links that fits the cells Claude Code lays it out in
    // (dc-t533). Claude Code's [-] hides the whole row and tells the plugin
    // nothing; /dc says the project's picture whatever the row shows.
    return (
      <Box>
        <Text color="cyan">● </Text>
        <Text dimColor>
          {linked(rowSegments(s, e.props.bodyColumns, await read($, laptop)))}
        </Text>
      </Box>
    );
  });
};
