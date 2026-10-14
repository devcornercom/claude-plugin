import { describe, expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { On } from "claude-code";
import type { Status, StatusWake } from "../types";
import {
  CLOSED_LINE,
  DOWN_MS,
  HOLD_MS,
  IDLE_MS,
  MAX_DOWN_MS,
  MAX_UPDATING_MS,
  OPEN_LINE,
  QUICK_MAX,
  UPDATING_GRACE_MS,
  UPDATING_LINE,
  WAIT_RETRY_MS,
  WAITING_MS,
  WAKE_SETTLE_MS,
  wakeLine,
  wakePrompt,
  wakeToast,
  wakeWords,
  DUE_EVERY_MS,
  DUE_POINTS,
  DUE_THRESHOLDS,
  backoff,
  capacityBody,
  capacityDue,
  CARRIER,
  capacityReading,
  markerFile,
  markerText,
  nextStep,
  pendingOf,
  nudgePrompt,
  repoOf,
  collapsedSegments,
  dcText,
  expandedLines,
  lineText,
  updatingFor,
} from "./register";

const base = {
  repo: "a/b",
  known: true,
  workspace: null,
  project: null,
  projects: 0,
  session: null,
  waiting: 0,
  next: null,
  suggestWorkspace: null,
  joinWorkspace: null,
  page: "x",
};

test("repoOf normalises remotes", () => {
  expect(repoOf("git@github.com:acme/shop.git\n")).toBe("acme/shop");
  expect(repoOf("https://github.com/acme/shop")).toBe("acme/shop");
  expect(repoOf("")).toBe(undefined);
});

/** The closed row's words as they read, links or not. */
const plain = (s: Status) => lineText(collapsedSegments(s));

/** The open block's lines as they read. */
const lines = (s: Status) => expandedLines(s).map(lineText);

/** Every linked part of the open block, as [words, address]. */
const linksOf = (s: Status) =>
  expandedLines(s)
    .flat()
    .filter(({ href }) => href)
    .map(({ text, href }) => [text, href]);

/** The pages devcorner names for a conversation in Acme's shop, on session dc-s7@acme. */
const LINKS = {
  place: "https://dc.test/w/acme",
  project: "https://dc.test/w/acme/p/shop",
  session: "https://dc.test/s/dc-s7@acme",
  ticket: "https://dc.test/t/dc-t10@acme",
  inbox: "https://dc.test/inbox",
  work: "https://dc.test/w/acme/p/shop/work",
};

/** A Status that names every page. */
const WHOLE: Status = {
  ...base,
  workspace: { slug: "acme", name: "Acme" },
  project: { slug: "shop", name: "Shop" },
  session: { id: "dc-s7@acme", ticket: "dc-t10@acme" },
  waiting: 2,
  next: { id: "dc-t5@acme", title: "Export" },
  links: LINKS,
};
/** The same, from a devcorner that names no pages. */
const { links: _links, ...OLDER } = WHOLE;

/** The repo's night, armed (dc-t213). */
const NIGHT = {
  id: "dc-o3@acme",
  state: "Working (lands)",
  counts: "3 acts, 1 wait on you",
  page: "https://dc.test/o/dc-o3@acme",
};

/** The repo's picture, as devcorner answers it when the plugin asks (dc-t218). */
const PICTURE = {
  firstWaiting: {
    id: "dc-t4@acme",
    title: "Decide the name",
    page: "https://dc.test/t/dc-t4@acme",
  },
  inFlight: { count: 6, sessions: 3, runs: 1, pulls: 1, night: true },
  cloud: [
    {
      id: "dc-s9@acme",
      page: "https://dc.test/s/dc-s9@acme",
      routine: "Max",
      held: "3 of 5 runs",
      workers: 2,
    },
  ],
  next: [
    { id: "dc-t5@acme", title: "Export", page: "https://dc.test/t/dc-t5@acme" },
    { id: "dc-t6@acme", title: "Import", page: "https://dc.test/t/dc-t6@acme" },
  ],
  code: "main at ccccccc · deployed bbbbbbb 3 h ago · 1 commit on main not deployed yet",
};
const PICTURED: Status = { ...WHOLE, overnight: NIGHT, expanded: PICTURE };

describe("the row closed, its default: one short line (dc-t218)", () => {
  test("says what waits on the person, linked to the inbox", () => {
    expect(plain(WHOLE)).toBe("devcorner · 2 waiting on you");
    expect(collapsedSegments(WHOLE).filter(({ href }) => href)).toEqual([
      { text: "2 waiting on you", href: LINKS.inbox },
    ]);
    expect(
      plain({ ...base, session: { id: "dc-s48", ticket: "dc-t10" } }),
    ).toBe("devcorner · nothing waits on you");
  });

  test("adds the night's word while one is armed or paused, its id linking its page", () => {
    const night = { ...WHOLE, overnight: NIGHT };
    expect(plain(night)).toBe(
      "devcorner · 2 waiting on you · overnight dc-o3@acme: Working (lands)",
    );
    expect(
      collapsedSegments(night).find(({ text }) => text === "dc-o3@acme")?.href,
    ).toBe(NIGHT.page);
    expect(plain({ ...WHOLE, overnight: null })).toBe(plain(WHOLE));
  });

  test("an older devcorner, which names no pages, gives the same words with no links", () => {
    expect(collapsedSegments(OLDER).some(({ href }) => href)).toBe(false);
    expect(plain(OLDER)).toBe(plain(WHOLE));
  });
});

describe("the row open: the project's picture (dc-t218)", () => {
  test("leads with Project home, Active actions and In flight, then the details", () => {
    expect(lines(PICTURED)).toEqual([
      "devcorner · Acme · Shop",
      "Project home · Active actions: 2 · In flight: 6",
      "this conversation: session dc-s7@acme, on ticket dc-t10@acme",
      "2 waiting on you, first dc-t4@acme Decide the name",
      "overnight dc-o3@acme: Working (lands), 3 acts, 1 wait on you",
      "in flight: 3 live sessions · 1 run · 1 pull request · the night",
      "cloud: dc-s9@acme Max, 3 of 5 runs, 2 workers",
      "next: dc-t5@acme Export · dc-t6@acme Import",
      `code: ${PICTURE.code}`,
    ]);
  });

  test("each part links to the page devcorner named, and the plugin builds none", () => {
    expect(linksOf(PICTURED)).toEqual([
      ["Acme", LINKS.place],
      ["Shop", LINKS.project],
      ["Project home", LINKS.project],
      ["Active actions: 2", LINKS.inbox],
      ["In flight: 6", LINKS.work],
      ["dc-s7@acme", LINKS.session],
      ["dc-t10@acme", LINKS.ticket],
      ["2 waiting on you", LINKS.inbox],
      ["dc-t4@acme", PICTURE.firstWaiting.page],
      ["dc-o3@acme", NIGHT.page],
      ["3 live sessions · 1 run · 1 pull request · the night", LINKS.work],
      ["dc-s9@acme", PICTURE.cloud[0]!.page],
      ["dc-t5@acme", PICTURE.next[0]!.page],
      ["dc-t6@acme", PICTURE.next[1]!.page],
    ]);
  });

  test("Active actions is the closed row's count, and nothing in flight says so", () => {
    const quiet: Status = {
      ...WHOLE,
      waiting: 0,
      expanded: {
        ...PICTURE,
        firstWaiting: null,
        inFlight: { count: 0, sessions: 0, runs: 0, pulls: 0, night: false },
        cloud: [],
        next: [],
        code: null,
      },
    };
    expect(lines(quiet)).toEqual([
      "devcorner · Acme · Shop",
      "Project home · Active actions: 0 · In flight: 0",
      "this conversation: session dc-s7@acme, on ticket dc-t10@acme",
      "in flight: nothing",
    ]);
  });

  test("before the picture is read, or from an older devcorner, it says what the Status gave", () => {
    expect(lines(WHOLE)).toEqual([
      "devcorner · Acme · Shop",
      "Project home · Active actions: 2 · In flight",
      "this conversation: session dc-s7@acme, on ticket dc-t10@acme",
      "2 waiting on you",
      "next: dc-t5@acme Export",
    ]);
    // A devcorner too old to name the Work tab leaves In flight plain, and
    // one that names no pages links nothing.
    const { work: _work, ...older } = LINKS;
    expect(linksOf({ ...WHOLE, links: older }).slice(2, 5)).toEqual([
      ["Project home", LINKS.project],
      ["Active actions: 2", LINKS.inbox],
      ["dc-s7@acme", LINKS.session],
    ]);
    expect(linksOf(OLDER)).toEqual([]);
    expect(lines(OLDER)).toEqual(lines(WHOLE));
  });

  test("a repo in no workspace is Personal's, and a long title is cut", () => {
    const personal: Status = {
      ...base,
      waiting: 1,
      links: {
        ...LINKS,
        place: "https://dc.test/personal",
        project: null,
        work: "https://dc.test/personal/work",
      },
      expanded: {
        ...PICTURE,
        firstWaiting: { id: "dc-t1", title: "x".repeat(60), page: null },
      },
    };
    expect(lines(personal)[0]).toBe("devcorner · personal");
    expect(lines(personal)[2]).toBe(
      `1 waiting on you, first dc-t1 ${"x".repeat(39)}…`,
    );
    // Project home is Personal's place.
    expect(linksOf(personal).slice(0, 2)).toEqual([
      ["personal", "https://dc.test/personal"],
      ["Project home", "https://dc.test/personal"],
    ]);
  });

  test("/dc says the open block as text, with the pages its lead items open", () => {
    expect(dcText(PICTURED).split("\n")).toEqual([
      "repo: a/b",
      ...lines(PICTURED),
      `project home: ${LINKS.project}`,
      `active actions: ${LINKS.inbox}`,
      `in flight: ${LINKS.work}`,
      "board: x",
    ]);
  });
});

test("devcorner's answer that it is updating is read with the wait it names, and nothing else is", () => {
  const updating = JSON.stringify({
    error: "updating",
    retryAfter: 5,
    message: "devcorner is updating, back in a moment.",
  });
  expect(
    updatingFor({
      status: 503,
      headers: { "retry-after": "5" },
      text: updating,
    }),
  ).toBe(5_000);
  // The body says it when no header reaches the plugin.
  expect(updatingFor({ status: 503, headers: {}, text: updating })).toBe(5_000);
  // A wait past five minutes is not taken as said.
  expect(
    updatingFor({
      status: 503,
      headers: { "retry-after": "86400" },
      text: updating,
    }),
  ).toBe(MAX_UPDATING_MS);
  // Any other answer is not an update.
  expect(updatingFor({ status: 503, headers: {}, text: "down" })).toBe(null);
  expect(
    updatingFor({ status: 503, headers: {}, text: '{"error":"other"}' }),
  ).toBe(null);
  expect(updatingFor({ status: 200, headers: {}, text: updating })).toBe(null);
});

test("the held request names a hold shorter than $.http.fetch is known to wait", () => {
  expect(HOLD_MS).toBeLessThan(30_000);
});

test("nudge prompt", () => {
  expect(
    nudgePrompt({ ...base, suggestWorkspace: { slug: "acme" } }),
  ).toContain("named acme");
});

test("nudge prompt adds the repo to a workspace the person has", () => {
  const prompt = nudgePrompt({
    ...base,
    suggestWorkspace: { slug: "acme" },
    joinWorkspace: { slug: "acme", name: "Acme Inc" },
  });
  expect(prompt).toContain("add it to my workspace acme");
  expect(prompt).not.toContain("named acme");
});

/** A Status whose session waits on its person, with `messages` that wake it. */
/** A Status whose session has `n` messages for the hooks, none of which wakes it. */
function pending(n: number): Status {
  return {
    ...waiting(0, null, false),
    session: { ...waiting(0, null, false).session!, pending: n },
  };
}

function waiting(
  messages: number,
  latest: string | null,
  waitingOnPerson = true,
): Status {
  return {
    ...base,
    session: {
      id: "dc-s7",
      ticket: null,
      waitingOnPerson,
      wakeMessages: messages,
      wakeMessageId: latest,
    },
  };
}

/** The prompt a wake for `waiting(n, …)` submits: it names no message, as from a devcorner before dc-t204. */
const WAKE = (n = 1) => wakePrompt(waiting(n, "dc-m1").session!);

describe("what an idle conversation does with devcorner's answer", () => {
  test("wakes once for each message, and asks sooner while its session waits", () => {
    expect(nextStep(waiting(1, "dc-m3"), null)).toEqual({ wake: "dc-m3" });
    expect(nextStep(waiting(1, "dc-m3"), "dc-m3")).toEqual({
      after: WAITING_MS,
    });
    expect(nextStep(waiting(2, "dc-m4"), "dc-m3")).toEqual({ wake: "dc-m4" });
    expect(nextStep(waiting(0, null), null)).toEqual({ after: WAITING_MS });
    expect(nextStep(waiting(0, null, false), null)).toEqual({
      after: IDLE_MS,
    });
    expect(WAITING_MS).toBe(15_000);
    expect(IDLE_MS).toBe(60_000);
  });

  test("stops with no session, or a devcorner too old to say what wakes it", () => {
    expect(nextStep(base, null)).toBe(null);
    expect(
      nextStep({ ...base, session: { id: "dc-s7", ticket: null } }, null),
    ).toBe(null);
  });

  test("waits a minute after a failure, doubling up to ten", () => {
    expect(backoff(1)).toBe(DOWN_MS);
    expect(backoff(2)).toBe(2 * DOWN_MS);
    expect(backoff(3)).toBe(4 * DOWN_MS);
    expect(backoff(9)).toBe(MAX_DOWN_MS);
    expect(DOWN_MS).toBe(60_000);
    expect(MAX_DOWN_MS).toBe(600_000);
  });

  test("the wake prompt carries no message, and says how many came when devcorner names none", () => {
    expect(WAKE()).toBe(
      'While this session was idle, a devcorner message woke it. It comes with this prompt as a devcorner message: read it and carry on from it, and if it ends with "…", read it whole with show(its id) first. If it is not there, call check.',
    );
    expect(WAKE(2)).toContain("2 devcorner messages woke it. They come");
    expect(WAKE()).not.toContain("dc-m");
    expect(wakeToast(waiting(1, "dc-m3").session!)).toBe(
      "dc: a message woke dc-s7",
    );
  });
});

describe("what a wake names (dc-t204)", () => {
  const w = (
    from: string,
    what: string,
    item: string | null = null,
    detail: string | null = null,
  ): StatusWake => ({ id: "dc-m1", from, what, item, detail });

  test("names what came by its sender and kind, and says 'your' only of the person's own word", () => {
    const cases: [StatusWake, string, string][] = [
      [
        w("github", "conflict", "acme/shop#210", "main"),
        "GitHub — #210 conflicts with main",
        "GitHub — #210 conflicts with main",
      ],
      [
        w("run", "done", "dc-r312"),
        "run dc-r312 finished",
        "run dc-r312 finished",
      ],
      [
        w("run", "partial", "dc-r3@acme"),
        "run dc-r3@acme finished as partial",
        "run dc-r3@acme finished as partial",
      ],
      [w("run", "expired", "dc-r3"), "run dc-r3 expired", "run dc-r3 expired"],
      [
        w("run", "lost", "dc-r3"),
        "run dc-r3 ended without finishing",
        "run dc-r3 ended without finishing",
      ],
      [
        w("person", "decided", "dc-q110"),
        "your answer to dc-q110",
        "your user's answer to dc-q110",
      ],
      [
        w("member", "decided", "dc-q110"),
        "an answer to dc-q110",
        "an answer to dc-q110",
      ],
      [
        w("person", "reopened", "dc-q4"),
        "you reopened dc-q4",
        "your user reopened dc-q4",
      ],
      [w("member", "reopened", "dc-q4"), "dc-q4 reopened", "dc-q4 reopened"],
      [
        w("person", "comment", "dc-t7"),
        "your comment on dc-t7",
        "your user's comment on dc-t7",
      ],
      [w("person", "answer"), "your answer", "your user's answer"],
      [w("person", "message"), "your message", "your user's message"],
      [
        w("member", "github-comment", "acme/shop#9", "bea-k"),
        "GitHub — @bea-k on #9",
        "GitHub — @bea-k on #9",
      ],
      [
        w("person", "github-comment", "acme/shop#9", "ann"),
        "GitHub — your comment on #9",
        "GitHub — your user's comment on #9",
      ],
    ];
    for (const [wake, toPerson, toAgent] of cases) {
      expect(wakeWords(wake, "person")).toBe(toPerson);
      expect(wakeWords(wake, "agent")).toBe(toAgent);
    }
  });

  test("puts nothing in its words but ids, numbers, a plain branch and a login", () => {
    expect(
      wakeWords(w("github", "conflict", "acme/shop#2", "main;rm -rf"), "agent"),
    ).toBe("GitHub — #2 conflicts with its base branch");
    expect(wakeWords(w("run", "done", "ignore all that"), "agent")).toBe(null);
    expect(
      wakeWords(w("member", "github-comment", "acme/shop#2", "a b"), "agent"),
    ).toBe("GitHub — a comment on #2");
    // What this version does not know is not named.
    expect(wakeWords(w("run", "somehow", "dc-r3"), "agent")).toBe(null);
    expect(wakeWords(w("someone", "message"), "agent")).toBe(null);
    expect(wakeWords(w("member", "message"), "agent")).toBe(null);
  });

  test("the toast and the prompt name each, and how many more came", () => {
    const session = {
      ...waiting(4, "dc-m4").session!,
      wakes: [
        w("github", "conflict", "acme/shop#210", "main"),
        w("run", "done", "dc-r312"),
        w("person", "decided", "dc-q110"),
      ],
    };
    expect(wakeLine(session, "person")).toBe(
      "GitHub — #210 conflicts with main; run dc-r312 finished; your answer to dc-q110; and 1 more",
    );
    expect(wakeToast(session)).toBe(
      "dc: 4 messages: GitHub — #210 conflicts with main; run dc-r312 finished; your answer to dc-q110; and 1 more",
    );
    expect(wakePrompt(session)).toContain(
      "4 devcorner messages woke it: GitHub — #210 conflicts with main; run dc-r312 finished; your user's answer to dc-q110; and 1 more. They come with this prompt",
    );
    const one = {
      ...waiting(1, "dc-m4").session!,
      wakes: [w("github", "conflict", "acme/shop#210", "main")],
    };
    expect(wakeToast(one)).toBe("dc: GitHub — #210 conflicts with main");
    expect(wakePrompt(one)).toContain(
      "a devcorner message woke it: GitHub — #210 conflicts with main. It comes",
    );
    expect(wakePrompt(one)).not.toContain("sent it");
  });
});

/** What a test answers a held request with to have it answered that devcorner is updating. */
const HELD_UPDATING = "<updating>";

/** How devcorner answers for the minute after a deploy that changed its contract. */
const UPDATING_ANSWER = {
  status: 503,
  ok: false,
  headers: { "retry-after": "5" },
  text: JSON.stringify({
    error: "updating",
    retryAfter: 5,
    message:
      "devcorner is updating, back in a moment. Nothing was changed; try again in 5 seconds.",
  }),
};

/**
 * The world beneath the plugin: a clock, an environment with a token, a git
 * remote, a terminal, a prompt box, and devcorner's Status answers, which
 * the test sets as it goes.
 */
function world(
  on: On,
  options: {
    token?: boolean;
    surfaces?: number;
    hold?: boolean;
    /** A home folder, where the hooks' marker is kept (dc-t173). */
    home?: string;
    /** A cloud session: Claude Code sets CLAUDE_CODE_REMOTE there. */
    remote?: boolean;
    /** Asked before each look at the clock: a promise it gives is waited first. */
    beforeNow?: () => Promise<void> | undefined;
  } = {},
) {
  const beforeNow = options.beforeNow;
  const clockOn: On = beforeNow
    ? (((name: string, ...rest: unknown[]) => {
        if (name !== "clock.now") return (on as Function)(name, ...rest);
        const handler = rest.at(-1) as (...args: unknown[]) => unknown;
        return (on as Function)(name, async (...args: unknown[]) => {
          await beforeNow();
          return handler(...args);
        });
      }) as On)
    : on;
  const clock = mock.clock(clockOn, { now: 1_000_000 });
  mock.store(on);
  mock.env(on, {
    ...(options.token === false
      ? {}
      : { DEVCORNER_TOKEN: "dch_test", DEVCORNER_URL: "http://dc.test" }),
    ...(options.home ? { HOME: options.home } : {}),
    ...(options.remote ? { CLAUDE_CODE_REMOTE: "true" } : {}),
  });
  const seen = {
    asks: 0,
    submitted: [] as string[],
    toasts: [] as string[],
    draft: "",
    answer: waiting(0, null) as Status | "down" | "updating",
    /** The held request is answered that devcorner is updating. */
    waitUpdating: false,
    waitBodies: [] as Record<string, unknown>[],
    /** What each Status read sent. */
    statusBodies: [] as Record<string, unknown>[],
    held: [] as ((text: string) => void)[],
    capacity: [] as Record<string, unknown>[],
    /** The rate-limit windows $.session.usage() reports. */
    limits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    /** The marker files written, in order. */
    writes: [] as { path: string; text: string }[],
    /** While true, a write waits until the test lets it land (`landWrites`). */
    holdWrites: false,
    heldWrites: [] as (() => void)[],
    /** How many surfaces draw the session now; a test may change it. */
    surfaces: options.surfaces ?? 1,
    /** The Status reads that wait for the test to answer them, while `holdStatus`. */
    holdStatus: false,
    heldStatus: [] as ((answer: Status | "down" | "updating") => void)[],
  };
  on("fs.write", async (_$, e) => {
    if (seen.holdWrites) {
      await new Promise<void>((resolve) => seen.heldWrites.push(resolve));
    }
    seen.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("fs.exists", async (_$, e) => ({
    value: seen.writes.some((w) => w.path === e.path),
  }));
  on("http.fetch", async (_$, e) => {
    const sent = JSON.parse(e.init?.body ?? "{}");
    if (sent.hook_event_name === "Capacity") {
      seen.capacity.push(sent);
      return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
    }
    if (sent.hook_event_name === "Wait") {
      seen.waitBodies.push(sent);
      if (seen.waitUpdating) return { value: UPDATING_ANSWER };
      // Unless a test holds it open, the held request is refused: the poll runs.
      if (!options.hold) {
        return { value: { status: 404, ok: false, headers: {}, text: "" } };
      }
      const text = await new Promise<string>((resolve) =>
        seen.held.push(resolve),
      );
      if (text === HELD_UPDATING) return { value: UPDATING_ANSWER };
      return { value: { status: 200, ok: true, headers: {}, text } };
    }
    seen.asks++;
    seen.statusBodies.push(sent);
    const answer = seen.holdStatus
      ? await new Promise<Status | "down" | "updating">((resolve) =>
          seen.heldStatus.push(resolve),
        )
      : seen.answer;
    if (answer === "down") return { deny: "unreachable" };
    if (answer === "updating") return { value: UPDATING_ANSWER };
    const text = JSON.stringify(answer);
    return { value: { status: 200, ok: true, headers: {}, text } };
  });
  on("process.run", async () => ({
    value: {
      exitCode: 0,
      stdout: "git@github.com:acme/shop.git\n",
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on("session.id", async () => ({ value: "conversation-1" }));
  on("session.cwd", async () => ({ value: "/work/shop" }));
  on("session.surfaces", async () => ({
    value: seen.surfaces === 0 ? [] : (["terminal"] as const),
  }));
  on("prompt.read", async () => ({
    value: { text: seen.draft, cursor: seen.draft.length },
  }));
  on("prompt.submit", async (_$, e) => {
    seen.submitted.push(e.text);
    return { text: e.text };
  });
  on("ui.toast", async (_$, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("command.register", async () => ({ value: { command: "dc" } }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("session.end", async (_$, e) => ({ sessionId: e.sessionId }));
  on("session.measure", async (_$, e) => e);
  // The windows the turn's last answer reported, which a test sets.
  on("session.usage", async () => ({
    value: { rateLimits: seen.limits } as any,
  }));
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async () => ({ text: "" }));
  return { clock, seen };
}

const START = {
  cwd: "/work/shop",
  surface: "terminal",
  isInteractive: true,
} as const;
const done = (turnId: string, agentId?: string) => ({
  answer: "",
  durationMs: 1,
  isAborted: false,
  turnId,
  reason: "answer" as const,
  ...(agentId ? { agentId } : {}),
});

describe("waking an idle conversation", () => {
  test("submits the one fixed prompt once for each message from its person", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    const atStart = seen.asks;
    expect(atStart).toBe(1);

    // The held request is refused here, so the poll waits a minute (a failure's backoff).
    await clock.advance(DOWN_MS);
    expect(seen.asks).toBe(atStart + 1);
    expect(seen.submitted).toEqual([]);

    // The person answers: one wake, with the fixed prompt and never the text.
    seen.answer = waiting(1, "dc-m3");
    await clock.advance(2 * DOWN_MS);
    expect(seen.submitted).toEqual([WAKE()]);
    expect(seen.toasts).toEqual(["dc: a message woke dc-s7"]);

    // The same message, still waiting (its hook did not hand it over): no second wake.
    const asked = seen.asks;
    await clock.advance(4 * DOWN_MS);
    expect(seen.asks).toBeGreaterThan(asked);
    expect(seen.submitted).toHaveLength(1);

    // A new one wakes it again.
    seen.answer = waiting(2, "dc-m4");
    await clock.advance(8 * DOWN_MS);
    expect(seen.submitted).toEqual([WAKE(), WAKE(2)]);
  });

  test("never wakes over a draft, and wakes once the box is empty", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    seen.answer = waiting(1, "dc-m3");
    seen.draft = "half a thought";
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([]);
    seen.draft = "";
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([WAKE()]);
  });

  test("pauses while a turn runs and starts again when it ends", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    await $.turn.start({ text: "work", turnId: "t1" });
    const before = seen.asks;
    seen.answer = waiting(1, "dc-m3");
    await clock.advance(5 * IDLE_MS);
    expect(seen.asks).toBe(before);
    expect(seen.submitted).toEqual([]);

    // A reload mid-turn starts the module over; the turn it knew of holds it.
    await $.session.start(START);
    await clock.advance(5 * IDLE_MS);
    // Its status line is read once, as at every start, and nothing more.
    expect(seen.asks).toBe(before + 1);
    expect(seen.submitted).toEqual([]);

    // A subagent's turn ending is not the conversation's.
    await $.turn.complete(done("t1", "agent-1"));
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([]);

    await $.turn.complete(done("t1"));
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([WAKE()]);
  });

  test("asks every minute while its session waits on nobody", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = waiting(0, null, false);
    await $.session.start(START);
    await clock.advance(WAITING_MS);
    const first = seen.asks;
    await clock.advance(WAITING_MS);
    expect(seen.asks).toBe(first);
    await clock.advance(IDLE_MS - WAITING_MS);
    expect(seen.asks).toBe(first + 1);
  });

  test("stops with no session to wake, and asks again after the next turn", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = base;
    await $.session.start(START);
    await clock.advance(WAITING_MS);
    const stopped = seen.asks;
    await clock.advance(10 * IDLE_MS);
    expect(seen.asks).toBe(stopped);

    seen.answer = waiting(1, "dc-m3");
    await $.turn.start({ text: "start a session", turnId: "t1" });
    await $.turn.complete(done("t1"));
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([WAKE()]);
  });

  test("asks nothing with no token, or where nothing draws the session", async ($, on) => {
    const { clock, seen } = world(on, { token: false });
    await $.session.start(START);
    await clock.advance(10 * IDLE_MS);
    expect(seen.asks).toBe(0);
    expect(seen.submitted).toEqual([]);
  });

  test("a plain -p run, which draws nowhere, never asks on a timer", async ($, on) => {
    const { clock, seen } = world(on, { surfaces: 0 });
    seen.answer = waiting(1, "dc-m3");
    await $.session.start({ ...START, surface: null, isInteractive: false });
    await clock.settle();
    const atStart = seen.asks;
    await clock.advance(10 * IDLE_MS);
    expect(seen.asks).toBe(atStart);
    expect(seen.submitted).toEqual([]);
  });

  test("leaves devcorner alone longer after each failure, and stops at the end of the session", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "down";
    await $.session.start(START);
    await clock.settle();
    const failed = seen.asks;
    await clock.advance(DOWN_MS - 1);
    expect(seen.asks).toBe(failed);
    await clock.advance(1);
    expect(seen.asks).toBe(failed + 1);
    await clock.advance(2 * DOWN_MS);
    expect(seen.asks).toBe(failed + 2);

    seen.answer = waiting(1, "dc-m3");
    await clock.advance(4 * DOWN_MS);
    expect(seen.submitted).toEqual([WAKE()]);

    await $.session.end({
      reason: "other",
      sessionId: "conversation-1",
      resume: { id: "conversation-1" },
    });
    const ended = seen.asks;
    await clock.advance(10 * IDLE_MS);
    expect(seen.asks).toBe(ended);
  });
});

/** Draws the row above the prompt on a terminal, as Claude Code does. */
const mountRow = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: "devcorner",
    surface: "terminal",
    component: "AbovePrompt",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  });

/**
 * The row above the prompt, as the terminal draws it now: its text, or ""
 * when the plugin passes the row on with nothing of its own to draw (the
 * test has no engine beneath it to draw one).
 */
async function row($: Parameters<TestBody>[0]): Promise<string> {
  const ui = await mountRow($).catch((error: unknown) => {
    if (/no implementation for ui\.render/.test(String(error))) return null;
    throw error;
  });
  return ui === null ? "" : ((await ui.find({ type: "Box" }))?.text ?? "");
}

/** An element as a mounted drawing describes it, or a string of its text. */
type Drawn =
  | string
  | { type: string; props: Record<string, unknown>; children?: Drawn[] };

/**
 * What the row draws now in its dim text: each line's words in order, and
 * each link's words and address. A link's words are the link's own children,
 * since the harness's `text` of a Link also holds its address.
 */
async function drawn($: Parameters<TestBody>[0]) {
  const ui = await mountRow($);
  const dim = (await ui.findAll({ type: "Text" })).filter(
    (found) => found.props.dimColor === true,
  );
  const words = (parts: Drawn[]): string =>
    parts
      .map((part) =>
        typeof part === "string" ? part : words(part.children ?? []),
      )
      .join("");
  return {
    lines: dim.map((text) => words((text.children ?? []) as Drawn[])),
    links: dim.flatMap((text) =>
      ((text.children ?? []) as Drawn[]).flatMap((part) =>
        typeof part === "string"
          ? []
          : [{ text: words(part.children ?? []), href: part.props.href }],
      ),
    ),
  };
}

/** Presses the row's own Button, as the person clicking it does. */
async function press($: Parameters<TestBody>[0], key: string) {
  const ui = await mountRow($);
  await ui.press({ key });
}

describe("the row above the prompt, drawn", () => {
  test("is closed to one short line by default, with its more, and links what waits", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = WHOLE;
    await $.session.start(START);
    await clock.settle();
    expect(await drawn($)).toEqual({
      lines: [plain(WHOLE)],
      links: [{ text: "2 waiting on you", href: LINKS.inbox }],
    });
    expect(
      (await (await mountRow($)).find({ type: "Button" }))?.props,
    ).toMatchObject({ label: "more" });
    // Closed, the row's reads ask for no picture.
    expect(seen.statusBodies.some((body) => "expanded" in body)).toBe(false);
  });

  test("draws the same words with no link from a devcorner that names no pages", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = OLDER;
    await $.session.start(START);
    await clock.settle();
    expect(await drawn($)).toEqual({ lines: [plain(WHOLE)], links: [] });
  });

  test("more opens it to the project's picture, asked for at once and while it stays open; less closes it", async ($, on) => {
    const { clock, seen } = world(on);
    // A session that says what wakes it, so the idle asking goes on.
    const session = {
      id: "dc-s7@acme",
      ticket: "dc-t10@acme",
      waitingOnPerson: false,
      wakeMessages: 0,
      wakeMessageId: null,
    };
    seen.answer = { ...WHOLE, session };
    await $.session.start(START);
    await clock.settle();
    seen.answer = { ...PICTURED, session };
    const asked = seen.asks;
    await press($, "more");
    await clock.settle();
    expect(seen.asks).toBe(asked + 1);
    expect(seen.statusBodies.at(-1)).toMatchObject({
      hook_event_name: "Status",
      expanded: true,
    });
    const open = await drawn($);
    expect(open.lines).toEqual(
      lines(PICTURED).map((line, i) => (i === 0 ? line : `  ${line}`)),
    );
    expect(open.links.map(({ text, href }) => [text, href])).toEqual(
      linksOf(PICTURED),
    );
    expect(
      (await (await mountRow($)).find({ type: "Button" }))?.props,
    ).toMatchObject({ label: "less" });
    // The idle asking reads it open too.
    const before = seen.asks;
    await clock.advance(IDLE_MS);
    expect(seen.asks).toBeGreaterThan(before);
    expect(seen.statusBodies.at(-1)).toMatchObject({ expanded: true });

    await press($, "less");
    await clock.settle();
    expect((await drawn($)).lines).toEqual([
      "devcorner · 2 waiting on you · overnight dc-o3@acme: Working (lands)",
    ]);
    const closed = seen.asks;
    await clock.advance(IDLE_MS);
    expect(seen.asks).toBeGreaterThan(closed);
    expect("expanded" in seen.statusBodies.at(-1)!).toBe(false);
  });

  test("/dc asks for the picture and says the open block, the row closed or not", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = PICTURED;
    await $.session.start(START);
    await clock.settle();
    const out = await $.command.run({ command: "dc", args: "" });
    expect(seen.statusBodies.at(-1)).toMatchObject({ expanded: true });
    expect(out).toMatchObject({ text: dcText(PICTURED) });
    // The row itself stays closed.
    expect((await drawn($)).lines).toHaveLength(1);
  });

  test("/dc more and /dc less open and close the row as its button does, for a terminal that passes no click (dc-t225)", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = WHOLE;
    await $.session.start(START);
    await clock.settle();
    seen.answer = PICTURED;
    const asked = seen.asks;
    expect(await $.command.run({ command: "dc", args: " more " })).toEqual({
      text: OPEN_LINE,
    });
    await clock.settle();
    // Opened, it asks for the picture at once, as the button does.
    expect(seen.asks).toBe(asked + 1);
    expect(seen.statusBodies.at(-1)).toMatchObject({ expanded: true });
    expect((await drawn($)).lines).toEqual(
      lines(PICTURED).map((line, i) => (i === 0 ? line : `  ${line}`)),
    );
    expect(
      (await (await mountRow($)).find({ type: "Button" }))?.props,
    ).toMatchObject({ label: "less" });

    // Opened by the command, the button closes it; less after it keeps it so.
    await press($, "less");
    await clock.settle();
    expect((await drawn($)).lines).toHaveLength(1);
    expect(await $.command.run({ command: "dc", args: "less" })).toEqual({
      text: CLOSED_LINE,
    });
    expect((await drawn($)).lines).toHaveLength(1);

    // Opened by the button, the command closes it, and asks nothing. The row
    // already on screen is drawn again: the write alone redraws its readers.
    await press($, "more");
    await clock.settle();
    const shown = await mountRow($);
    expect((await shown.find({ type: "Button" }))?.props).toMatchObject({
      label: "less",
    });
    const open = seen.asks;
    expect(await $.command.run({ command: "dc", args: "less" })).toEqual({
      text: CLOSED_LINE,
    });
    await clock.settle();
    expect(seen.asks).toBe(open);
    expect((await shown.find({ type: "Button" }))?.props).toMatchObject({
      label: "more",
    });
    expect(seen.submitted).toEqual([]);
  });
});

