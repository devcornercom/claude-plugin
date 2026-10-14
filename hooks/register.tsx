import { atom, read, update } from "claude-code";
import type { Register, EngineInterface as Engine, Timer } from "claude-code";

import type { Status, StatusSession, StatusWake } from "../types";

const status = atom({ plugin: "devcorner", key: "status" } as const, null);
const dismissed = atom({ plugin: "devcorner", key: "dismissed" } as const, []);
const turn = atom({ plugin: "devcorner", key: "turn" } as const, null);
const woke = atom({ plugin: "devcorner", key: "woke" } as const, null);
const updating = atom({ plugin: "devcorner", key: "updating" } as const, null);
const expanded = atom({ plugin: "devcorner", key: "expanded" } as const, false);

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

/** What a run ended as, in the words a wake says it: "run dc-r3 finished". */
const RUN_ENDED: Record<string, string> = {
  done: "finished",
  partial: "finished as partial",
  abandoned: "finished as abandoned",
  expired: "expired",
  lost: "ended without finishing",
  cancelled: "was cancelled",
};

/**
 * What a wake names an item by: a pull request as #210, a devcorner id as it
 * is (dc-r3, dc-q3@acme). Null for anything of another shape, so nothing but
 * an id or a number reaches a wake's words.
 */
function itemName(item: string | null): string | null {
  if (item === null) return null;
  const pull = /^[\w.-]{1,100}\/[\w.-]{1,100}#(\d{1,9})$/.exec(item);
  if (pull) return `#${pull[1]}`;
  return /^dc-[a-z]\d{1,9}(@[a-z0-9-]{1,40})?$/.test(item) ? item : null;
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
    const ended = RUN_ENDED[w.what];
    return item && ended ? `run ${item} ${ended}` : null;
  }
  if (w.from === "github") {
    if (w.what !== "conflict" || !item) return null;
    return `GitHub — ${item} conflicts with ${branchName(w.detail) ?? "its base branch"}`;
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

/** How many messages wake the session: at least the one a wake is for. */
const wakeCount = (session: StatusSession) =>
  Math.max(1, session.wakeMessages ?? 1);

/**
 * What came, for a wake (dc-t204): "GitHub — #210 conflicts with main", or
 * "run dc-r3 finished; your answer to dc-q4; and 1 more" for several. Null
 * from an older devcorner, or when this version can name none of them.
 */
export function wakeLine(
  session: StatusSession,
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
export function wakeToast(session: StatusSession): string {
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
export function wakePrompt(session: StatusSession): string {
  const count = wakeCount(session);
  const line = wakeLine(session, "agent");
  const what = line === null ? "" : `: ${line}`;
  return count === 1
    ? `While this session was idle, a devcorner message woke it${what}. It comes with this prompt as a devcorner message: read it and carry on from it, and if it ends with "…", read it whole with show(its id) first. If it is not there, call check.`
    : `While this session was idle, ${count} devcorner messages woke it${what}. They come with this prompt as devcorner messages: read them and carry on from them, and if one ends with "…", read it whole with show(its id) first. If they are not there, call check.`;
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

/** "git@github.com:acme/shop.git", "https://github.com/acme/shop" -> "acme/shop". */
export function repoOf(remote: string): string | undefined {
  const m = remote.trim().match(/([^/:\s]+)\/([^/:\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** A piece of the row above the prompt: its text, and the page it links to when it has one. */
type Segment = { text: string; href?: string };

/** A piece of the row, linked when devcorner named a page for it. */
const piece = (text: string, href?: string | null): Segment =>
  href ? { text, href } : { text };

/** A line of the open block: its parts in order. */
type Line = Segment[];

/** What waits on the person, linked to the inbox: "2 waiting on you", or that nothing does. */
function waitingPiece(s: Status): Segment {
  return s.waiting > 0
    ? piece(`${s.waiting} waiting on you`, s.links?.inbox)
    : piece("nothing waits on you", s.links?.inbox);
}

/**
 * The repo's night (dc-t213), its id linking its page: "overnight dc-o3:
 * Working (lands)", and what it did with `counts`. Nothing with no night.
 */
function nightPieces(s: Status, counts: boolean): Segment[] {
  if (!s.overnight) return [];
  return [
    piece("overnight "),
    piece(s.overnight.id, s.overnight.page),
    piece(`: ${s.overnight.state}${counts ? `, ${s.overnight.counts}` : ""}`),
  ];
}

/**
 * The row as it is drawn closed, its default (dc-t218): one short line, what
 * waits on the person and the night's word while one is armed or paused,
 * linked to the pages devcorner named in `links`; a part it named none for is
 * plain text.
 */
export function collapsedSegments(s: Status): Segment[] {
  const night = nightPieces(s, false);
  return [
    piece("devcorner · "),
    waitingPiece(s),
    ...(night.length > 0 ? [piece(" · "), ...night] : []),
  ];
}

/** A title cut to a few words for a line of the open block. */
const short = (title: string, max = 40) =>
  title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;

/** "3 sessions", "1 run": a count and its noun. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The row as it is drawn open (dc-t218): its first line where the person is,
 * then three things to open, Project home, Active actions (what waits on
 * them, the same count as the closed row's) and In flight (the work moving
 * now), and then the project's picture: this conversation's session, what
 * waits first, the night, the work in flight, the cloud sessions, Next's first
 * three and the code against the last deploy. Each part links to the page
 * devcorner named; the plugin builds no address. A part an older devcorner,
 * or a read that did not ask for the picture, says nothing of is left out.
 */
export function expandedLines(s: Status): Line[] {
  const links = s.links;
  const more = s.expanded ?? null;
  const head: Line = [
    piece("devcorner · "),
    piece(s.workspace?.name ?? "personal", links?.place),
  ];
  if (s.project) head.push(piece(" · "), piece(s.project.name, links?.project));
  const lines: Line[] = [head];
  lines.push([
    piece("Project home", projectHome(s)),
    piece(" · "),
    piece(`Active actions: ${s.waiting}`, links?.inbox),
    piece(" · "),
    piece(
      more ? `In flight: ${more.inFlight.count}` : "In flight",
      links?.work,
    ),
  ]);
  if (s.session) {
    const line: Line = [
      piece("this conversation: session "),
      piece(s.session.id, links?.session),
    ];
    if (s.session.ticket) {
      line.push(piece(", on ticket "), piece(s.session.ticket, links?.ticket));
    }
    lines.push(line);
  }
  if (s.waiting > 0) {
    const first = more?.firstWaiting;
    lines.push([
      waitingPiece(s),
      ...(first
        ? [
            piece(", first "),
            piece(first.id, first.page),
            piece(` ${short(first.title)}`),
          ]
        : []),
    ]);
  }
  if (s.overnight) lines.push(nightPieces(s, true));
  if (more) {
    const f = more.inFlight;
    const parts = [
      f.sessions > 0 ? count(f.sessions, "live session") : null,
      f.runs > 0 ? count(f.runs, "run") : null,
      f.pulls > 0 ? count(f.pulls, "pull request") : null,
      f.night ? "the night" : null,
    ].filter((part) => part !== null);
    lines.push([
      piece("in flight: "),
      piece(parts.length > 0 ? parts.join(" · ") : "nothing", links?.work),
    ]);
    for (const c of more.cloud) {
      lines.push([
        piece("cloud: "),
        piece(c.id, c.page),
        piece(` ${c.routine}, ${c.held}, ${count(c.workers, "worker")}`),
      ]);
    }
    if (more.next.length > 0) {
      const line: Line = [piece("next: ")];
      more.next.forEach((t, i) => {
        if (i > 0) line.push(piece(" · "));
        line.push(piece(t.id, t.page), piece(` ${short(t.title, 32)}`));
      });
      lines.push(line);
    }
    if (more.code) lines.push([piece(`code: ${more.code}`)]);
  } else if (s.next) {
    lines.push([piece(`next: ${s.next.id} ${short(s.next.title)}`)]);
  }
  return lines;
}

/** A line's words, links or not. */
export const lineText = (line: Line) =>
  line.map((segment) => segment.text).join("");

/** The page Project home opens: the project's place, else the workspace's or Personal's, as devcorner named them. */
const projectHome = (s: Status) => s.links?.project ?? s.links?.place;

/**
 * What /dc says (dc-t218): the open block as text, then the pages its lead
 * items open, since a command's answer draws no links. Also where the
 * picture is when Claude Code's [-] hides the row.
 */
export function dcText(s: Status): string {
  const lines = [
    `repo: ${s.repo}${s.known ? "" : " (new to devcorner)"}`,
    ...expandedLines(s).map(lineText),
  ];
  const pages = [
    projectHome(s) ? `project home: ${projectHome(s)}` : null,
    s.links?.inbox ? `active actions: ${s.links.inbox}` : null,
    s.links?.work ? `in flight: ${s.links.work}` : null,
    `board: ${s.page}`,
  ].filter((line) => line !== null);
  return [...lines, ...pages].join("\n");
}

export function nudgePrompt(s: Status): string {
  if (s.joinWorkspace) {
    return `Set this repo up in devcorner: start a session for it, and if it is in no workspace, offer to add it to my workspace ${s.joinWorkspace.slug}. Ask me before changing anything.`;
  }
  const slug = s.suggestWorkspace?.slug ?? "a name of your choice";
  return `Set this repo up in devcorner: start a session for it, and if it is in no workspace, offer me a workspace named ${slug} for it. Ask me before making anything.`;
}

/**
 * What an idle conversation does with devcorner's answer: wake for a message
 * it has not woken for, or ask again later, sooner while its session waits on
 * its person. Null stops asking: no session to wake, or a devcorner too old
 * to say what would wake it. A turn starts the asking again.
 *
 * A delivered message leaves the count, so `wokeFor` matters only when the
 * hook did not hand it over: without it, every ask would wake again.
 */
export function nextStep(
  s: Status,
  wokeFor: string | null,
): { wake: string } | { after: number } | null {
  const session = s.session;
  if (!session || session.wakeMessages === undefined) return null;
  const latest = session.wakeMessageId;
  if (session.wakeMessages > 0 && latest && latest !== wokeFor) {
    return { wake: latest };
  }
  return { after: session.waitingOnPerson ? WAITING_MS : IDLE_MS };
}

/**
 * What the server's held request (`Wait`) answered: a message that wakes the
 * session (ids only), nothing yet (`{}`, the hold ran out), or a failure that
 * hands the conversation to the Status poll: no answer, a refusal, an answer
 * not understood, or a conversation that works as no session. Or that
 * devcorner is updating, and asks to be left alone `after` ms.
 */
export type Held =
  | { kind: "wake"; session: string; id: string }
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

async function repoIn($: Engine, cwd: string): Promise<string | undefined> {
  if (lastRepo?.cwd === cwd) return lastRepo.repo;
  const git = await $.process.run(["git", "remote", "get-url", "origin"], {
    cwd,
    timeoutMs: 5000,
  });
  const repo = git.exitCode === 0 ? repoOf(git.stdout) : undefined;
  lastRepo = repo ? { cwd, repo } : undefined;
  return repo;
}

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
      file: markerFile(id, {
        state: await $.env.get("DEVCORNER_HOOK_STATE"),
        cache: await $.env.get("XDG_CACHE_HOME"),
        home: await $.env.get("HOME"),
      }),
    };
  }
  return marker.file;
}

/** How many messages wait for the hooks, as a Status says it; null when it cannot say. */
export function pendingOf(s: Status | undefined): number | null {
  if (!s) return null;
  // A conversation that works as no session is handed nothing.
  if (!s.session) return 0;
  return typeof s.session.pending === "number" ? s.session.pending : null;
}

// One call to devcorner, with what it came to; a problem is kept in the
// read, never thrown. With `picture`, devcorner also answers the repo's
// picture for the row's open block (dc-t218), which it reads only when asked.
async function fetchStatus($: Engine, picture: boolean): Promise<Read> {
  const failed = (problem: string, down = false): Read => ({
    problem,
    down,
    retryIn: null,
  });
  let base = DEFAULT_URL;
  try {
    base = ((await $.env.get("DEVCORNER_URL")) ?? DEFAULT_URL).replace(
      /\/+$/,
      "",
    );
    const token = await $.env.get("DEVCORNER_TOKEN");
    if (!token) {
      return failed(
        "DEVCORNER_TOKEN is not set in this Claude Code. It reads the environment it was started with, so start it from a shell that has the token, or set it under env in ~/.claude/settings.json.",
      );
    }
    const cwd: string = await $.session.cwd();
    const repo = await repoIn($, cwd);
    if (!repo) {
      return failed(
        "This folder has no git remote named origin, so devcorner cannot tell which repo it is.",
      );
    }
    const res = await $.http.fetch(`${base}/mcp/hooks/claude-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hook_event_name: "Status",
        repo,
        session_id: await $.session.id(),
        cwd,
        ...(picture ? { expanded: true } : {}),
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return failed(
        `devcorner at ${base} refused the token (HTTP ${res.status}). Make a hook token at ${base}/settings/connections.`,
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
    return {
      status: { ...body, repo: body.repo ?? repo },
      down: false,
      retryIn: null,
    };
  } catch {
    return failed(`devcorner at ${base} could not be reached.`, true);
  }
}

/**
 * Reads Status, at most every 30 s unless forced (undefined when it does
 * not), and keeps what it says: the row, the updating line and the hooks'
 * marker. On failure the last good status stays. It asks for the repo's
 * picture while the row is open, or when `picture` says so (/dc).
 */
async function refresh(
  $: Engine,
  force = false,
  picture = false,
): Promise<Read | undefined> {
  const now = await $.clock.now().catch(() => undefined);
  if (now === undefined || (!force && now - lastAt < EVERY_MS)) {
    return undefined;
  }
  lastAt = now;
  const seq = ++learnt;
  const open = picture || (await read($, expanded).catch(() => false));
  const got = await fetchStatus($, open);
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
      $.ui.invalidate("ui.render");
    }
  } catch {
    /* stay silent: the read is still what it was */
  }
  return got;
}

/**
 * Opens or closes the row (dc-t218): its own more and less, and `/dc more`
 * and `/dc less` for a terminal that passes it no click and no ctrl+x, as
 * VS Code's does (dc-t225). Opened, it asks for the picture now, not at the
 * next poll.
 */
async function setOpen($: Engine, open: boolean): Promise<void> {
  await update($, expanded, () => open);
  if (open) void refresh($, true);
}

/** What `/dc more` and `/dc less` answer: the row as they left it. */
export const OPEN_LINE = "The row is open.";
export const CLOSED_LINE = "The row is closed.";

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
/** When a wake was submitted whose turn has not begun yet; null once it has (`WAKE_SETTLE_MS`). */
let wokeAt: number | null = null;

/** Whether a wake submitted lately still waits for its turn to begin (`wokeAt`). */
const settling = (now: number) =>
  wokeAt !== null && now - wokeAt < WAKE_SETTLE_MS;

/** A new or ended session starts clean: nothing of the last one carries over. */
function forgetSession(): void {
  quick = 0;
  holdAfter = 0;
  askAfter = 0;
  failures = 0;
  wokeAt = null;
}

/** How long the poll waits: sooner only while the session waits on its person. */
async function pollMs($: Engine): Promise<number> {
  const s = await read($, status);
  return s?.session?.waitingOnPerson ? WAITING_MS : IDLE_MS;
}

async function waitOnce($: Engine): Promise<Held> {
  try {
    const token = await $.env.get("DEVCORNER_TOKEN");
    if (!token) return { kind: "failed" };
    const base = ((await $.env.get("DEVCORNER_URL")) ?? DEFAULT_URL).replace(
      /\/+$/,
      "",
    );
    const from = (await read($, woke)) ?? undefined;
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
      const session = s.session!;
      await update($, woke, () => step.wake);
      wokeAt = now;
      $.ui.toast(wakeToast(session));
      void $.prompt.submit({ text: wakePrompt(session) });
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
    if (!(await $.env.get("DEVCORNER_TOKEN"))) return;
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
    const token = await $.env.get("DEVCORNER_TOKEN");
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
    const base = ((await $.env.get("DEVCORNER_URL")) ?? DEFAULT_URL).replace(
      /\/+$/,
      "",
    );
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
    if (await $.env.get("DEVCORNER_TOKEN")) return null;
    if (!(await $.env.get("CLAUDE_CODE_REMOTE"))) return null;
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
          "devcorner: status, more or less to open or close the row, or ask it something (/dc board)",
        argumentHint: "[more | less | what to ask]",
      });
    } catch {
      /* stay silent */
    }
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
    try {
      await update($, turn, () => e.turnId);
    } catch {
      /* stay silent */
    }
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

  on("command.run", { command: "dc" }, async ($, e) => {
    const arg = e.args.trim();
    // The row's more and less, whole and exact (dc-t225); any other words ask.
    if (arg === "more" || arg === "less") {
      const open = arg === "more";
      await setOpen($, open);
      return { text: open ? OPEN_LINE : CLOSED_LINE };
    }
    if (arg) {
      void $.prompt.submit({ text: `devcorner: ${arg}`, asUser: true });
      return { text: `Asking devcorner: ${arg}` };
    }
    // The open block, whatever the row shows: Claude Code's [-] may hide
    // the row, and a plugin cannot tell (dc-t218).
    const got = await refresh($, true, true);
    if ((await read($, updating)) !== null) {
      return { text: got?.problem ?? UPDATING_LINE };
    }
    // Its own read's answer, which holds the picture, even when a poll that
    // ran beside it holds the row.
    const s = got?.status ?? (await read($, status));
    if (!s) {
      return { text: got?.problem ?? "devcorner has given no status yet." };
    }
    return { text: dcText(s) };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Button, Link, Text } = $.ui.resolve(e);
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
    const s = await read($, status);
    if (!s) return next(e);

    if (!s.known) {
      if ((await read($, dismissed)).includes(s.repo)) return next(e);
      return (
        <Box>
          <Text dimColor>dc: new project here. </Text>
          <Button
            key="setup"
            label="Set it up"
            onPress={() => {
              void $.prompt.submit({ text: nudgePrompt(s), asUser: true });
            }}
          />
          <Text dimColor> </Text>
          <Button
            key="later"
            label="Not now"
            onPress={async () => {
              const list = [...(await read($, dismissed)), s.repo];
              await $.store.set("dismissed", list);
              await update($, dismissed, () => list);
              $.ui.invalidate("ui.render");
            }}
          />
        </Box>
      );
    }

    // devcorner's own line, so there is no ⚠ and no mod name in front of
    // it: closed by default to one short line, and open, by its own more
    // and less, to the project's picture (dc-t218). Claude Code's [-] hides
    // the whole row and tells the plugin nothing, so it cannot be this.
    const open = await read($, expanded);
    const linked = (segments: Segment[]) =>
      segments.map(({ text, href }) =>
        href ? <Link href={href}>{text}</Link> : text,
      );
    const toggle = (
      <Button
        key={open ? "less" : "more"}
        label={open ? "less" : "more"}
        onPress={() => setOpen($, !open)}
      />
    );
    const [head, ...rest] = open ? expandedLines(s) : [collapsedSegments(s)];
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">● </Text>
          <Text dimColor>{linked(head!)}</Text>
          <Text> </Text>
          {toggle}
        </Box>
        {rest.map((line) => (
          <Text dimColor>
            {"  "}
            {linked(line)}
          </Text>
        ))}
      </Box>
    );
  });
};
