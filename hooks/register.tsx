import { atom, read, update } from "claude-code";
import type { Register, EngineInterface as Engine, Timer } from "claude-code";

import type {
  SignIn,
  Status,
  StatusConversation,
  StatusInFlight,
  StatusOvernight,
  StatusPaste,
  StatusOther,
  StatusSession,
  StatusWait,
  StatusWake,
} from "../types";

const status = atom({ plugin: "devcorner", key: "status" } as const, null);
const dismissed = atom({ plugin: "devcorner", key: "dismissed" } as const, []);
const turn = atom({ plugin: "devcorner", key: "turn" } as const, null);
const woke = atom({ plugin: "devcorner", key: "woke" } as const, null);
const cursors = atom({ plugin: "devcorner", key: "cursors" } as const, []);
const updating = atom({ plugin: "devcorner", key: "updating" } as const, null);
const signIn = atom({ plugin: "devcorner", key: "signIn" } as const, null);

const EVERY_MS = 30_000;
const DEFAULT_URL = "https://devcorner.devcorner.workers.dev";

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
 * How long the held request asks devcorner to hold it. Claude Code documents
 * no timeout for $.http.fetch, and devcorner's own 50 s default is longer than
 * the 30 s that $.process.run is given, so the plugin names a shorter hold; the
 * server never holds longer than its own limit.
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
  // nobody's word, so it never says "your".
  if (w.from === "reply") {
    const from = item && CONVERSATION.test(item) ? item : null;
    return `${from ?? "another conversation"} replied`;
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

/** What a wake goes by: the session, else the conversation with no session; null with neither. */
export function wokenOf(s: Status): Woken | null {
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
 * The row above the prompt (dc-t533): one line of links, and nothing to
 * press, "devcorner · s7 reviewer · waiting 2". "devcorner" opens the
 * project's home (else the workspace's place, or Personal's for a repo in
 * none); the short id of the session the conversation works as opens that
 * session's page, the conversation's name after it as its label; and
 * "waiting N" opens the inbox of the repo's place, said only while something
 * waits there, "2+" or "?" with a part of devcorner unread (dc-t137). With no
 * session there is no id and no label. A part devcorner named no page for is
 * plain. Given the cells Claude Code lays the row out in, the label is cut at
 * a word, else left out, so the line never wraps; nothing else is cut.
 */
export function rowSegments(s: Status, columns?: number): Segment[] {
  const head = piece("devcorner", projectHome(s));
  const id = s.session
    ? [piece(" · "), piece(shortSession(s.session.id), s.links?.session)]
    : [];
  const waiting =
    s.waiting > 0 || unreadOf(s).length > 0
      ? [piece(" · "), piece(`waiting ${waitingCount(s)}`, s.links?.inbox)]
      : [];
  const name =
    s.session && s.thisConversation?.name
      ? oneLine(s.thisConversation.name)
      : "";
  const room = sizeOf(columns);
  const fixed = cells(BULLET) + cells(lineText([head, ...id, ...waiting]));
  const label =
    name && room !== undefined
      ? cutAtWord(name, room - fixed - cells(" "))
      : name;
  return [head, ...id, ...(label ? [piece(` ${label}`)] : []), ...waiting];
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
 * with the conversation's name, then the pause of its relays on the person's
 * word when there is one: "devcorner · dc-s7@acme reviewer".
 */
function whoHead(s: Status): string {
  const here = s.thisConversation;
  const id = s.session?.id ?? here?.id ?? null;
  const name = here?.name ? ` ${oneLine(here.name)}` : "";
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

/** What /dc sessions ends with: how to message one of them (dc-t491). */
export const SESSIONS_SEND = "message one: /dc send <id> <text>";

/**
 * What /dc sessions says (dc-t491): this conversation's session, then every
 * other live session of the person's, in every project, one a line under
 * the labels, each with its conversation's name, its repo, how it stands and
 * its ticket, in devcorner's words; then how to message one. Or why
 * devcorner listed none: an older one lists no sessions, and a read that
 * could not list them says so.
 */
export function sessionsText(s: Status): string {
  const hereId = s.session?.id ?? s.thisConversation?.id ?? null;
  const hereName = s.thisConversation?.name
    ? ` ${oneLine(s.thisConversation.name)}`
    : "";
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
  if (items.length === 0) {
    return `${here}\n${labelled("others")}none live, in any project`;
  }
  const width = widest(items.map((o) => o.id));
  const lines = items.map((o, i) => {
    const facts = [
      ...otherFacts(o),
      ...(o.ticket ? [`on ${o.ticket.id}`] : []),
    ].join(" · ");
    const name = o.name ? ` ${oneLine(o.name)}` : "";
    return `${labelled(i === 0 ? "others" : "")}${o.id.padEnd(width)}${name}  ${facts}`;
  });
  const rest =
    total > items.length
      ? [`${labelled("")}and ${total - items.length} more`]
      : [];
  return [here, ...lines, ...rest, SESSIONS_SEND].join("\n");
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
  s: Status,
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
 */
export type Held =
  | { kind: "wake"; session: string; id: string }
  | { kind: "notice"; id: string }
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
    if (typeof o.wake === "string" && typeof o.id === "string") {
      return { kind: "wake", session: o.wake, id: o.id };
    }
    if (typeof o.notice === "string") return { kind: "notice", id: o.notice };
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

let lastAt = 0;

/**
 * What one read of devcorner's Status came to. Each read keeps its own, since
 * reads may run at once (the poll, /dc, a turn's refresh) and one must never
 * take another's answer for its own.
 */
type Read = {
  status?: Status;
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
 * it; undefined on a detached head, or when git cannot say. Read at each
 * Status, since it is what changes.
 */
async function branchIn($: Engine, cwd: string): Promise<string | undefined> {
  const git = await $.process.run(["git", "branch", "--show-current"], {
    cwd,
    timeoutMs: 5000,
  });
  const branch = git.exitCode === 0 ? git.stdout.trim() : "";
  return branch && !/\s/.test(branch) ? branch : undefined;
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
export function pendingOf(s: Status | undefined): number | null {
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
 * Takes the token for the devcorner at `base` back from the command hooks.
 * A file another devcorner's conversation handed them is its own, and stays.
 */
async function takeBack($: Engine, base: string): Promise<void> {
  const file = await tokenFileOf($);
  if (!file || !(await $.fs.exists(file).catch(() => false))) return;
  const there = String(await $.fs.read(file).catch(() => ""));
  if (there.split("\n")[1] !== base) return;
  await $.process.run(["rm", "-f", file], { timeoutMs: 5000 });
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
  if (only !== undefined && (await keptToken($, base)) !== only) return;
  await $.store.delete(tokenKey(base));
  await takeBack($, base);
}

/**
 * At a session's start the hooks' copy is made what the store says for this
 * devcorner: written when the store holds a token, removed when it holds
 * none, so a sign-out in another conversation, or a store cleared by hand,
 * leaves no copy behind. A copy for another devcorner is left alone.
 */
async function syncHandOver($: Engine): Promise<void> {
  const file = await tokenFileOf($);
  if (!file) return;
  const base = await baseOf($);
  const kept = await keptToken($, base);
  const there = (await $.fs.exists(file))
    ? String(await $.fs.read(file))
    : null;
  if (kept) {
    if (there !== handedText(kept, base)) await handOver($, kept, base);
  } else if (there !== null) {
    await takeBack($, base);
  }
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
    $.ui.log(DELIVERY_OFF);
    const base = await baseOf($);
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
   * False for a conversation devcorner opened for an MCP connection or its
   * chat (dc-t312, part 2), which has no hooks: it reads its mail at its next
   * call. Absent for a session, and from an older devcorner.
   */
  wakes?: unknown;
}

/** One target's place in /dc send's answer: "dc-h2 (reviewer): queued, no session yet". */
function sentToText(to: SentTo): string {
  const id = `${String(to.id ?? "")}${typeof to.name === "string" && to.name ? ` (${to.name})` : ""}`;
  if (to.wakes === false) {
    return `${id}: read at its next call; it cannot be woken`;
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
 * message its prompt was submitted for, else the person, by typing or by
 * `/dc <words>`, which are their own words. Only a message id is sent.
 */
export function turnBy(
  wakingFor: string | null,
): { by: "wake"; for: string } | { by: "person" } {
  return wakingFor !== null && MESSAGE.test(wakingFor)
    ? { by: "wake", for: wakingFor }
    : { by: "person" };
}

/**
 * Tells devcorner who started this conversation's turn (dc-t312), the hook
 * route's `Turn`, with this machine's token: a relay its agent sends counts
 * its chain of wakes from it, and a typed turn clears a paused chain, which
 * the row then stops saying. Silent: a machine not signed in, a cloud
 * session or a devcorner that does not answer sends nothing more, and its
 * relays count as from a turn devcorner cannot place.
 */
async function postTurn(
  $: Engine,
  turnId: string,
  by: ReturnType<typeof turnBy>,
): Promise<void> {
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
 * What a Status read asks devcorner for besides the row's own, which it
 * reads only when asked: the repo's picture for /dc and /dc waits (dc-t218,
 * dc-t492), what the conversation's session is on and did lately for /dc
 * now (dc-t489), and the person's other live sessions for /dc sessions
 * (dc-t491).
 */
type Asks = { picture?: boolean; now?: boolean; others?: boolean };

// One call to devcorner, with what it came to; a problem is kept in the
// read, never thrown.
async function fetchStatus($: Engine, asks: Asks): Promise<Read> {
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
        ...failed((await inCloud($)) ? CLOUD_DELIVERY : DELIVERY_OFF),
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
    const branch = await branchIn($, cwd).catch(() => undefined);
    const key = `${sessionId} ${cwd}`;
    const moved =
      !branchSaying &&
      branch !== undefined &&
      (branchTaken?.key !== key || branchTaken.branch !== branch);
    if (moved) branchSaying = saying = true;
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
        ...(asks.picture ? { expanded: true } : {}),
        ...(asks.now ? { now: true } : {}),
        ...(asks.others ? { others: true } : {}),
      }),
    });
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
    if (!isStatus(body)) {
      return failed(
        `devcorner at ${base} gave an answer this plugin does not understand; it may be older than the plugin.`,
      );
    }
    // Taken once devcorner says it back; until then each Status says it
    // again, as when a store could not take it, or devcorner is older.
    if (moved && body.branch === branch) branchTaken = { key, branch };
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
 * sessions).
 */
async function refresh(
  $: Engine,
  force = false,
  asks: Asks = {},
): Promise<Read | undefined> {
  const now = await $.clock.now().catch(() => undefined);
  if (now === undefined || (!force && now - lastAt < EVERY_MS)) {
    return undefined;
  }
  lastAt = now;
  const seq = ++learnt;
  const got = await fetchStatus($, asks);
  // A read that began before another and ended after it is older news: the
  // row and the marker keep the later one's. Its caller still goes by it.
  if (seq < shown) return got;
  shown = seq;
  try {
    await noteUpdating($, got.retryIn);
    await markWaiting($, pendingOf(got.status), seq);
    const s = got.status;
    if (s) {
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
/** Quick empty answers in a row. */
let quick = 0;
/** The earliest time a held request may be tried again. */
let holdAfter = 0;
/** The earliest time devcorner may be asked again after a failure. */
let askAfter = 0;
/**
 * When the plugin submitted a prompt whose turn has not begun yet, a wake or
 * `/dc`'s ask; null once it has (`WAKE_SETTLE_MS`).
 */
let wokeAt: number | null = null;
/**
 * The message a wake's prompt was submitted for, until its turn begins
 * (dc-t312): that turn is the wake's, and `Turn` says so. Null for any other
 * prompt, the person's own or `/dc <words>`.
 */
let wakingFor: string | null = null;

/** Whether a prompt the plugin submitted lately still waits for its turn to begin (`wokeAt`). */
const settling = (now: number) =>
  wokeAt !== null && now - wokeAt < WAKE_SETTLE_MS;

/** A new or ended session starts clean: nothing of the last one carries over. */
function forgetSession(): void {
  quick = 0;
  holdAfter = 0;
  askAfter = 0;
  failures = 0;
  wokeAt = null;
  wakingFor = null;
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
      const began = await $.clock.now();
      const held = await waitOnce($);
      if (mine !== epoch) return;
      const now = await $.clock.now();
      // A hold whose epoch ended (a turn started, the session ended, a newer
      // hold) touches nothing: not the times, the timer or the row. So the
      // epoch is checked again after every wait below.
      if (mine !== epoch) return;
      if (held.kind === "empty") {
        quick = now - began < QUICK_MS ? quick + 1 : 0;
        if (quick < QUICK_MAX) continue;
      }
      if (held.kind === "notice") {
        // Mail the conversation is told of without a turn (dc-t312): a fresh
        // Status puts it in the hooks' marker, so the next prompt's hook
        // hands it, and the person is told it waits. Held again at once.
        quick = 0;
        await refresh($, true);
        if (mine !== epoch) return;
        $.ui.toast(noticeToast(held.id));
        continue;
      }
      const wokeFor = held.kind === "wake" ? await read($, woke) : null;
      if (mine !== epoch) return;
      if (held.kind === "wake" && held.id !== wokeFor) {
        quick = 0;
        // A message that wakes the session waits: the prompt's hook asks.
        await markWaiting($, 1, ++learnt);
        if (mine !== epoch) return;
        // The wake itself goes by a fresh Status (dc-t204), which names what
        // came and says whether it is still unread: a hook may have handed
        // it over since. The held request is not opened again here, so a
        // wake submitted but not yet begun is never followed by another.
        holdAfter = now;
        void ask($);
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
        askIn($, held.after);
        return;
      }
      // Failed, or answering at once: the poll has it for a while.
      quick = 0;
      holdAfter = now + WAIT_RETRY_MS;
      if (held.kind === "failed") {
        // A down server is left alone as a failed ask leaves it.
        const wait = backoff(++failures);
        askAfter = now + wait;
        askIn($, wait);
      } else {
        const ms = await pollMs($);
        if (mine !== epoch) return;
        askIn($, ms);
      }
      return;
    }
  } catch {
    /* stay silent */
  }
}

/**
 * Keeps asking: the held request where it may be tried, else the poll in
 * `ms`. Never the held request while a wake's turn has not begun (`wokeAt`,
 * dc-t204): it would hand back at once a message that came meanwhile.
 */
async function carryOn($: Engine, ms: number): Promise<void> {
  const now = await $.clock.now();
  if (!settling(now) && now >= holdAfter) void hold($);
  else askIn($, ms);
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
      await $.prompt.submit({ text, asUser: true });
    } catch (error) {
      wokeAt = null;
      const why = error instanceof Error ? error.message : String(error);
      $.ui.toast(`dc: could not ask devcorner: ${why}`);
    }
  });
}

/** Asks devcorner again in `ms`, in place of any ask already set. */
function askIn($: Engine, ms: number): void {
  timer?.cancel();
  timer = $.clock.after(ms, () => void ask($));
}

function stopAsking(): void {
  epoch++;
  timer?.cancel();
  timer = undefined;
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
      await refresh($, true);
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
      if (wait > 0) askIn($, wait);
      else void ask($, given);
    }
  } catch {
    /* stay silent */
  }
}

async function ask($: Engine, given?: Read): Promise<void> {
  timer = undefined;
  try {
    // A running turn is handed its messages by the hooks; its end asks again.
    // (turn.start cancels the timer; this holds one already firing, or set by
    // a reload mid-turn.)
    if ((await read($, turn)) !== null) return;
    // This ask goes by its own read, never by another that ran beside it.
    const got = given ?? (await refresh($, true));
    const s = got?.status;
    if (!got || !s) {
      const retryIn = got?.retryIn ?? null;
      if (retryIn !== null) {
        // devcorner is updating: asked again when it said, with no failure
        // counted.
        askAfter = (await $.clock.now()) + retryIn;
        askIn($, retryIn);
      } else if (got?.down) {
        const wait = backoff(++failures);
        askAfter = (await $.clock.now()) + wait;
        askIn($, wait);
      }
      return;
    }
    failures = 0;
    askAfter = 0;
    const step = nextStep(s, await read($, woke));
    if (step === null) return;
    if ("after" in step) {
      await carryOn($, step.after);
      return;
    }
    // A wake submitted a moment ago has not begun its turn yet: that turn's
    // prompt hook hands over whatever waits then, this message too, so no
    // second wake goes before it (dc-t204). Asked again in a while, or at
    // the turn's end.
    const now = await $.clock.now();
    if (settling(now)) {
      askIn($, WAITING_MS);
      return;
    }
    // Never over what the person is typing: their own prompt's hook hands
    // the message over, and if they leave the draft, the next ask wakes.
    const draft = await $.prompt.read();
    if (draft.text.trim() === "" && (await read($, turn)) === null) {
      // The session, or the conversation with none (dc-t312): `nextStep`
      // woke for one of them.
      const woken = wokenOf(s)!;
      await update($, woke, () => step.wake);
      await update($, cursors, (kept) => withCursor(kept, step.wake));
      wokeAt = now;
      wakingFor = step.wake;
      $.ui.toast(wakeToast(woken));
      // A wake refused starts no turn: the next turn is not the wake's.
      $.prompt.submit({ text: wakePrompt(woken) }).catch(() => {
        wakingFor = null;
      });
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

export const register: Register = (on) => {
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

  on("session.start", async ($, e, next) => {
    try {
      const saved = await $.store.get("dismissed");
      await update($, dismissed, () =>
        Array.isArray(saved) ? (saved as string[]) : [],
      );
      await $.command.register({
        name: "dc",
        description:
          "devcorner: the project's picture (/dc), what this session is on and did lately (/dc now), what waits on you by work stream (/dc waits), your live sessions in every project (/dc sessions), sign this machine in or out (/dc login, /dc logout), name this conversation (/dc name reviewer), send your words to another conversation of yours (/dc send me-h3 text), copy a paste an agent wrote for you (/dc paste) or list them (/dc pastes), set up a repo devcorner does not know (/dc setup) or hide that offer (/dc hide), or ask it something (/dc board)",
        argumentHint:
          "[now | waits | sessions | login | logout | name [<name>] | send <to> <text> | paste [<id>] | pastes | setup | hide | what to ask]",
      });
    } catch {
      /* stay silent */
    }
    // The hooks' copy of the machine's token is made what the store says.
    await syncHandOver($).catch(() => {});
    // With no token, delivery is off: said, and offered once (dc-t576).
    void offerDelivery($);
    forgetSession();
    // A session's first reading is due, whatever an earlier one wrote.
    capacityCarried = null;
    capacityRefused = false;
    // Where nothing draws the session (a plain -p run, which may resume a
    // conversation that kept a marker), the marker says unknown before any
    // hook can read it, not once a read comes back.
    if (!(await draws($).catch(() => true))) {
      await markWaiting($, null, ++learnt);
    }
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
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    stopAsking();
    // A wake's turn has begun: its prompt hook hands over what waits.
    wokeAt = null;
    // Who started it, for devcorner's count of a chain of wakes (dc-t312).
    const by = turnBy(wakingFor);
    wakingFor = null;
    try {
      await update($, turn, () => e.turnId);
    } catch {
      /* stay silent */
    }
    void postTurn($, e.turnId, by);
    void keepFresh($);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    // A subagent's turn is not the conversation's: it raises no turn.start,
    // and its end only refreshes the row, at most every 30 s.
    if (e.agentId !== undefined) {
      void refresh($);
      return next(e);
    }
    stopFresh();
    try {
      await update($, turn, () => null);
    } catch {
      /* stay silent */
    }
    // The idle asking reads Status first, which keeps the row and the marker
    // as the turn ends; where nothing draws the session the row is not drawn
    // and no marker is kept.
    void startAsking($);
    return next(e);
  });

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

  on("command.run", { command: "dc" }, async ($, e) => {
    const arg = e.args.trim();
    // Each word is whole and exact (dc-t225); any other words ask.
    if (arg === "login") return { text: await startSignIn($) };
    if (arg === "logout") return { text: await signOut($) };
    // Your own words to another conversation of yours (dc-t312).
    if (/^send(?:\s|$)/.test(arg)) {
      return { text: await sendAsYou($, arg.slice("send".length)) };
    }
    // This conversation's name, or none (dc-t312, part 5).
    if (/^name(?:\s|$)/.test(arg)) {
      return { text: await nameHere($, arg.slice("name".length)) };
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
        <Text dimColor>{linked(rowSegments(s, e.props.bodyColumns))}</Text>
      </Box>
    );
  });
};