describe("while devcorner is updating, after a deploy", () => {
  test("the row says so, and devcorner is asked again when it said, with no failure counted", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "updating";
    await $.session.start(START);
    await clock.settle();
    expect(await row($)).toBe(`● ${UPDATING_LINE}`);
    const asked = seen.asks;
    await clock.advance(5_000 - 1);
    expect(seen.asks).toBe(asked);
    await clock.advance(1);
    expect(seen.asks).toBe(asked + 1);
    // Still updating: the same wait again, not a failure's doubling minute.
    await clock.advance(5_000);
    expect(seen.asks).toBe(asked + 2);
    // Back: the row is devcorner's own again, and the conversation wakes as
    // it would have.
    seen.answer = waiting(1, "dc-m3");
    await clock.advance(5_000);
    expect(await row($)).not.toContain(UPDATING_LINE);
    expect(seen.submitted).toEqual([WAKE()]);
  });

  test("while a turn runs, which asks nothing, the row stops saying so once the wait and a grace have passed", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "updating";
    await $.session.start(START);
    await clock.settle();
    await $.turn.start({ text: "x", turnId: "t1" });
    const asked = seen.asks;
    await clock.advance(5_000 + UPDATING_GRACE_MS - 1);
    expect(await row($)).toBe(`● ${UPDATING_LINE}`);
    await clock.advance(1);
    expect(await row($)).not.toContain(UPDATING_LINE);
    expect(seen.asks).toBe(asked);
  });

  test("a held request answered so waits the time named, then asks Status before holding again", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    seen.waitUpdating = true;
    await $.session.start(START);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);
    expect(await row($)).toBe(`● ${UPDATING_LINE}`);
    const asked = seen.asks;
    await clock.advance(5_000 - 1);
    expect(seen.asks).toBe(asked);
    expect(seen.waitBodies).toHaveLength(1);
    seen.waitUpdating = false;
    await clock.advance(1);
    await flush(clock);
    expect(seen.asks).toBe(asked + 1);
    expect(await row($)).not.toContain(UPDATING_LINE);
    expect(seen.waitBodies).toHaveLength(2);
  });
});

/** Lets pending promises (a released held request and what follows) run. */
const flush = async (clock: { settle: () => Promise<void> }) => {
  for (let i = 0; i < 5; i++) await clock.settle();
};

describe("the held request", () => {
  const wake = (id: string) => JSON.stringify({ wake: "dc-s7", id });

  test("wakes through the held request, once for each message, passing the cursor", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    // One request is open, with no cursor, and no Status poll runs beside it.
    expect(seen.waitBodies).toEqual([
      {
        hook_event_name: "Wait",
        session_id: "conversation-1",
        timeout: HOLD_MS,
      },
    ]);
    const atStart = seen.asks;
    await clock.advance(5 * IDLE_MS);
    expect(seen.asks).toBe(atStart);

    // The held request says a message woke it; Status, asked at once, says
    // it is still unread, and names it.
    seen.answer = waiting(1, "dc-m3");
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.asks).toBe(atStart + 1);
    expect(seen.submitted).toEqual([WAKE()]);
    expect(seen.toasts).toEqual(["dc: a message woke dc-s7"]);
    // No held request until the turn it started begins and ends.
    expect(seen.waitBodies).toHaveLength(1);
    await $.turn.start({ text: WAKE(), turnId: "t1" });
    await $.turn.complete(done("t1"));
    await flush(clock);
    // The next Wait carries the id as its cursor.
    expect(seen.waitBodies).toHaveLength(2);
    expect(seen.waitBodies[1]).toMatchObject({ cursor: "dc-m3" });

    // The same id again does not wake a second time.
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toHaveLength(1);

    // A new message does.
    await $.turn.start({ text: "x", turnId: "t2" });
    await $.turn.complete(done("t2"));
    await flush(clock);
    // The same id answered at once: the held request rests, and a turn's end does not reopen it.
    expect(seen.waitBodies).toHaveLength(2);
    await clock.advance(WAIT_RETRY_MS);
    await flush(clock);
    seen.answer = waiting(2, "dc-m4");
    seen.held.pop()!(wake("dc-m4"));
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE(), WAKE(2)]);
  });

  test("wakes only while the message is unread: one a hook handed over already wakes nothing (dc-t204)", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    // The held request heard of dc-m3, but a prompt's hook handed it over
    // since: Status counts nothing that wakes the session.
    seen.answer = waiting(0, null);
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toEqual([]);
    expect(seen.toasts).toEqual([]);
    // It holds again, for what comes next.
    expect(seen.waitBodies).toHaveLength(2);
  });

  test("no second wake before the first one's turn begins, which hands over what came meanwhile (dc-t204)", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    seen.answer = waiting(1, "dc-m3");
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE()]);
    // A second message comes before the wake's turn has begun: the poll
    // asks, and wakes nothing more.
    seen.answer = waiting(2, "dc-m4");
    await clock.advance(WAITING_MS);
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([WAKE()]);
    // The turn begins, and its prompt hook hands both over: its end finds
    // nothing that wakes the session.
    await $.turn.start({ text: WAKE(), turnId: "t1" });
    seen.answer = waiting(0, null);
    await $.turn.complete(done("t1"));
    await flush(clock);
    await clock.advance(IDLE_MS);
    expect(seen.submitted).toEqual([WAKE()]);
    // A wake whose turn never began does not hold the next one back for ever.
    seen.answer = waiting(1, "dc-m5");
    seen.held.pop()!(wake("dc-m5"));
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE(), WAKE()]);
    seen.answer = waiting(2, "dc-m6");
    await clock.advance(WAKE_SETTLE_MS);
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE(), WAKE(), WAKE(2)]);
  });

  test("the held request stays closed until a wake's turn begins, while its message is still unread (dc-t204)", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    seen.answer = waiting(1, "dc-m3");
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE()]);
    // The turn is slow to begin: the poll asks, finds dc-m3 still waiting,
    // and opens no held request, which would hand back what comes meanwhile.
    await clock.advance(WAITING_MS);
    await flush(clock);
    await clock.advance(WAITING_MS);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);
    // Once the turn has begun and ended, it holds again.
    await $.turn.start({ text: WAKE(), turnId: "t1" });
    seen.answer = waiting(0, null);
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(2);
  });

  test("a timeout re-issues the request; quick empty answers fall back to the poll", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    // The mock clock does not move, so every {} is quick.
    for (let i = 0; i < QUICK_MAX - 1; i++) {
      seen.held.shift()!("{}");
      await flush(clock);
    }
    expect(seen.waitBodies).toHaveLength(QUICK_MAX);
    const waits = seen.waitBodies.length;
    seen.held.shift()!("{}");
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(waits);
    const asks = seen.asks;
    await clock.advance(WAITING_MS);
    expect(seen.asks).toBe(asks + 1);
  });

  test("a slow timeout simply asks again", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    for (let i = 0; i < 2 * QUICK_MAX; i++) {
      await clock.advance(50_000);
      seen.held.shift()!("{}");
      await flush(clock);
    }
    expect(seen.waitBodies).toHaveLength(2 * QUICK_MAX + 1);
  });

  for (const text of ["not json", '{"session":null}', "[]"]) {
    test(`falls back to the Status poll on an answer of ${text}`, async ($, on) => {
      const { clock, seen } = world(on, { hold: true });
      await $.session.start(START);
      await flush(clock);
      seen.held.shift()!(text);
      await flush(clock);
      seen.answer = waiting(1, "dc-m3");
      // A failed hold counts as a failed ask: the poll waits the backoff.
      await clock.advance(DOWN_MS);
      expect(seen.submitted).toEqual([WAKE()]);
    });
  }

  test("falls back to the Status poll when the request is refused", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);
    // A refusal counts as a failed ask: the poll waits the backoff.
    seen.answer = waiting(1, "dc-m3");
    await clock.advance(DOWN_MS);
    expect(seen.submitted).toEqual([WAKE()]);
    // And a poll does not open another request for a while.
    await clock.advance(WAITING_MS);
    expect(seen.waitBodies).toHaveLength(1);
  });

  test("a turn start abandons the open request; its answer wakes nothing", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    await $.turn.start({ text: "work", turnId: "t1" });
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toEqual([]);
    expect(seen.waitBodies).toHaveLength(1);
    // Its end opens a new one.
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(2);
  });

  test("a draft in the prompt box defers the wake to the poll", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    seen.draft = "half a thought";
    seen.answer = waiting(1, "dc-m3");
    seen.held.shift()!(wake("dc-m3"));
    await flush(clock);
    expect(seen.submitted).toEqual([]);
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([]);
    seen.draft = "";
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual([WAKE()]);
  });

  test("makes no request with no token", async ($, on) => {
    const { clock, seen } = world(on, { token: false, hold: true });
    await $.session.start(START);
    await flush(clock);
    expect(seen.held).toHaveLength(0);
    expect(seen.submitted).toEqual([]);
  });
  test("a conversation that works as no session makes no Wait request", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    seen.answer = base;
    await $.session.start(START);
    await flush(clock);
    await $.turn.start({ text: "x", turnId: "t1" });
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.waitBodies).toEqual([]);
  });

  test("a failed hold backs off: no Wait or extra Status at each turn end", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);
    const asks = seen.asks;
    for (const id of ["t1", "t2", "t3"]) {
      await $.turn.start({ text: "x", turnId: id });
      await $.turn.complete(done(id));
      await flush(clock);
    }
    expect(seen.waitBodies).toHaveLength(1);
    expect(seen.asks).toBe(asks);
    // The poll waits the backoff, not 15 s, and a held request waits for its retry time.
    await clock.advance(DOWN_MS);
    expect(seen.asks).toBe(asks + 1);
    expect(seen.waitBodies).toHaveLength(1);
  });
});

test("capacity body keeps the two windows and nothing else", () => {
  expect(
    capacityBody([
      {
        kind: "five_hour",
        percentUsed: 23.5,
        resetsAt: "2026-10-08T15:00:00Z",
      },
      { kind: "seven_day", percentUsed: 80 },
      { kind: "spend_limit", percentUsed: 5 },
    ]),
  ).toEqual({
    five_hour: { used_percentage: 23.5, resets_at: 1791471600 },
    seven_day: { used_percentage: 80 },
  });
  expect(capacityBody([{ kind: "spend_limit", percentUsed: 1 }])).toBe(null);
});

describe("capacity readings", () => {
  const reading = (percentUsed: number) => ({
    changed: ["rateLimits"],
    rateLimits: [{ kind: "seven_day", percentUsed }],
  });

  test("a reading inside the throttle is kept and sent when it opens", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    await ($.session as any).measure(reading(10));
    await flush(clock);
    expect(seen.capacity).toHaveLength(1);
    // Two more inside the 30 s: only the latest is sent, once, when it opens.
    await ($.session as any).measure(reading(11));
    await ($.session as any).measure(reading(12));
    await flush(clock);
    expect(seen.capacity).toHaveLength(1);
    await clock.advance(31_000);
    expect(seen.capacity).toHaveLength(2);
    expect(
      (seen.capacity[1]!.rate_limits as any).seven_day.used_percentage,
    ).toBe(12);
  });
});

describe("a cloud session's reading rides on its devcorner calls, with no token (dc-t221)", () => {
  const RESETS = "2026-10-14T14:00:00.000Z";
  const WEEK = "2026-10-21T01:00:00.000Z";
  const limits = (five: number, seven: number) => [
    { kind: "five_hour", percentUsed: five, resetsAt: RESETS },
    { kind: "seven_day", percentUsed: seven, resetsAt: WEEK },
    { kind: "spend_limit", percentUsed: 1 },
  ];
  /** The calls that reached the tools, as they went out; `failing` answers them with an error. */
  const tools = (on: On) => {
    const got = {
      calls: [] as Record<string, unknown>[],
      failing: false,
      /** A permission check refuses any call that carries a reading. */
      refusing: false,
      /** While set, a call waits until the test lets it answer. */
      held: null as Promise<void> | null,
    };
    on("tool.call", async (_$, e) => {
      got.calls.push({ ...e });
      if (got.held) await got.held;
      if (got.refusing && "capacity" in e) return { deny: "Auto-Mode Bypass" };
      return got.failing
        ? { isError: true as const, result: "refused" }
        : { result: "ok" };
    });
    return got;
  };
  /** The five-hour percent each call carried, or null for none. */
  const carried = (got: { calls: Record<string, unknown>[] }) =>
    got.calls.map((c) => (c.capacity as any)?.five_hour?.percent ?? null);

  test("holds each window's percent and reset time and when they were read, nothing else", () => {
    expect(capacityReading(limits(4, 1), Date.parse(RESETS))).toEqual({
      five_hour: { percent: 4, resets_at: RESETS },
      seven_day: { percent: 1, resets_at: WEEK },
      read_at: RESETS,
    });
    expect(capacityReading([{ kind: "spend_limit", percentUsed: 3 }], 0)).toBe(
      null,
    );
  });

  test("a reading is due ten minutes on, or sooner when a window moved five points or crossed 80% or 95%", () => {
    const at = (ms: number, five: number, seven = 20) =>
      capacityReading(limits(five, seven), ms)!;
    expect(capacityDue(null, at(0, 4))).toBe(true);
    expect(capacityDue(at(0, 10), at(60_000, 14))).toBe(false);
    expect(capacityDue(at(0, 10), at(60_000, 15))).toBe(true);
    expect(capacityDue(at(0, 10), at(DUE_EVERY_MS, 10))).toBe(true);
    expect(capacityDue(at(0, 78), at(60_000, 81))).toBe(true);
    expect(capacityDue(at(0, 10, 94), at(60_000, 10, 96))).toBe(true);
    expect(capacityDue(at(60_000, 10), at(0, 40))).toBe(false);
    expect(DUE_POINTS).toBe(5);
    expect(DUE_THRESHOLDS).toEqual([80, 95]);
  });

  test("the calls that carry it are devcorner's start, check, note, finish and usage, by the connector's name or the plugin's", () => {
    for (const tool of [
      "mcp__Devcorner__start",
      "mcp__devcorner__check",
      "mcp__plugin_devcorner_devcorner__note",
      "mcp__claude_ai_devcorner__finish",
      "mcp__devcorner-app__usage",
    ]) {
      expect(CARRIER.test(tool)).toBe(true);
    }
    for (const tool of [
      "mcp__Devcorner__show",
      "mcp__linear__start",
      "mcp__github__check",
      "mcp__Devcorner__start_x",
      "Bash",
    ]) {
      expect(CARRIER.test(tool)).toBe(false);
    }
  });

  test("a devcorner call carries a reading that is due; nothing is posted and no file is written", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      remote: true,
      home: "/home/ann",
    });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__start", goal: "Work" });
    expect(got.calls[0]).toEqual({
      tool: "mcp__Devcorner__start",
      tool_use_id: expect.any(String),
      goal: "Work",
      capacity: {
        five_hour: { percent: 4, resets_at: RESETS },
        seven_day: { percent: 1, resets_at: WEEK },
        read_at: new Date(1_000_000).toISOString(),
      },
    });
    // Three points on, a minute later: not due, so the call goes as made.
    await clock.advance(60_000);
    seen.limits = limits(7, 1);
    await $.tool.call({ tool: "mcp__Devcorner__check", session: "dc-s1" });
    expect(got.calls[1]).not.toHaveProperty("capacity");
    // Five points from the last carried: due.
    seen.limits = limits(9, 1);
    await $.tool.call({ tool: "mcp__Devcorner__note", text: "x" });
    // Ten minutes on, whatever moved.
    await clock.advance(DUE_EVERY_MS);
    await $.tool.call({ tool: "mcp__Devcorner__finish", outcome: "done" });
    expect(carried(got)).toEqual([4, null, 9, 9]);
    expect(seen.capacity).toEqual([]);
    expect(seen.writes.filter((w) => !w.path.endsWith(".waiting"))).toEqual([]);
  });

  test("of usage only run_account carries it, and other servers' tools never do", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__linear__start" });
    await $.tool.call({ tool: "mcp__Devcorner__show", id: "dc-t1" });
    await $.tool.call({ tool: "mcp__Devcorner__usage", action: "show" });
    await $.tool.call({ tool: "mcp__Devcorner__usage", action: "run_account" });
    expect(carried(got)).toEqual([null, null, null, 4]);
  });

  test("a reading the agent passed itself is kept as it is", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    const own = { five_hour: { percent: 50 }, read_at: RESETS };
    await $.tool.call({ tool: "mcp__Devcorner__check", capacity: own });
    expect(got.calls[0]!.capacity).toEqual(own);
    // Its own does not count as the plugin's: the next call carries one.
    await $.tool.call({ tool: "mcp__Devcorner__check" });
    expect(carried(got)).toEqual([50, 4]);
  });

  test("a call that failed may not have kept it, so the next one carries it again", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    got.failing = true;
    await $.tool.call({ tool: "mcp__Devcorner__note", text: "x" });
    got.failing = false;
    await $.tool.call({ tool: "mcp__Devcorner__note", text: "y" });
    await $.tool.call({ tool: "mcp__Devcorner__check" });
    expect(carried(got)).toEqual([4, 4, null]);
  });

  test("a call refused for carrying it goes again as the agent made it, and no later call carries one", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    got.refusing = true;
    const ran = await $.tool.call({ tool: "mcp__Devcorner__check" });
    expect(ran.deny).toBe(undefined);
    await clock.advance(DUE_EVERY_MS);
    await $.tool.call({ tool: "mcp__Devcorner__note", text: "x" });
    expect(carried(got)).toEqual([4, null, null]);
  });

  test("a blank capacity of the agent's is no reading, so the plugin's goes", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__check", capacity: " " });
    expect(carried(got)).toEqual([4]);
  });

  test("calls made at once carry one reading between them", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    let land!: () => void;
    got.held = new Promise<void>((resolve) => (land = resolve));
    const both = Promise.all([
      $.tool.call({ tool: "mcp__Devcorner__check" }),
      $.tool.call({ tool: "mcp__Devcorner__note", text: "x" }),
    ]);
    await flush(clock);
    land();
    await both;
    expect(carried(got).filter((p) => p !== null)).toEqual([4]);
  });

  test("a new session's first call carries one, whatever the last session carried", async ($, on) => {
    const { clock, seen } = world(on, { token: false, remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__check" });
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__check" });
    expect(carried(got)).toEqual([4, 4]);
  });

  test("with no windows read yet, the call goes as made", async ($, on) => {
    const { clock } = world(on, { token: false, remote: true });
    const got = tools(on);
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__start", goal: "Work" });
    expect(got.calls[0]).not.toHaveProperty("capacity");
  });

  test("on a machine with no token and no cloud session, no call carries one", async ($, on) => {
    const { clock, seen } = world(on, { token: false });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await ($.session as any).measure({
      changed: ["rateLimits"],
      rateLimits: limits(4, 1),
    });
    await $.tool.call({ tool: "mcp__devcorner__check" });
    await flush(clock);
    expect(carried(got)).toEqual([null]);
    expect(seen.capacity).toEqual([]);
  });

  test("with a token the reading is posted and no call carries one", async ($, on) => {
    const { clock, seen } = world(on, { remote: true });
    const got = tools(on);
    seen.limits = limits(4, 1);
    await $.session.start(START);
    await flush(clock);
    await ($.session as any).measure({
      changed: ["rateLimits"],
      rateLimits: limits(4, 1),
    });
    await $.tool.call({ tool: "mcp__plugin_devcorner_devcorner__check" });
    await flush(clock);
    expect(carried(got)).toEqual([null]);
    expect(seen.capacity).toHaveLength(1);
  });
});

describe("the marker the prompt hooks read (dc-t173)", () => {
  test("says how many wait and when, or that the module cannot tell", () => {
    expect(markerText(2, 1_760_000_000_500)).toBe("2 1760000000\n");
    expect(markerText(0, 5_000)).toBe("0 5\n");
    expect(markerText(null, 5_000)).toBe("unknown 5\n");
  });

  test("is kept beside the hook script's stamps, named from the variables it reads", () => {
    expect(markerFile("abc-1", { home: "/home/ann" })).toBe(
      "/home/ann/.cache/devcorner/waiting/abc-1.waiting",
    );
    expect(markerFile("abc-1", { cache: "/c", home: "/home/ann" })).toBe(
      "/c/devcorner/waiting/abc-1.waiting",
    );
    expect(markerFile("abc-1", { state: "/s", cache: "/c" })).toBe(
      "/s/waiting/abc-1.waiting",
    );
    expect(markerFile("abc-1", {})).toBe(undefined);
    // An id the hook would not read is never a file name.
    expect(markerFile("../x", { home: "/h" })).toBe(undefined);
  });

  test("reads what waits from a Status", () => {
    expect(pendingOf(undefined)).toBe(null);
    expect(pendingOf(base)).toBe(0);
    expect(
      pendingOf({
        ...base,
        session: { id: "dc-s7", ticket: null, pending: 3 },
      }),
    ).toBe(3);
    // A devcorner too old to count them cannot say.
    expect(pendingOf(waiting(0, null))).toBe(null);
  });

  test("is written at each Status, every 30 s while a turn runs, and as a wake arrives", async ($, on) => {
    const { clock, seen } = world(on, { home: "/home/ann" });
    const FILE = "/home/ann/.cache/devcorner/waiting/conversation-1.waiting";
    seen.answer = pending(0);
    await $.session.start(START);
    await clock.settle();
    expect(seen.writes.at(-1)).toEqual({ path: FILE, text: "0 1000\n" });

    // A message that wakes nothing arrives while a turn runs: the module
    // hears of it within 30 s, and the next tool call's hook asks.
    await $.turn.start({ text: "work", turnId: "t1" });
    const before = seen.asks;
    seen.answer = pending(2);
    await clock.advance(30_000);
    expect(seen.asks).toBe(before + 1);
    expect(seen.writes.at(-1)!.text).toBe("2 1030\n");
    await clock.advance(60_000);
    expect(seen.asks).toBe(before + 3);
    expect(seen.submitted).toEqual([]);
  });

  test("says the module cannot tell when devcorner does not answer, so the hooks ask as before", async ($, on) => {
    const { clock, seen } = world(on, { home: "/home/ann" });
    seen.answer = "down";
    await $.session.start(START);
    await clock.settle();
    expect(seen.writes.at(-1)!.text).toBe("unknown 1000\n");
    // A devcorner too old to count them cannot say either.
    seen.answer = waiting(0, null, false);
    await clock.advance(DOWN_MS);
    expect(seen.writes.at(-1)!.text).toMatch(/^unknown /);
  });

  test("a wake from the held request marks a message waiting", async ($, on) => {
    const { clock, seen } = world(on, { hold: true, home: "/home/ann" });
    await $.session.start(START);
    await clock.settle();
    seen.answer = waiting(1, "dc-m9");
    seen.held.shift()!(JSON.stringify({ wake: "dc-s7", id: "dc-m9" }));
    await flush(clock);
    expect(seen.submitted).toEqual([WAKE()]);
    expect(seen.writes.some((w) => w.text.startsWith("1 "))).toBe(true);
  });

  test("with no home to keep it in, nothing is written and a turn asks nothing", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    await $.turn.start({ text: "work", turnId: "t1" });
    const before = seen.asks;
    await clock.advance(5 * IDLE_MS);
    expect(seen.asks).toBe(before);
    expect(seen.writes).toEqual([]);
  });
});

describe("what a review of 0.10.0 found (dc-t179)", () => {
  const FILE = "/home/ann/.cache/devcorner/waiting/conversation-1.waiting";

  test("a plain -p run, which draws nowhere, keeps no marker, so its hooks ask as before", async ($, on) => {
    const { clock, seen } = world(on, { surfaces: 0, home: "/home/ann" });
    seen.answer = pending(0);
    await $.session.start({ ...START, surface: null, isInteractive: false });
    await clock.settle();
    await $.turn.start({ text: "work", turnId: "t1" });
    const atStart = seen.asks;
    await clock.advance(3 * 30_000);
    expect(seen.writes).toEqual([]);
    // And nothing is asked on a timer to keep one.
    expect(seen.asks).toBe(atStart);
  });

  test("a marker kept while something drew the session says unknown once nothing does", async ($, on) => {
    const { clock, seen } = world(on, { home: "/home/ann" });
    seen.answer = pending(0);
    await $.session.start(START);
    await clock.settle();
    expect(seen.writes.at(-1)).toEqual({ path: FILE, text: "0 1000\n" });
    await $.turn.start({ text: "work", turnId: "t1" });
    seen.surfaces = 0;
    await clock.advance(30_000);
    expect(seen.writes.at(-1)).toEqual({ path: FILE, text: "unknown 1030\n" });
    const asked = seen.asks;
    await clock.advance(3 * 30_000);
    expect(seen.asks).toBe(asked);
  });

  test("a turn's end reads Status once, forced, whatever the 30 s throttle says", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    await $.session.start(START);
    await flush(clock);
    await $.turn.start({ text: "work", turnId: "t1" });
    await clock.advance(40_000);
    const before = seen.asks;
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.asks).toBe(before + 1);
    // And again for a turn that ends inside the 30 s.
    await $.turn.start({ text: "more", turnId: "t2" });
    await clock.advance(1_000);
    await $.turn.complete(done("t2"));
    await flush(clock);
    expect(seen.asks).toBe(before + 2);
  });

  test("two reads at once each go by their own answer: a failed poll keeps asking whatever /dc read beside it", async ($, on) => {
    const { clock, seen } = world(on, { home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    // The held request is refused here, so the poll asks in a minute. This
    // time devcorner is down, and the marker's write is slow.
    seen.answer = "down";
    seen.holdWrites = true;
    await clock.advance(DOWN_MS);
    expect(seen.heldWrites).toHaveLength(1);
    // /dc reads Status beside it, and devcorner answers it.
    seen.answer = pending(0);
    seen.holdWrites = false;
    const dc = $.command.run({ command: "dc", args: "" } as never);
    await flush(clock);
    seen.heldWrites.shift()!();
    await flush(clock);
    await dc;
    // The poll's own read failed, so it leaves devcorner alone for the
    // backoff and then asks again: it never takes /dc's answer for its own.
    const asked = seen.asks;
    await clock.advance(backoff(2));
    expect(seen.asks).toBe(asked + 1);
    // The marker holds the later read's word.
    expect(seen.writes.at(-1)!.text).toMatch(/^0 /);
  });

  test("a read that began first and ended last does not write over a later one's count", async ($, on) => {
    const { clock, seen } = world(on, { home: "/home/ann" });
    seen.answer = pending(0);
    await $.session.start(START);
    await flush(clock);
    await $.turn.start({ text: "work", turnId: "t1" });
    seen.holdStatus = true;
    // The turn's refresh reads Status, and /dc reads it after; /dc's answer
    // comes first and counts a message, the first read's after it says none.
    await clock.advance(30_000);
    const dc = $.command.run({ command: "dc", args: "" } as never);
    await flush(clock);
    expect(seen.heldStatus).toHaveLength(2);
    seen.heldStatus.pop()!(pending(1));
    await flush(clock);
    await dc;
    seen.heldStatus.pop()!("updating");
    await flush(clock);
    expect(seen.writes.at(-1)!.text).toMatch(/^1 /);
    // Nor over the row: devcorner answered the later read, so it is not
    // "updating".
    expect(await row($)).not.toContain(UPDATING_LINE);
  });

  test("a plain -p run that resumes a conversation with a marker marks it unknown before its first read comes back", async ($, on) => {
    const { clock, seen } = world(on, { surfaces: 0, home: "/home/ann" });
    // The interactive run before it left a marker that says nothing waits.
    seen.writes.push({ path: FILE, text: "0 1000\n" });
    seen.holdStatus = true;
    await $.session.start({ ...START, surface: null, isInteractive: false });
    await clock.settle();
    expect(seen.heldStatus).toHaveLength(1);
    expect(seen.writes.at(-1)).toEqual({ path: FILE, text: "unknown 1000\n" });
  });

  test("a held request answered after its epoch ended touches nothing", async ($, on) => {
    let gated = false;
    let release = () => {};
    // The next look at the clock waits, as an engine call may.
    const { clock, seen } = world(on, {
      hold: true,
      beforeNow: () => {
        if (!gated) return undefined;
        gated = false;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await $.session.start(START);
    await flush(clock);
    // devcorner answers the held request that it is updating, and a turn
    // starts while the hold reads the time.
    gated = true;
    seen.held.shift()!(HELD_UPDATING);
    await flush(clock);
    await $.turn.start({ text: "work", turnId: "t1" });
    release();
    await flush(clock);
    // The turn's start ended that hold: its answer sets no row, no wait and
    // no timer, so the turn's end asks devcorner at once.
    expect(await row($)).not.toContain(UPDATING_LINE);
    const before = seen.asks;
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.asks).toBe(before + 1);
  });

  test("while the held request waits, nothing writes the marker, so its time ages and the hooks' five-minute fallback asks", async ($, on) => {
    const { clock, seen } = world(on, { hold: true, home: "/home/ann" });
    seen.answer = pending(0);
    await $.session.start(START);
    await flush(clock);
    expect(seen.writes).toEqual([{ path: FILE, text: "0 1000\n" }]);
    for (let i = 0; i < 8; i++) {
      await clock.advance(HOLD_MS);
      seen.held.shift()!("{}");
      await flush(clock);
    }
    // Over six minutes of empty holds, and the marker still says when the
    // module last read Status.
    expect(seen.writes).toEqual([{ path: FILE, text: "0 1000\n" }]);
    expect(seen.waitBodies.length).toBeGreaterThan(8);
  });
});
