import { describe, expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { On } from "claude-code";
import type {
  Status,
  StatusNow,
  StatusOther,
  StatusPaste,
  StatusWait,
  StatusWake,
} from "../types";
import {
  PASTE_USAGE,
  PASTER,
  agoText,
  expiresText,
  pasteNote,
  pasteRead,
  pasteWritten,
  pastesText,
  sizeText,
  DOWN_MS,
  HOLD_MS,
  IDLE_MS,
  MAX_DOWN_MS,
  MAX_UPDATING_MS,
  QUICK_MAX,
  SEND_USAGE,
  UPDATING_GRACE_MS,
  UPDATING_LINE,
  WAIT_RETRY_MS,
  WAITING_MS,
  WAKE_SETTLE_MS,
  wakeLine,
  wakePrompt,
  wakeToast,
  wakeWords,
  pausedLine,
  turnBy,
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
  noticeToast,
  pendingOf,
  readHeld,
  withCursor,
  wokenOf,
  nudgePrompt,
  nudgeSegments,
  remoteOf,
  folderOf,
  rowSegments,
  shortSession,
  cutAtWord,
  dcText,
  nowText,
  sessionsText,
  SESSIONS_SEND,
  WAITS_OLDER,
  WAITS_SHOWN,
  waitItemName,
  waitsText,
  cells,
  LABEL_WIDTH,
  codeKey,
  handedText,
  lineText,
  osName,
  readDeviceCode,
  signedOutText,
  tokenFile,
  tokenKey,
  updatingFor,
  whoText,
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

test("remoteOf passes the remote as git prints it, its host kept for devcorner to fold (dc-t565)", () => {
  expect(remoteOf("git@github.com:acme/shop.git\n")).toBe(
    "git@github.com:acme/shop.git",
  );
  expect(remoteOf("git@bitbucket.org:acme/shop.git\n")).toBe(
    "git@bitbucket.org:acme/shop.git",
  );
  expect(remoteOf("https://gitlab.com/group/sub/repo.git")).toBe(
    "https://gitlab.com/group/sub/repo.git",
  );
  // A token an https remote holds never leaves the machine.
  expect(
    remoteOf("https://x-access-token:ghp_secret@github.com/acme/shop.git"),
  ).toBe("https://github.com/acme/shop.git");
  expect(remoteOf("")).toBe(undefined);
});

test("folderOf tells a remote that is a folder on this machine from one on a host (dc-t565)", () => {
  expect(folderOf("/srv/git/shop.git")).toBe("/srv/git/shop.git");
  expect(folderOf("file:///srv/git/shop.git\n")).toBe("/srv/git/shop.git");
  expect(folderOf("/Users/me/My Repos/shop.git\n")).toBe(
    "/Users/me/My Repos/shop.git",
  );
  expect(folderOf("C:\\code\\shop")).toBe("C:\\code\\shop");
  // A relative folder is read by git from the repo's top folder: not followed.
  expect(folderOf("../shop")).toBe(undefined);
  expect(folderOf("git@bitbucket.org:acme/shop.git")).toBe(undefined);
  expect(folderOf("https://gitlab.com/group/sub/repo.git")).toBe(undefined);
});

describe("a remote that is a folder (dc-t565)", () => {
  test("is followed to the remote its repo came from, which Status sends", async ($, on) => {
    const { clock, seen } = world(on);
    seen.origins = {
      "": "/srv/mirror/shop.git",
      "/srv/mirror/shop.git": "file:///srv/My Mirrors/upstream.git",
      "/srv/My Mirrors/upstream.git": "git@bitbucket.org:acme/shop.git",
    };
    await $.session.start(START);
    await clock.settle();
    expect(seen.statusBodies.at(-1)).toMatchObject({
      repo: "git@bitbucket.org:acme/shop.git",
    });
  });

  const unreached: [string, Record<string, string | null>][] = [
    ["a folder with no remote", { "/srv/mirror/shop.git": null }],
    ["a relative folder", { "/srv/mirror/shop.git": "../upstream" }],
    [
      "more folders than it follows",
      {
        "/srv/mirror/shop.git": "/srv/a.git",
        "/srv/a.git": "/srv/b.git",
        "/srv/b.git": "/srv/c.git",
        "/srv/c.git": "git@bitbucket.org:acme/shop.git",
      },
    ],
  ];
  for (const [why, origins] of unreached) {
    test(`names no repo when no remote on a host is reached: ${why}`, async ($, on) => {
      const { clock, seen } = world(on);
      seen.origins = { "": "/srv/mirror/shop.git", ...origins };
      await $.session.start(START);
      await clock.settle();
      expect(seen.statusBodies).toEqual([]);
    });
  }
});

/** The row above the prompt as it reads, links or not: whole, or laid out in `columns` cells (dc-t533). */
const row = (s: Status, columns?: number) => lineText(rowSegments(s, columns));

/** What the row draws before its words, in the same cells. */
const BULLET = "● ";

/** The pages /dc ends with, one a line, after the picture. */
const PAGE_LINE = /^(?:project home|active actions|in flight|paste|board): /;

/** /dc's picture as its lines read: after the repo's line, up to the pages it ends with. */
const lines = (s: Status, time?: number) => {
  const said = dcText(s, time).split("\n").slice(1);
  const pages = said.findIndex((line) => PAGE_LINE.test(line));
  return pages === -1 ? said : said.slice(0, pages);
};

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
/** A closed read from today's devcorner, which says the work in flight on every read (dc-t508). */
const MOVING: Status = { ...WHOLE, inFlight: PICTURE.inFlight };

/** A title longer than a line has room for. */
const TITLE =
  "For you: set up your Claude Code routines on this machine before the next run starts";

/** The busy row's work in flight, which devcorner says on every read (dc-t508) and in the picture /dc says. */
const BUSY_FLIGHT = { count: 7, sessions: 4, runs: 1, pulls: 1, night: true };

/**
 * A busy row, as dc-t313's canvas draws it: a named session on a ticket,
 * what is moving, an OA with its tasks, two cloud sessions, long titles, and
 * Next's first the same ticket as what waits first.
 */
const BUSY: Status = {
  ...base,
  workspace: { slug: "devcorner-app", name: "devcorner app" },
  project: { slug: "web", name: "Web" },
  projects: 1,
  session: { id: "dc-s1797", ticket: "dc-t313" },
  thisConversation: { id: "me-h3", name: "reviewer" },
  waiting: 25,
  inFlight: BUSY_FLIGHT,
  next: { id: "dc-t205", title: TITLE },
  links: LINKS,
  overnight: { ...NIGHT, id: "dc-o3", tasks: "2/7 landed", waits: 1 },
  expanded: {
    firstWaiting: {
      id: "dc-t205",
      title: TITLE,
      page: "https://dc.test/t/dc-t205",
    },
    inFlight: BUSY_FLIGHT,
    cloud: [
      {
        id: "dc-s1124",
        page: "https://dc.test/s/dc-s1124",
        routine: "Routine Tryzens (Max)",
        held: "0 of 5 runs",
        workers: 1,
      },
      {
        id: "dc-s972",
        page: "https://dc.test/s/dc-s972",
        routine: "Routine Ivo icloud (Max)",
        held: "0 of 5 runs",
        workers: 0,
      },
    ],
    next: [
      { id: "dc-t205", title: TITLE, page: "https://dc.test/t/dc-t205" },
      {
        id: "dc-t65",
        title: "Item keys: 4 replies: tools, briefings and the rest of it",
        page: "https://dc.test/t/dc-t65",
      },
      {
        id: "dc-t133",
        title: "Pull requests still carry AI attribution after the merge",
        page: "https://dc.test/t/dc-t133",
      },
    ],
    code: "main at 781bbcd · deployed 781bbcd 3 h ago · main's head is live",
  },
};

describe("the row above the prompt: one line of links, and nothing to press (dc-t533)", () => {
  test("says devcorner, linked to the project's home, the session's short id, linked to its page, and what waits, linked to the inbox", () => {
    expect(row(WHOLE)).toBe("devcorner · s7 · waiting 2");
    expect(rowSegments(WHOLE).filter(({ href }) => href)).toEqual([
      { text: "devcorner", href: LINKS.project },
      { text: "s7", href: LINKS.session },
      { text: "waiting 2", href: LINKS.inbox },
    ]);
    // A repo in no project: devcorner opens the workspace's place, or
    // Personal's for a repo in none.
    const personal = {
      ...LINKS,
      place: "https://dc.test/personal",
      project: null,
    };
    expect(rowSegments({ ...WHOLE, links: personal })[0]).toEqual({
      text: "devcorner",
      href: "https://dc.test/personal",
    });
  });

  test("the conversation's name follows the short id as the session's label, in plain words", () => {
    expect(row(BUSY)).toBe("devcorner · s1797 reviewer · waiting 25");
    expect(
      rowSegments(BUSY)
        .filter(({ href }) => !href)
        .map(({ text }) => text),
    ).toEqual([" · ", " reviewer", " · "]);
    // No name, or a devcorner that names no conversation: the id alone.
    expect(
      row({ ...BUSY, thisConversation: { id: "me-h3", name: null } }),
    ).toBe("devcorner · s1797 · waiting 25");
    expect(row({ ...BUSY, thisConversation: null })).toBe(
      "devcorner · s1797 · waiting 25",
    );
    // A name is said on one line: a newline, a tab or an escape in it is a
    // space.
    expect(
      row({
        ...BUSY,
        thisConversation: {
          id: "me-h3",
          name: "re\nviews\tthe \u001b[31mrow  ",
        },
      }),
    ).toBe("devcorner · s1797 re views the [31mrow · waiting 25");
  });

  test("says waiting N only while something waits, 2+ or ? with a part of devcorner unread (dc-t137)", () => {
    expect(row({ ...WHOLE, waiting: 0 })).toBe("devcorner · s7");
    const why =
      "devcorner could not read your usage alerts (registry down), so it is left out here.";
    const partial = { ...WHOLE, couldNotRead: [why] };
    expect(row(partial)).toBe("devcorner · s7 · waiting 2+");
    expect(row({ ...partial, waiting: 0 })).toBe("devcorner · s7 · waiting ?");
    expect(rowSegments(partial).at(-1)).toEqual({
      text: "waiting 2+",
      href: LINKS.inbox,
    });
    expect(row({ ...WHOLE, couldNotRead: [] })).toBe(row(WHOLE));
    // /dc says the count the same way, and why, in devcorner's words.
    expect(lines(partial)[1]).toBe(
      "Project home · Active actions: 2+ · In flight",
    );
    expect(dcText(partial).split("\n")).toContain(why);
  });

  test("with no session there is no id and no label, whatever the conversation is named", () => {
    expect(row({ ...WHOLE, session: null })).toBe("devcorner · waiting 2");
    expect(
      row({ ...base, thisConversation: { id: "dc-h4", name: "builder" } }),
    ).toBe("devcorner");
  });

  test("the short id is the session's s and its number, in every store's form", () => {
    expect(shortSession("dc-s7@acme")).toBe("s7");
    expect(shortSession("dc-s1797")).toBe("s1797");
    expect(shortSession("dc-s1797@devcorner-app")).toBe("s1797");
    expect(shortSession("acme-s7")).toBe("s7");
    expect(shortSession("me-s4")).toBe("s4");
    // An id of another shape loses only its store's tail.
    expect(shortSession("dc-h3@acme")).toBe("dc-h3");
    expect(shortSession("s7x")).toBe("s7x");
  });

  test("an older devcorner, which names no pages, gives the same words with no links", () => {
    expect(rowSegments(OLDER).some(({ href }) => href)).toBe(false);
    expect(row(OLDER)).toBe(row(WHOLE));
  });

  test("says nothing else: no OA, nothing moving or waiting elsewhere, no paste, no pause, no other session", () => {
    const everything: Status = {
      ...BUSY,
      waitingElsewhere: 3,
      overnight: { ...NIGHT, room: "waits for room until 01:00 18 Oct (UTC)" },
      paste: {
        id: "me-p14",
        title: "Reply to the reviewer",
        length: 1240,
        createdAt: 0,
        expiresAt: 1,
        count: 2,
        page: "https://dc.test/p/me-p14",
      },
      paused: { with: "me-h4", wakes: 4 },
      others: {
        count: 1,
        items: [
          {
            id: "dc-s4",
            page: "https://dc.test/s/dc-s4",
            conversation: "dc-h5",
            name: "builder",
            repo: "a/b",
            ticket: null,
            state: "idle 2 h",
          },
        ],
      },
    };
    expect(row(everything)).toBe(row(BUSY));
    expect(
      rowSegments(everything)
        .filter(({ href }) => href)
        .map(({ href }) => href),
    ).toEqual([LINKS.project, LINKS.session, LINKS.inbox]);
  });

  test("laid out in the cells Claude Code gives it, the label is cut at a word, else left out, so the line never wraps; nothing else is cut", () => {
    const long: Status = {
      ...BUSY,
      thisConversation: { id: "me-h3", name: "reviews the row layout" },
    };
    const whole = "devcorner · s1797 reviews the row layout · waiting 25";
    expect(row(long)).toBe(whole);
    expect(row(long, 120)).toBe(whole);
    expect(row(long, 55)).toBe(whole);
    expect(row(long, 54)).toBe(
      "devcorner · s1797 reviews the row… · waiting 25",
    );
    expect(row(long, 45)).toBe("devcorner · s1797 reviews the… · waiting 25");
    expect(row(long, 41)).toBe("devcorner · s1797 reviews… · waiting 25");
    expect(row(long, 40)).toBe("devcorner · s1797 · waiting 25");
    // Narrower than its links, the row keeps them whole: only the label
    // gives way.
    expect(row(long, 20)).toBe("devcorner · s1797 · waiting 25");
    const label = " reviews the row layout";
    const fixed = cells(BULLET + row({ ...long, thisConversation: null }));
    for (let columns = fixed; columns <= 160; columns++) {
      const line = row(long, columns);
      expect(cells(BULLET + line)).toBeLessThanOrEqual(columns);
      // The label whole, the start of it up to a word's end with "…", or none.
      const said = line.slice(
        "devcorner · s1797".length,
        -" · waiting 25".length,
      );
      if (said !== "" && said !== label) {
        expect(said.endsWith("…")).toBe(true);
        expect(label.startsWith(said.slice(0, -1))).toBe(true);
        expect(label[said.length - 1]).toBe(" ");
      }
    }
    // Measured in cells: a wide character takes two.
    const wide: Status = {
      ...BUSY,
      thisConversation: { id: "me-h3", name: "設定 the 日本語 routines" },
    };
    expect(row(wide, 50)).toBe(
      "devcorner · s1797 設定 the 日本語… · waiting 25",
    );
    expect(row(wide, 48)).toBe("devcorner · s1797 設定 the… · waiting 25");
    for (let columns = fixed; columns <= 80; columns++) {
      expect(cells(BULLET + row(wide, columns))).toBeLessThanOrEqual(columns);
    }
  });

  test("a wide character takes two cells, and a text is cut at a word by its cells", () => {
    expect(cells("日本")).toBe(4);
    expect(cells("a😀")).toBe(3);
    expect(cells("é")).toBe(1);
    // Emoji drawn as emoji, among the symbols too, and a narrow one a
    // variation selector shows as an emoji.
    expect(cells("✅⭐⚡🀄🆗")).toBe(10);
    expect(cells("❤️")).toBe(2);
    expect(cells("❤")).toBe(1);
    expect(cutAtWord("reviews the row", 15)).toBe("reviews the row");
    expect(cutAtWord("reviews the row", 12)).toBe("reviews the…");
    // The separators before the "…" go with the space.
    expect(cutAtWord("reviews, the row", 9)).toBe("reviews…");
    expect(cutAtWord("reviewing", 5)).toBeNull();
    expect(cutAtWord("日本語 の row", 8)).toBe("日本語…");
  });

  test("in a repo devcorner does not know, it says how to set it up and how to hide this, as commands, devcorner linked as ever", () => {
    const fresh: Status = {
      ...base,
      known: false,
      links: { ...LINKS, project: null },
    };
    expect(lineText(nudgeSegments(fresh))).toBe(
      "devcorner · new project here · /dc setup sets it up · /dc hide hides this",
    );
    expect(nudgeSegments(fresh).filter(({ href }) => href)).toEqual([
      { text: "devcorner", href: LINKS.place },
    ]);
    expect(
      nudgeSegments({ ...base, known: false }).some(({ href }) => href),
    ).toBe(false);
  });
});

describe("/dc: the project's picture as text (dc-t218, dc-t533)", () => {
  /** Every id the busy picture names. */
  const IDS = [
    "dc-s1797",
    "dc-t313",
    "dc-o3",
    "dc-t205",
    "dc-s1124",
    "dc-s972",
    "dc-t65",
    "dc-t133",
  ];
  /** The ids a text names, in any form (dc-t7, acme-t7, dc-t7@acme). */
  const idsIn = (text: string) =>
    text.match(/\b[a-z][a-z0-9]{0,9}-[a-z]\d+(?:@[a-z0-9-]*)?/g) ?? [];
  /** What each line is: the head, the lead, its label, or "+" for one going on from the line above. */
  const kinds = (out: string[]) =>
    out.map((line, i) =>
      i === 0
        ? "head"
        : i === 1
          ? "lead"
          : line.slice(0, LABEL_WIDTH).trim() || "+",
    );

  test("leads with who this is, then Project home, Active actions and In flight, then the details, each under a lower-case label", () => {
    expect(lines(PICTURED)).toEqual([
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 2 · In flight: 6",
      "here    ticket dc-t10@acme",
      "first   dc-t4@acme Decide the name",
      "oa      dc-o3@acme Working (lands), 3 acts, 1 wait on you",
      // The oa line names the OA, so moving does not.
      "moving  3 live sessions · 1 run · 1 pull request",
      "cloud   dc-s9@acme Max · 3 of 5 runs · 2 workers",
      "next    dc-t5@acme Export",
      "        dc-t6@acme Import",
      `code    ${PICTURE.code}`,
    ]);
  });

  test("ends with the pages its lead items open, since a command's answer draws no links", () => {
    expect(dcText(PICTURED).split("\n")).toEqual([
      "repo: a/b",
      ...lines(PICTURED),
      `project home: ${LINKS.project}`,
      `active actions: ${LINKS.inbox}`,
      `in flight: ${LINKS.work}`,
      "board: x",
    ]);
    // A devcorner too old to name the Work tab, or any page, names fewer.
    const { work: _work, ...older } = LINKS;
    expect(
      dcText({ ...WHOLE, links: older })
        .split("\n")
        .slice(-3),
    ).toEqual([
      `project home: ${LINKS.project}`,
      `active actions: ${LINKS.inbox}`,
      "board: x",
    ]);
    expect(
      dcText(OLDER)
        .split("\n")
        .filter((line) => PAGE_LINE.test(line)),
    ).toEqual(["board: x"]);
    expect(lines(OLDER)).toEqual(lines(WHOLE));
    // A repo devcorner does not know says so.
    expect(dcText({ ...base, known: false }).split("\n")[0]).toBe(
      "repo: a/b (new to devcorner)",
    );
  });

  test("Active actions is the row's count, and In flight: 0 says nothing moves, once", () => {
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
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 0 · In flight: 0",
      "here    ticket dc-t10@acme",
    ]);
  });

  test("before the picture is read, or from an older devcorner, it says what the Status gave", () => {
    // Active actions says what waits; the count is not said again.
    expect(lines(WHOLE)).toEqual([
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 2 · In flight",
      "here    ticket dc-t10@acme",
      "next    dc-t5@acme Export",
    ]);
  });

  test("a repo in no workspace is Personal's, and a title is said whole", () => {
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
    // Its id in one column with Next's, dc-t5@acme's width.
    expect(lines(personal)[2]).toBe(
      `first   ${"dc-t1".padEnd(10)} ${"x".repeat(60)}`,
    );
    // Project home opens Personal's place.
    expect(dcText(personal).split("\n")).toContain(
      "project home: https://dc.test/personal",
    );
  });

  test("says what waits in the person's other places after what waits here (dc-t518)", () => {
    const away = { ...WHOLE, waitingElsewhere: 3 };
    expect(lines(away)[1]).toBe(
      "Project home · Active actions: 2 (+3 elsewhere) · In flight",
    );
    expect(lines({ ...away, waiting: 0 })[1]).toBe(
      "Project home · Active actions: 0 (+3 elsewhere) · In flight",
    );
    // None elsewhere, and an older devcorner that says none: as before.
    expect(lines({ ...WHOLE, waitingElsewhere: 0 })).toEqual(lines(WHOLE));
  });

  test("says In flight and what is moving from every read, before its picture is read (dc-t508)", () => {
    expect(lines(MOVING)).toEqual([
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 2 · In flight: 6",
      "here    ticket dc-t10@acme",
      // No oa line names the armed OA, so moving does.
      "moving  3 live sessions · 1 run · 1 pull request · an OA",
      "next    dc-t5@acme Export",
    ]);
    const still = { count: 0, sessions: 0, runs: 0, pulls: 0, night: false };
    expect(lines({ ...MOVING, inFlight: still })).toEqual([
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 2 · In flight: 0",
      "here    ticket dc-t10@acme",
      "next    dc-t5@acme Export",
    ]);
    // With its picture, as from a devcorner that says it there alone.
    expect(lines({ ...PICTURED, inFlight: PICTURE.inFlight })).toEqual(
      lines(PICTURED),
    );
  });

  test("names the OA by its id and how it stands, armed or paused (dc-t248)", () => {
    const tasked = {
      ...WHOLE,
      overnight: { ...NIGHT, tasks: "2/7 landed", waits: 1 },
    };
    const paused = {
      ...WHOLE,
      overnight: {
        ...NIGHT,
        state: "Paused (sends)",
        tasks: "0/3 landed",
        waits: 0,
      },
    };
    expect(lines(tasked)).toContain(
      "oa      dc-o3@acme Working (lands), 2/7 landed, 3 acts, 1 wait on you",
    );
    expect(lines(paused)).toContain(
      "oa      dc-o3@acme Paused (sends), 0/3 landed, 3 acts, 1 wait on you",
    );
    expect(lines({ ...WHOLE, overnight: null })).toEqual(lines(WHOLE));
  });

  test("at its busiest it says every fact once, and every title whole", () => {
    expect(lines(BUSY)).toEqual([
      "devcorner · dc-s1797 reviewer · devcorner app · Web",
      "Project home · Active actions: 25 · In flight: 7",
      "here    ticket dc-t313",
      `first   dc-t205 ${TITLE}`,
      "oa      dc-o3 Working (lands), 2/7 landed, 3 acts, 1 wait on you",
      "moving  4 live sessions · 1 run · 1 pull request",
      "cloud   dc-s1124 Routine Tryzens (Max) · 0 of 5 runs · 1 worker",
      "        dc-s972  Routine Ivo icloud (Max) · 0 of 5 runs · 0 workers",
      "next    dc-t65  Item keys: 4 replies: tools, briefings and the rest of it",
      "        dc-t133 Pull requests still carry AI attribution after the merge",
      "code    main at 781bbcd · deployed 781bbcd 3 h ago · main's head is live",
    ]);
    const text = lines(BUSY).join("\n");
    for (const id of IDS) {
      expect(idsIn(text).filter((found) => found === id)).toHaveLength(1);
    }
    // What waits is counted once, on the lead line, and what moves there too.
    expect(text).not.toContain("waiting on you");
    expect(text.match(/in flight/gi)).toHaveLength(1);
    expect(text).not.toContain("…");
    // The oa line says the OA, so moving does not; with none, moving does.
    expect(lines({ ...BUSY, overnight: null })).toContain(
      "moving  4 live sessions · 1 run · 1 pull request · an OA",
    );
  });

  test("labels are lower case, one a line, in an 8-character column, the value after it", () => {
    expect(LABEL_WIDTH).toBe(8);
    const said = lines(BUSY);
    expect(kinds(said)).toEqual([
      "head",
      "lead",
      "here",
      "first",
      "oa",
      "moving",
      "cloud",
      "+",
      "next",
      "+",
      "code",
    ]);
    for (const line of said.slice(2)) {
      expect(line.slice(0, LABEL_WIDTH)).toMatch(/^(?:[a-z]+ +| +)$/);
      expect(line[LABEL_WIDTH]).not.toBe(" ");
    }
  });

  test("an id column is as wide as its widest id", () => {
    // The shorter cloud session first: padded to the longer.
    const swapped: Status = {
      ...BUSY,
      expanded: {
        ...BUSY.expanded!,
        cloud: [...BUSY.expanded!.cloud].reverse(),
      },
    };
    expect(lines(swapped).filter((line) => line.includes("Routine"))).toEqual([
      "cloud   dc-s972  Routine Ivo icloud (Max) · 0 of 5 runs · 0 workers",
      "        dc-s1124 Routine Tryzens (Max) · 0 of 5 runs · 1 worker",
    ]);
  });

  test("a title is said on one line: a newline, a tab or an escape in it is a space", () => {
    const broken: Status = {
      ...BUSY,
      expanded: {
        ...BUSY.expanded!,
        firstWaiting: {
          ...BUSY.expanded!.firstWaiting!,
          title: "Decide\nthe\tname \u001b[31mnow  ",
        },
      },
    };
    expect(lines(broken)).toContain("first   dc-t205 Decide the name [31mnow");
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
/** What devcorner gives for a code (RFC 8628 §3.2, dc-t224). */
const DEVICE_CODE = {
  device_code: `dcd_${"d".repeat(43)}`,
  user_code: "KQ4F-9XZT",
  verification_uri: "http://dc.test/device",
  verification_uri_complete: "http://dc.test/device?code=KQ4F-9XZT",
  expires_in: 600,
  interval: 5,
};

/** A hook token devcorner made for this machine. */
const machineToken = `dch_${"m".repeat(43)}`;
/** Where the store keeps the token the world's devcorner gave. */
const STORE_KEY = tokenKey("http://dc.test");
/** What the hooks' file holds for it: the token, then the devcorner it is for. */
const HANDED = handedText(machineToken, "http://dc.test");
/** Where the store keeps the code the world's devcorner gave. */
const CODE_KEY = codeKey("http://dc.test");

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
    /** What the plugin's store holds at the start (dc-t224). */
    store?: Record<string, unknown>;
    /** Files there at the start, by path. */
    files?: [string, string][];
    /** The tools the model calls are answered here, into `seen.toolCalls` (dc-t224). */
    tools?: boolean;
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
  // The plugin's own store, which a test reads back (dc-t224).
  const stored = new Map<string, unknown>(Object.entries(options.store ?? {}));
  on("store.get", async (_$, e) => ({ value: stored.get(e.key) }));
  on("store.set", async (_$, e) => {
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("store.delete", async (_$, e) => {
    stored.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", async () => ({ value: [...stored.keys()] }));
  mock.env(on, {
    DEVCORNER_URL: "http://dc.test",
    ...(options.token === false ? {} : { DEVCORNER_TOKEN: "dch_test" }),
    ...(options.home ? { HOME: options.home } : {}),
    ...(options.remote ? { CLAUDE_CODE_REMOTE: "true" } : {}),
  });
  const seen = {
    asks: 0,
    submitted: [] as string[],
    /** Which of them went as the person's own words (`asUser`), in order. */
    asUser: [] as boolean[],
    /** A prompt the plugin submits is refused. */
    submitRefused: false,
    toasts: [] as string[],
    draft: "",
    answer: waiting(0, null) as Status | "down" | "updating" | "refused",
    /** The held request is answered that devcorner is updating. */
    waitUpdating: false,
    waitBodies: [] as Record<string, unknown>[],
    /** What each Status read sent. */
    statusBodies: [] as Record<string, unknown>[],
    /** The branch `git branch --show-current` prints in the folder (dc-t334); empty on a detached head. */
    branch: "main",
    /**
     * What `git remote get-url origin` prints, by the folders its -C args
     * name, joined by a space ("" for the conversation's own); null for none.
     * A folder not named prints the GitHub remote.
     */
    origins: {} as Record<string, string | null>,
    /** Whether devcorner says back the branch a Status said, as it does once it took it. */
    takesBranch: true,
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
    heldStatus: [] as ((
      answer: Status | "down" | "updating" | "refused",
    ) => void)[],
    /** What the hook route's Who answers (dc-t224); null answers 404, as an older devcorner. */
    who: null as Record<string, unknown> | null,
    /** The hook events other than Status, Wait and Capacity that were sent, with the token each carried. */
    events: [] as { name: string; token: string }[],
    /** How SignOut is answered. */
    signOutStatus: 200,
    /** What /auth/device was sent, and how it answers. */
    deviceAsks: [] as Record<string, unknown>[],
    deviceAnswer: DEVICE_CODE as Record<string, unknown> | "down",
    /** How the polls of /auth/device/token are answered, in order; once spent, still pending. */
    polls: [] as { status: number; body: Record<string, unknown> }[],
    pollBodies: [] as Record<string, unknown>[],
    /** The commands run, with what each was given on standard input. */
    runs: [] as { argv: readonly string[]; stdin?: string }[],
    /** Files other than the markers, by path: the token handed to the hooks. */
    files: new Map<string, string>(options.files ?? []),
    /** The token each Status read carried. */
    statusTokens: [] as string[],
    /** A tool the model calls answers with an error. */
    toolRefused: false,
    /** What a tool the model calls answers when it works, as the model reads it. */
    toolText: "done",
    /** The tool calls that reached the tool, as the plugin passed them on. */
    toolCalls: [] as Record<string, unknown>[],
    /** What each Send carried (dc-t312), with its token, and how devcorner answers it. */
    sends: [] as { body: Record<string, unknown>; token: string }[],
    sendAnswer: { status: 200, body: {} as unknown } as
      | { status: number; body: unknown }
      | "down",
    /** What each Name carried (dc-t312, part 5), and how devcorner answers it. */
    names: [] as { body: Record<string, unknown>; token: string }[],
    nameAnswer: { status: 200, body: {} as unknown } as
      | { status: number; body: unknown }
      | "down",
    /** What each Turn carried (dc-t312, part 4), and how devcorner answers it. */
    turns: [] as { body: Record<string, unknown>; token: string }[],
    turnAnswer: { ok: true, cleared: [] } as Record<string, unknown>,
    /** What each Paste and Pastes carried (dc-t490), with its token, and how devcorner answers them. */
    pasteReads: [] as { body: Record<string, unknown>; token: string }[],
    pasteAnswer: { status: 200, body: { paste: null } as unknown } as
      | { status: number; body: unknown }
      | "down",
    pastesAnswer: { status: 200, body: { pastes: [], more: 0 } as unknown } as
      | { status: number; body: unknown }
      | "down",
    /** What was put on a clipboard (dc-t490), and how the copy answers. */
    copies: [] as { text: string; surface?: string }[],
    copyAnswer: { isCopied: true } as
      | { isCopied: true }
      | { isCopied: false; reason: "no-surface" | "no-clipboard" | "refused" },
    /** The lines said in the transcript ($.ui.log). */
    logs: [] as string[],
  };
  const answer401 = {
    value: { status: 401, ok: false, headers: {}, text: "{}" },
  };
  on("fs.write", async (_$, e) => {
    if (seen.holdWrites) {
      await new Promise<void>((resolve) => seen.heldWrites.push(resolve));
    }
    seen.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("fs.exists", async (_$, e) => ({
    value: seen.writes.some((w) => w.path === e.path) || seen.files.has(e.path),
  }));
  on("fs.read", async (_$, e) => {
    const text = seen.files.get(e.path);
    return text === undefined ? { deny: "missing" } : { value: text };
  });
  on("http.fetch", async (_$, e) => {
    const sent = JSON.parse(e.init?.body ?? "{}");
    const reply = (status: number, body: unknown) => ({
      value: {
        status,
        ok: status >= 200 && status < 300,
        headers: {},
        text: JSON.stringify(body),
      },
    });
    if (e.url.endsWith("/auth/device")) {
      seen.deviceAsks.push(sent);
      if (seen.deviceAnswer === "down") return { deny: "unreachable" };
      return reply(200, seen.deviceAnswer);
    }
    if (e.url.endsWith("/auth/device/token")) {
      seen.pollBodies.push(sent);
      const next = seen.polls.shift() ?? {
        status: 400,
        body: { error: "authorization_pending" },
      };
      return reply(next.status, next.body);
    }
    const bearer = String(
      (e.init?.headers as Record<string, string> | undefined)?.Authorization ??
        "",
    ).replace(/^Bearer /, "");
    if (sent.hook_event_name === "Who" || sent.hook_event_name === "SignOut") {
      seen.events.push({ name: sent.hook_event_name, token: bearer });
      if (sent.hook_event_name === "SignOut") {
        // An older devcorner knows no SignOut: 204 and nothing done.
        if (seen.signOutStatus === 204) {
          return { value: { status: 204, ok: true, headers: {}, text: "" } };
        }
        return reply(seen.signOutStatus, { ok: true, revoked: true });
      }
      return seen.who ? reply(200, seen.who) : reply(404, {});
    }
    if (sent.hook_event_name === "Name") {
      seen.names.push({ body: sent, token: bearer });
      if (seen.nameAnswer === "down") return { deny: "unreachable" };
      if (seen.nameAnswer.status === 204) {
        return { value: { status: 204, ok: true, headers: {}, text: "" } };
      }
      return reply(seen.nameAnswer.status, seen.nameAnswer.body);
    }
    if (sent.hook_event_name === "Send") {
      seen.sends.push({ body: sent, token: bearer });
      if (seen.sendAnswer === "down") return { deny: "unreachable" };
      if (seen.sendAnswer.status === 204) {
        return { value: { status: 204, ok: true, headers: {}, text: "" } };
      }
      return reply(seen.sendAnswer.status, seen.sendAnswer.body);
    }
    if (sent.hook_event_name === "Turn") {
      seen.turns.push({ body: sent, token: bearer });
      return reply(200, seen.turnAnswer);
    }
    if (sent.hook_event_name === "Paste" || sent.hook_event_name === "Pastes") {
      seen.pasteReads.push({ body: sent, token: bearer });
      const answer =
        sent.hook_event_name === "Paste" ? seen.pasteAnswer : seen.pastesAnswer;
      if (answer === "down") return { deny: "unreachable" };
      if (answer.status === 204) {
        return { value: { status: 204, ok: true, headers: {}, text: "" } };
      }
      return reply(answer.status, answer.body);
    }
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
    seen.statusTokens.push(bearer);
    const answer = seen.holdStatus
      ? await new Promise<Status | "down" | "updating" | "refused">((resolve) =>
          seen.heldStatus.push(resolve),
        )
      : seen.answer;
    if (answer === "down") return { deny: "unreachable" };
    if (answer === "updating") return { value: UPDATING_ANSWER };
    if (answer === "refused") return answer401;
    // devcorner says back a branch it took (dc-t334), unless a test says not.
    const text = JSON.stringify(
      typeof sent.branch === "string" && seen.takesBranch
        ? { ...answer, branch: sent.branch }
        : answer,
    );
    return { value: { status: 200, ok: true, headers: {}, text } };
  });
  on("process.run", async (_$, e) => {
    seen.runs.push({ argv: e.argv, stdin: e.init?.stdin });
    // The hand-over to the hooks (a shell that writes standard input to its
    // file) and its removal, as the files they leave.
    if (e.argv[0] === "sh") seen.files.set(e.argv[4]!, e.init?.stdin ?? "");
    if (e.argv[0] === "rm") seen.files.delete(e.argv[2]!);
    if (e.argv[0] === "git" && e.argv.at(-1) === "origin") {
      const folders = e.argv.filter((_, i) => e.argv[i - 1] === "-C");
      const origin = seen.origins[folders.join(" ")];
      return {
        value: {
          exitCode: origin === null ? 2 : 0,
          stdout:
            origin === undefined
              ? "git@github.com:acme/shop.git\n"
              : `${origin ?? ""}\n`,
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    }
    const stdout =
      e.argv[0] === "uname"
        ? "Darwin\n"
        : e.argv[0] === "scutil"
          ? "Ann's MacBook Air\n"
          : e.argv[0] === "git" && e.argv[1] === "branch"
            ? `${seen.branch}\n`
            : e.argv[0] === "git"
              ? "git@github.com:acme/shop.git\n"
              : "";
    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("session.id", async () => ({ value: "conversation-1" }));
  on("session.cwd", async () => ({ value: "/work/shop" }));
  on("session.surfaces", async () => ({
    value: seen.surfaces === 0 ? [] : (["terminal"] as const),
  }));
  on("prompt.read", async () => ({
    value: { text: seen.draft, cursor: seen.draft.length },
  }));
  on("prompt.submit", async (_$, e) => {
    if (seen.submitRefused) throw new Error("refused here");
    seen.submitted.push(e.text);
    seen.asUser.push(e.origin.kind === "plugin" && e.origin.asUser === true);
    return { text: e.text };
  });
  on("ui.toast", async (_$, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.copy", async (_$, e) => {
    seen.copies.push({
      text: e.text,
      ...(e.surface ? { surface: e.surface } : {}),
    });
    return { value: seen.copyAnswer };
  });
  on("ui.log", async (_$, e) => {
    seen.logs.push(e.text);
    return { value: undefined };
  });
  on("command.register", async () => ({ value: { command: "dc" } }));
  // A tool the model calls, such as devcorner's workspace over MCP, answered:
  // as done, or as refused (an error the tool reported). Only when a test
  // asks, so one that answers the tools itself is the one that answers.
  if (options.tools) {
    on("tool.call", async (_$, e) => {
      seen.toolCalls.push({ ...e } as Record<string, unknown>);
      return (
        seen.toolRefused
          ? { result: "refused", text: "refused", isError: true }
          : { result: "done", text: seen.toolText }
      ) as never;
    });
  }
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("session.end", async (_$, e) => ({ sessionId: e.sessionId }));
  on("session.measure", async (_$, e) => e);
  // The windows the turn's last answer reported, which a test sets.
  on("session.usage", async () => ({
    value: { rateLimits: seen.limits } as any,
  }));
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async () => ({ text: "" }));
  return { clock, seen, stored };
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

/** The room Claude Code gives the row: its cells across and the rows it may take. */
type Size = { columns: number; rows: number };

/** Draws the row above the prompt on a terminal, as Claude Code does, 120 cells across and 10 rows high unless told otherwise. */
const mountRow = (
  $: Parameters<TestBody>[0],
  size: Size = { columns: 120, rows: 10 },
) =>
  $.ui.mount({
    plugin: "devcorner",
    surface: "terminal",
    component: "AbovePrompt",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: size.rows,
      bodyColumns: size.columns,
      scroll: { offset: 0, bodyRows: size.rows },
      view: {},
    },
  });

/**
 * The row above the prompt, as the terminal draws it now: its text, or ""
 * when the plugin passes the row on with nothing of its own to draw (the
 * test has no engine beneath it to draw one).
 */
async function rowText($: Parameters<TestBody>[0]): Promise<string> {
  const ui = await mountRow($).catch((error: unknown) => {
    if (/no implementation for ui\.render/.test(String(error))) return null;
    throw error;
  });
  return ui === null ? "" : ((await ui.find({ type: "Box" }))?.text ?? "");
}

/** An element as a mounted drawing describes it, or a string of its text; an element given no props has none. */
type Drawn =
  | string
  | { type: string; props?: Record<string, unknown>; children?: Drawn[] };

/**
 * What the row draws now (dc-t533): its dim words after the bullet, as a
 * terminal draws them, each link's words and address, and how many things
 * it has to press, which is none. A link's words are the link's own
 * children, since the harness's `text` of a Link also holds its address.
 */
async function drawn($: Parameters<TestBody>[0], size?: Size) {
  const ui = await mountRow($, size);
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
    line: dim.map((text) => words((text.children ?? []) as Drawn[])).join(""),
    links: dim.flatMap((text) =>
      ((text.children ?? []) as Drawn[]).flatMap((part) =>
        typeof part === "string"
          ? []
          : [{ text: words(part.children ?? []), href: part.props?.href }],
      ),
    ),
    buttons: (await ui.findAll({ type: "Button" })).length,
  };
}

describe("the branch git is on (dc-t334)", () => {
  test("is said on a Status once git has moved since devcorner took it, and on none while it stays", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = waiting(0, null, false);
    // A branch of this test's own, so what an earlier test left taken counts for nothing.
    seen.branch = "feat/first-dc-t334";
    await $.session.start(START);
    await clock.settle();
    expect(seen.statusBodies.at(-1)).toMatchObject({
      hook_event_name: "Status",
      branch: "feat/first-dc-t334",
    });
    expect(seen.runs.map((r) => r.argv.join(" "))).toContain(
      "git branch --show-current",
    );
    // Taken: the next read says none.
    await clock.advance(IDLE_MS);
    expect("branch" in seen.statusBodies.at(-1)!).toBe(false);
    // git moved: said once, with the move.
    seen.branch = "feat/second-dc-t334";
    await clock.advance(IDLE_MS);
    expect(seen.statusBodies.at(-1)).toMatchObject({
      branch: "feat/second-dc-t334",
    });
    await clock.advance(IDLE_MS);
    expect("branch" in seen.statusBodies.at(-1)!).toBe(false);
    // A detached head is on no branch, and says none.
    seen.branch = "";
    await clock.advance(IDLE_MS);
    expect("branch" in seen.statusBodies.at(-1)!).toBe(false);
  });

  test("is said again until devcorner says it took it: after a read that failed, and while it says it back not", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "down";
    seen.branch = "feat/unheard-dc-t334";
    await $.session.start(START);
    await clock.settle();
    expect(seen.statusBodies.at(-1)).toMatchObject({
      branch: "feat/unheard-dc-t334",
    });
    const said = () =>
      seen.statusBodies.filter((body) => body.branch === "feat/unheard-dc-t334")
        .length;
    // Answered, but not taken (a store that is updating, or an older devcorner).
    seen.answer = waiting(0, null, false);
    seen.takesBranch = false;
    await clock.advance(10 * IDLE_MS);
    const untaken = said();
    expect(untaken).toBeGreaterThan(1);
    await clock.advance(IDLE_MS);
    expect(said()).toBeGreaterThan(untaken);
    // Taken: said no more.
    seen.takesBranch = true;
    await clock.advance(IDLE_MS);
    const taken = said();
    await clock.advance(IDLE_MS);
    expect(said()).toBe(taken);
  });

  test("is said by one read at a time: one that overlaps it says none, and the next says where git is then", async ($, on) => {
    const { clock, seen } = world(on);
    const answer = waiting(0, null, false);
    seen.answer = answer;
    seen.holdStatus = true;
    seen.branch = "feat/older-dc-t334";
    await $.session.start(START);
    await flush(clock);
    expect(seen.heldStatus).toHaveLength(1);
    expect(seen.statusBodies.at(-1)).toMatchObject({
      branch: "feat/older-dc-t334",
    });
    // git moves while that read is out, and /dc reads again beside it.
    seen.branch = "feat/newer-dc-t334";
    const dc = $.command.run({ command: "dc", args: "" } as never);
    await flush(clock);
    expect(seen.heldStatus).toHaveLength(2);
    expect("branch" in seen.statusBodies.at(-1)!).toBe(false);
    seen.heldStatus.pop()!(answer);
    await flush(clock);
    await dc;
    seen.heldStatus.pop()!(answer);
    await flush(clock);
    seen.holdStatus = false;
    await clock.advance(IDLE_MS);
    expect(seen.statusBodies.at(-1)).toMatchObject({
      branch: "feat/newer-dc-t334",
    });
  });
});

describe("the row above the prompt, drawn (dc-t533)", () => {
  /** A session that says what wakes it, so the idle asking goes on. */
  const AWAKE = {
    id: "dc-s7@acme",
    ticket: "dc-t10@acme",
    waitingOnPerson: false,
    wakeMessages: 0,
    wakeMessageId: null,
  };
  const said = (out: unknown) => (out as { text: string }).text;

  test("is one line of links, devcorner, the session's short id and what waits, with nothing to press", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = WHOLE;
    await $.session.start(START);
    await clock.settle();
    expect(await drawn($)).toEqual({
      line: "devcorner · s7 · waiting 2",
      links: [
        { text: "devcorner", href: LINKS.project },
        { text: "s7", href: LINKS.session },
        { text: "waiting 2", href: LINKS.inbox },
      ],
      buttons: 0,
    });
    expect(await rowText($)).toStartWith(BULLET);
    // The row's reads ask devcorner for nothing past the row's own.
    expect(seen.statusBodies.length).toBeGreaterThan(0);
    for (const body of seen.statusBodies) {
      expect(body).not.toHaveProperty("expanded");
      expect(body).not.toHaveProperty("now");
      expect(body).not.toHaveProperty("others");
    }
  });

  test("lays the session's label out in the cells Claude Code gives it, so the line never wraps", async ($, on) => {
    const { clock, seen } = world(on);
    const long: Status = {
      ...BUSY,
      thisConversation: { id: "me-h3", name: "reviews the row layout" },
    };
    seen.answer = long;
    await $.session.start(START);
    await clock.settle();
    expect((await drawn($)).line).toBe(
      "devcorner · s1797 reviews the row layout · waiting 25",
    );
    for (const columns of [80, 54, 45, 41, 40]) {
      const { line } = await drawn($, { columns, rows: 1 });
      expect(line).toBe(row(long, columns));
      expect(cells(BULLET + line)).toBeLessThanOrEqual(columns);
    }
  });

  test("draws the same words with no link from a devcorner that names no pages", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = OLDER;
    await $.session.start(START);
    await clock.settle();
    expect(await drawn($)).toEqual({ line: row(WHOLE), links: [], buttons: 0 });
  });

  test("/dc asks for the picture and says it as text, the row as it was; the next read asks for the row's own again", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = { ...PICTURED, session: AWAKE };
    await $.session.start(START);
    await clock.settle();
    const out = await $.command.run({ command: "dc", args: "" });
    expect(seen.statusBodies.at(-1)).toMatchObject({ expanded: true });
    expect(out).toMatchObject({
      text: dcText({ ...PICTURED, session: AWAKE }),
    });
    expect((await drawn($)).line).toBe(row(PICTURED));
    const asked = seen.asks;
    await clock.advance(IDLE_MS);
    expect(seen.asks).toBeGreaterThan(asked);
    expect(seen.statusBodies.at(-1)).not.toHaveProperty("expanded");
  });

  test("/dc with any other words asks devcorner as the person, once the command has answered (dc-t226)", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = WHOLE;
    await $.session.start(START);
    await clock.settle();
    // more and less work no row (dc-t533): they ask, as any other words do.
    // The prompt goes once the command's hook has returned: Claude Code
    // refuses one submitted from inside it, which this file would fail on.
    for (const [args, asked] of [
      ["board", "board"],
      [" what waits on me? ", "what waits on me?"],
      ["more", "more"],
      ["less", "less"],
      ["more please", "more please"],
      ["More", "More"],
    ] as const) {
      const before = seen.submitted.length;
      expect(await $.command.run({ command: "dc", args })).toEqual({
        text: `Asking devcorner: ${asked}`,
      });
      await clock.settle();
      expect(seen.submitted.slice(before)).toEqual([`devcorner: ${asked}`]);
      expect(seen.asUser.slice(before)).toEqual([true]);
    }

    // Refused all the same, it says so, having answered that it asks.
    seen.submitRefused = true;
    expect(await $.command.run({ command: "dc", args: "board" })).toEqual({
      text: "Asking devcorner: board",
    });
    await clock.settle();
    expect(seen.toasts.at(-1)).toStartWith("dc: could not ask devcorner: ");
  });

  test("/dc's ask is not followed by a wake before its turn begins (dc-t226)", async ($, on) => {
    const { clock, seen } = world(on);
    // Its session waits on its person, so devcorner is asked every WAITING_MS.
    seen.answer = waiting(0, null);
    await $.session.start(START);
    await clock.settle();
    // A message comes as the person asks: its turn's prompt hook hands it
    // over, so no wake goes on top of the ask.
    seen.answer = waiting(1, "dc-m3");
    await $.command.run({ command: "dc", args: "board" });
    const asked = seen.asks;
    await clock.advance(WAKE_SETTLE_MS - WAITING_MS);
    expect(seen.asks).toBeGreaterThan(asked);
    expect(seen.submitted).toEqual(["devcorner: board"]);

    // Once that turn has begun and ended, a message still unread wakes it.
    await $.turn.start({ text: "devcorner: board", turnId: "t1" });
    await $.turn.complete(done("t1"));
    await clock.advance(WAITING_MS);
    expect(seen.submitted).toEqual(["devcorner: board", WAKE()]);
  });

  test("in a repo devcorner does not know, the row says /dc setup and /dc hide, and /dc setup asks, as the person, to set it up", async ($, on) => {
    const { clock, seen } = world(on);
    const fresh = { ...base, known: false };
    seen.answer = fresh;
    await $.session.start(START);
    await clock.settle();
    expect(await drawn($)).toEqual({
      line: "devcorner · new project here · /dc setup sets it up · /dc hide hides this",
      links: [],
      buttons: 0,
    });
    expect(await $.command.run({ command: "dc", args: "setup" })).toEqual({
      text: "Asking Claude to set a/b up in devcorner.",
    });
    await clock.settle();
    expect(seen.submitted).toEqual([nudgePrompt(fresh)]);
    expect(seen.asUser).toEqual([true]);
  });

  test("/dc setup in a repo devcorner knows, or with no answer from it, asks nothing", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "down";
    await $.session.start(START);
    await clock.settle();
    expect(said(await $.command.run({ command: "dc", args: "setup" }))).toBe(
      "devcorner at http://dc.test could not be reached.",
    );
    seen.answer = WHOLE;
    expect(await $.command.run({ command: "dc", args: "setup" })).toEqual({
      text: "devcorner knows a/b already.",
    });
    await clock.settle();
    expect(seen.submitted).toEqual([]);
  });

  test("/dc hide stops the row's offer for that repo and keeps it so; /dc setup still asks", async ($, on) => {
    const { clock, seen, stored } = world(on);
    const fresh = { ...base, known: false };
    seen.answer = fresh;
    await $.session.start(START);
    await clock.settle();
    expect(await $.command.run({ command: "dc", args: "hide" })).toEqual({
      text: "The row no longer offers to set a/b up; /dc setup still does.",
    });
    expect(await rowText($)).toBe("");
    expect(stored.get("dismissed")).toEqual(["a/b"]);
    await $.command.run({ command: "dc", args: "setup" });
    await clock.settle();
    expect(seen.submitted).toEqual([nudgePrompt(fresh)]);
    // A repo devcorner knows has nothing to hide.
    seen.answer = WHOLE;
    await $.command.run({ command: "dc", args: "" });
    expect(await $.command.run({ command: "dc", args: "hide" })).toEqual({
      text: "devcorner knows a/b already: there is nothing to hide.",
    });
  });

  test("a repo hidden in an earlier conversation stays hidden", async ($, on) => {
    const { clock, seen } = world(on, { store: { dismissed: ["a/b"] } });
    seen.answer = { ...base, known: false };
    await $.session.start(START);
    await clock.settle();
    expect(await rowText($)).toBe("");
  });
});

describe("what this session is on and did lately: /dc now (dc-t489)", () => {
  /** What devcorner says dc-s7@acme is on and did lately, as it answers a Status that asks (`now: true`). */
  const NOW: StatusNow = {
    id: "dc-s7@acme",
    page: LINKS.session,
    state: "live 3 h",
    ticket: { id: "dc-t10@acme", title: "Export the row", page: LINKS.ticket },
    doing: { text: "Wiring the plugin row", from: "note", when: "5 min ago" },
    lately: [
      { when: "6 min ago", text: "commit a1b2c3d: Status gives the now" },
      { when: "7 min ago", text: "Drew the row" },
    ],
    asked: {
      count: 3,
      items: [
        {
          id: "dc-t10-q3@acme",
          title: "Width",
          page: "https://dc.test/q/dc-t10-q3@acme",
        },
        {
          id: "dc-t10-q2@acme",
          title: "Label",
          page: "https://dc.test/q/dc-t10-q2@acme",
        },
      ],
    },
    runs: {
      count: 1,
      items: [
        {
          id: "dc-r5@acme",
          title: "dc-t8@acme Review the row",
          page: "https://dc.test/r/dc-r5@acme",
          state: "picked up by dc-s9@acme",
        },
      ],
    },
  };
  /** The conversation dc-h3, named reviewer, working as dc-s7@acme, with its now. */
  const NAMED: Status = {
    ...WHOLE,
    thisConversation: { id: "dc-h3", name: "reviewer" },
  };
  const NOWED: Status = { ...NAMED, now: NOW };
  /** A session that says what wakes it, so the idle asking goes on. */
  const AWAKE = {
    id: "dc-s7@acme",
    ticket: "dc-t10@acme",
    waitingOnPerson: false,
    wakeMessages: 0,
    wakeMessageId: null,
  };

  test("says the session's ticket, what it is doing, its last moves, its open questions and its runs out, then the session's page", () => {
    expect(nowText(NOWED).split("\n")).toEqual([
      "devcorner · dc-s7@acme reviewer · live 3 h",
      "on      dc-t10@acme Export the row",
      "doing   Wiring the plugin row · noted 5 min ago",
      "lately  6 min ago  commit a1b2c3d: Status gives the now",
      "        7 min ago  Drew the row",
      "asked   3 open · Width · Label · 1 more",
      "runs    dc-r5@acme dc-t8@acme Review the row · picked up by dc-s9@acme",
      `session page: ${LINKS.session}`,
    ]);
    // A session that noted nothing says its goal; one on no ticket says so;
    // a fact it has none of is left out.
    const quiet: Status = {
      ...NOWED,
      now: {
        ...NOW,
        ticket: null,
        doing: { text: "Build the export", from: "goal", when: "3 h ago" },
        lately: [],
        asked: { count: 0, items: [] },
        runs: { count: 0, items: [] },
      },
    };
    expect(nowText(quiet).split("\n")).toEqual([
      "devcorner · dc-s7@acme reviewer · live 3 h",
      "on      no ticket",
      "doing   Build the export · its goal, no note yet",
      `session page: ${LINKS.session}`,
    ]);
  });

  test("with nothing of the session to say, it says why", () => {
    const why = (s: Status) => nowText(s).split("\n")[1];
    expect(why({ ...NAMED, now: null })).toBe(
      "now     devcorner did not say what this session is on this time",
    );
    // An older devcorner says nothing of it.
    expect(why(NAMED)).toBe(
      "now     this devcorner does not say what a session is on yet",
    );
    expect(why({ ...NAMED, session: null, now: null })).toBe(
      "now     this conversation works as no devcorner session",
    );
    expect(nowText({ ...NAMED, now: null })).not.toContain("session page");
  });

  test("/dc now asks for the session's now and says it as text, the row as it was; with no session it says so, and other words ask devcorner", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = { ...NOWED, session: AWAKE };
    await $.session.start(START);
    await clock.settle();
    expect(await $.command.run({ command: "dc", args: " now " })).toEqual({
      text: nowText({ ...NOWED, session: AWAKE }),
    });
    expect(seen.statusBodies.at(-1)).toMatchObject({ now: true });
    expect("expanded" in seen.statusBodies.at(-1)!).toBe(false);
    expect((await drawn($)).line).toBe("devcorner · s7 reviewer · waiting 2");
    // The row's next read asks for no now.
    const asked = seen.asks;
    await clock.advance(IDLE_MS);
    expect(seen.asks).toBeGreaterThan(asked);
    expect("now" in seen.statusBodies.at(-1)!).toBe(false);

    seen.answer = { ...base, thisConversation: { id: "dc-h4", name: null } };
    expect(
      (
        (await $.command.run({ command: "dc", args: "now" })) as {
          text: string;
        }
      ).text,
    ).toContain("this conversation works as no devcorner session");

    seen.answer = "down";
    expect(
      (
        (await $.command.run({ command: "dc", args: "now" })) as {
          text: string;
        }
      ).text,
    ).toBe("devcorner at http://dc.test could not be reached.");

    expect(await $.command.run({ command: "dc", args: "now please" })).toEqual({
      text: "Asking devcorner: now please",
    });
  });
});

describe("while devcorner is updating, after a deploy", () => {
  test("the row says so, and devcorner is asked again when it said, with no failure counted", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = "updating";
    await $.session.start(START);
    await clock.settle();
    expect(await rowText($)).toBe(`● ${UPDATING_LINE}`);
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
    expect(await rowText($)).not.toContain(UPDATING_LINE);
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
    expect(await rowText($)).toBe(`● ${UPDATING_LINE}`);
    await clock.advance(1);
    expect(await rowText($)).not.toContain(UPDATING_LINE);
    expect(seen.asks).toBe(asked);
  });

  test("a held request answered so waits the time named, then asks Status before holding again", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    seen.waitUpdating = true;
    await $.session.start(START);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);
    expect(await rowText($)).toBe(`● ${UPDATING_LINE}`);
    const asked = seen.asks;
    await clock.advance(5_000 - 1);
    expect(seen.asks).toBe(asked);
    expect(seen.waitBodies).toHaveLength(1);
    seen.waitUpdating = false;
    await clock.advance(1);
    await flush(clock);
    expect(seen.asks).toBe(asked + 1);
    expect(await rowText($)).not.toContain(UPDATING_LINE);
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
    // The next Wait carries the id as its cursor, and as its store's.
    expect(seen.waitBodies).toHaveLength(2);
    expect(seen.waitBodies[1]).toMatchObject({
      cursor: "dc-m3",
      cursors: ["dc-m3"],
    });

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
    expect(await rowText($)).not.toContain(UPDATING_LINE);
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
    expect(await rowText($)).not.toContain(UPDATING_LINE);
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

describe("signing this machine in from Claude Code (dc-t224)", () => {
  const handedFile = "/home/ann/.cache/devcorner/token";
  /** The row's links, as [words, address]. */
  const rowLinks = async ($: Parameters<TestBody>[0]) =>
    (await (await mountRow($)).findAll({ type: "Link" })).map((found) => [
      found.text,
      found.props.href,
    ]);
  const said = (out: unknown) => (out as { text: string }).text;
  /** /dc login, which begins a sign-in: the row has nothing to press (dc-t533). */
  const login = ($: Parameters<TestBody>[0]) =>
    $.command.run({ command: "dc", args: "login" });

  test("with no token the row says to /dc login or ask Claude, has nothing to press, and nothing asks devcorner for a code", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    expect(await rowText($)).toBe(
      "● devcorner · not signed in · /dc login, or ask Claude to sign it in",
    );
    expect((await drawn($)).buttons).toBe(0);
    // No status is asked with no token, and no code until a sign-in begins:
    // not at the start, not as turns end, not as time goes by.
    await $.turn.start({ text: "carry on", turnId: "t1" });
    await $.turn.complete(done("t1"));
    await flush(clock);
    await clock.advance(11 * 60_000);
    await flush(clock);
    expect(seen.asks).toBe(0);
    expect(seen.deviceAsks).toEqual([]);
    expect(seen.pollBodies).toEqual([]);
    expect(stored.get(CODE_KEY)).toBe(undefined);
    expect(seen.writes.map((w) => w.path)).not.toContain(
      "/home/ann/.cache/devcorner/device-id",
    );
  });

  const connectPlugin = (device?: string) =>
    ({
      tool: "mcp__plugin_devcorner_devcorner__workspace",
      action: "connect_plugin",
      ...(device ? { device } : {}),
      agreed: true,
    }) as never;

  test("an agent's connect_plugin sends this machine's own code, shown above the prompt, and the token is collected at once", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    seen.polls.push({
      status: 200,
      body: {
        access_token: machineToken,
        token_type: "Bearer",
        name: "Ann's laptop",
      },
    });
    seen.answer = WHOLE;
    // The agent names no code: the plugin asks devcorner for one and fills it in.
    await $.tool.call(connectPlugin());
    expect(seen.deviceAsks).toHaveLength(1);
    expect(seen.toolCalls).toEqual([
      expect.objectContaining({
        action: "connect_plugin",
        device: "KQ4F-9XZT",
        agreed: true,
      }),
    ]);
    // Approved: asked at once, not at the interval.
    await flush(clock);
    expect(seen.pollBodies).toHaveLength(1);
    expect(stored.get(STORE_KEY)).toBe(machineToken);
    // The code is spent and forgotten.
    expect(stored.get(CODE_KEY)).toBe(undefined);
    expect(seen.toasts).toContain("dc: signed in on Ann's laptop");
    expect((await drawn($)).line).toBe(row(WHOLE));
  });

  test("a code the agent names that is not the one this machine shows is refused and never sent", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    // Nothing shown yet: any code named is someone else's.
    const refused = (await $.tool.call(connectPlugin("BBBB-CCCC"))) as {
      deny?: string;
    };
    expect(refused.deny).toContain(
      "BBBB-CCCC is not the code this machine's devcorner plugin shows",
    );
    expect(refused.deny).toContain("http://dc.test/device");
    expect(seen.toolCalls).toEqual([]);
    expect(seen.deviceAsks).toEqual([]);
    // Once /dc login shows a code, that code passes, however it is written,
    // and another is still refused.
    await login($);
    await flush(clock);
    const other = (await $.tool.call(connectPlugin("BBBB-CCCC"))) as {
      deny?: string;
    };
    expect(other.deny).toContain("is not the code");
    await $.tool.call(connectPlugin("kq4f 9xzt"));
    expect(seen.toolCalls).toEqual([
      expect.objectContaining({ device: "KQ4F-9XZT" }),
    ]);
    expect(seen.deviceAsks).toHaveLength(1);
  });

  test("a connect_plugin call devcorner refused leaves the code shown for the person's yes, asked at its interval", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    seen.toolRefused = true;
    await $.session.start(START);
    await flush(clock);
    await $.tool.call(connectPlugin());
    await flush(clock);
    // The person sees the exact code devcorner's refusal has the agent ask about.
    expect(await rowText($)).toMatch(/and enter KQ4F-9XZT$/);
    expect(seen.pollBodies).toEqual([]);
    await clock.advance(5_000);
    expect(seen.pollBodies).toHaveLength(1);
  });

  test("a kept code is shown again by the next conversation's sign-in while it lasts", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      store: {
        [CODE_KEY]: {
          device_code: DEVICE_CODE.device_code,
          user_code: "KQ4F-9XZT",
          page: DEVICE_CODE.verification_uri,
          link: DEVICE_CODE.verification_uri_complete,
          expiresAt: 1_000_000 + 9 * 60_000,
          interval: 5,
        },
      },
    });
    await $.session.start(START);
    await flush(clock);
    // Nothing collects it by itself: no sign-in was begun here.
    await clock.advance(30_000);
    expect(seen.pollBodies).toEqual([]);
    await login($);
    await flush(clock);
    expect(seen.deviceAsks).toEqual([]);
    expect(await rowText($)).toMatch(/and enter KQ4F-9XZT$/);
  });

  test("a cloud session is never signed in: no code, no sign-in row, and connect_plugin and /dc login are refused", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
      remote: true,
    });
    await $.session.start(START);
    await flush(clock);
    expect(await rowText($)).toBe("");
    const refused = (await $.tool.call(connectPlugin())) as { deny?: string };
    expect(refused.deny).toContain("cloud session");
    expect(seen.toolCalls).toEqual([]);
    expect(
      said(await $.command.run({ command: "dc", args: "login" })),
    ).toContain("cloud session");
    await clock.advance(11 * 60_000);
    expect(seen.deviceAsks).toEqual([]);
  });

  test("beside the capacity hook (dc-t221) each tool.call hook passes the other's calls on as they were", async ($, on) => {
    const reading = [
      {
        kind: "five_hour",
        percentUsed: 4,
        resetsAt: "2026-10-14T14:00:00.000Z",
      },
    ];
    // A machine: connect_plugin goes with its code and no capacity, check with neither.
    const here = world(on, { tools: true, token: false, home: "/home/ann" });
    here.seen.limits = reading;
    await $.session.start(START);
    await flush(here.clock);
    await $.tool.call(connectPlugin());
    await $.tool.call({ tool: "mcp__Devcorner__check" } as never);
    expect(here.seen.toolCalls).toHaveLength(2);
    expect(here.seen.toolCalls[0]).toMatchObject({ device: "KQ4F-9XZT" });
    expect(here.seen.toolCalls[0]).not.toHaveProperty("capacity");
    expect(here.seen.toolCalls[1]).not.toHaveProperty("capacity");
    expect(here.seen.toolCalls[1]).not.toHaveProperty("device");
  });

  test("in a cloud session check carries its capacity past the sign-in's hook, and connect_plugin is refused before either goes out", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
      remote: true,
    });
    seen.limits = [
      {
        kind: "five_hour",
        percentUsed: 4,
        resetsAt: "2026-10-14T14:00:00.000Z",
      },
    ];
    await $.session.start(START);
    await flush(clock);
    const refused = (await $.tool.call(connectPlugin())) as { deny?: string };
    expect(refused.deny).toContain("cloud session");
    await $.tool.call({
      tool: "mcp__plugin_devcorner_devcorner__check",
    } as never);
    expect(seen.toolCalls).toHaveLength(1);
    expect(seen.toolCalls[0]).toMatchObject({
      tool: "mcp__plugin_devcorner_devcorner__check",
      capacity: { five_hour: { percent: 4 } },
    });
    expect(seen.toolCalls[0]).not.toHaveProperty("device");
  });

  test("an approval right after a poll waits out the interval, so devcorner never says slow_down", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    await clock.advance(5_000);
    expect(seen.pollBodies).toHaveLength(1);
    await clock.advance(2_000);
    await $.tool.call(connectPlugin());
    await flush(clock);
    expect(seen.pollBodies).toHaveLength(1);
    await clock.advance(3_000);
    expect(seen.pollBodies).toHaveLength(2);
  });

  test("a shown code about to run out is shown anew before an agent sends one", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    await clock.advance(DEVICE_CODE.expires_in * 1000 - 30_000);
    await $.tool.call(connectPlugin());
    expect(seen.deviceAsks).toHaveLength(2);
    expect(seen.toolCalls).toHaveLength(1);
  });

  test("another server's workspace tool is never given this machine's code", async ($, on) => {
    const { clock, seen } = world(on, {
      tools: true,
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({
      tool: "mcp__linear__workspace",
      action: "connect_plugin",
    } as never);
    expect(seen.toolCalls).toHaveLength(1);
    expect(seen.toolCalls[0]).not.toHaveProperty("device");
    expect(seen.deviceAsks).toEqual([]);
  });

  test("a session's start leaves the hooks' token another devcorner's conversation handed them", async ($, on) => {
    const other = handedText(machineToken, "https://other.test");
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      files: [["/home/ann/.cache/devcorner/token", other]],
    });
    await $.session.start(START);
    await flush(clock);
    expect(seen.files.get("/home/ann/.cache/devcorner/token")).toBe(other);
  });

  test("with a token already, connect_plugin is refused and nothing is sent", async ($, on) => {
    const { clock, seen } = world(on, { tools: true });
    await $.session.start(START);
    await flush(clock);
    const refused = (await $.tool.call(connectPlugin())) as { deny?: string };
    expect(refused.deny).toContain("DEVCORNER_TOKEN");
    expect(seen.toolCalls).toEqual([]);
    expect(seen.deviceAsks).toEqual([]);
    // Other tools pass as they are.
    await $.tool.call({
      tool: "mcp__plugin_devcorner_devcorner__workspace",
      action: "list",
    } as never);
    expect(seen.toolCalls).toEqual([
      expect.objectContaining({ action: "list" }),
    ]);
  });

  test("/dc login asks for a code, the row shows where to open and what to enter, with nothing to press, and the approved token is kept", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    // What the device says of itself: never a token.
    expect(seen.deviceAsks).toEqual([
      {
        client_name: "Claude Code plugin",
        os: "macOS",
        name: "Ann's MacBook Air",
      },
    ]);
    // (A terminal that draws no hyperlink shows the address beside its words.)
    expect(await rowText($)).toMatch(
      /^● devcorner · Open .*dc\.test\/device and enter KQ4F-9XZT$/,
    );
    const [link, ...others] = await rowLinks($);
    expect(others).toEqual([]);
    expect(link![1]).toBe(DEVICE_CODE.verification_uri_complete);
    expect(String(link![0]).endsWith("dc.test/device")).toBe(true);
    expect((await drawn($)).buttons).toBe(0);

    // Waiting, at the interval devcorner gave, with the secret in the body.
    await clock.advance(5_000);
    expect(seen.pollBodies).toEqual([
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: DEVICE_CODE.device_code,
      },
    ]);
    // Approved: the token is kept in the store, handed to the hooks, and used.
    seen.polls.push({
      status: 200,
      body: {
        access_token: machineToken,
        token_type: "Bearer",
        name: "Ann's laptop",
      },
    });
    seen.answer = WHOLE;
    await clock.advance(5_000);
    await flush(clock);
    expect(stored.get(STORE_KEY)).toBe(machineToken);
    expect(seen.files.get(handedFile)).toBe(HANDED);
    const handed = seen.runs.find((r) => r.argv[0] === "sh")!;
    // Owner-only, and the token on standard input, never in an argument.
    expect(handed.argv[2]).toContain("umask 077");
    expect(handed.argv.join(" ")).not.toContain(machineToken);
    expect(seen.toasts).toContain("dc: signed in on Ann's laptop");
    expect(seen.statusTokens.at(-1)).toBe(machineToken);
    expect((await drawn($)).line).toBe(row(WHOLE));
    // No more polls once it is in.
    const polled = seen.pollBodies.length;
    await clock.advance(60_000);
    expect(seen.pollBodies).toHaveLength(polled);
  });

  test("slow_down waits longer; a denied or expired code ends with a row that says so", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    seen.polls.push({
      status: 400,
      body: { error: "slow_down", interval: 10 },
    });
    await clock.advance(5_000);
    expect(seen.pollBodies).toHaveLength(1);
    await clock.advance(9_000);
    expect(seen.pollBodies).toHaveLength(1);
    seen.polls.push({ status: 400, body: { error: "access_denied" } });
    await clock.advance(1_000);
    await flush(clock);
    expect(seen.pollBodies).toHaveLength(2);
    expect(await rowText($)).toBe(
      "● devcorner · sign-in was denied on the page · /dc login, or ask Claude to sign it in",
    );
    expect((await drawn($)).buttons).toBe(0);
    expect(stored.get(STORE_KEY)).toBe(undefined);

    await login($);
    await flush(clock);
    seen.polls.push({ status: 400, body: { error: "expired_token" } });
    await clock.advance(5_000);
    await flush(clock);
    expect(await rowText($)).toContain(
      "the code expired before it was approved",
    );
  });

  test("a code that runs out while it waits ends as expired", async ($, on) => {
    const { clock } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    await clock.advance(DEVICE_CODE.expires_in * 1000 + 5_000);
    await flush(clock);
    expect(await rowText($)).toContain("the code expired");
  });

  test("/dc logout stops a sign-in under way, and its poll; the code is kept for the next one while it lasts", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
    });
    await $.session.start(START);
    await flush(clock);
    await login($);
    await flush(clock);
    expect(said(await $.command.run({ command: "dc", args: "logout" }))).toBe(
      "Stopped signing in: this machine is not signed in to devcorner. /dc login signs it in.",
    );
    await clock.advance(30_000);
    expect(seen.pollBodies).toEqual([]);
    expect(await rowText($)).toBe(
      "● devcorner · not signed in · /dc login, or ask Claude to sign it in",
    );
    expect(stored.get(CODE_KEY)).toMatchObject({ user_code: "KQ4F-9XZT" });
    // With no sign-in under way, it says only that the machine is not in.
    expect(said(await $.command.run({ command: "dc", args: "logout" }))).toBe(
      "This machine is not signed in to devcorner. /dc login signs it in.",
    );
  });

  test("/dc login says where to go, with no secret", async ($, on) => {
    const { clock } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    const out = said(await $.command.run({ command: "dc", args: "login" }));
    expect(out).toContain("Open http://dc.test/device?code=KQ4F-9XZT");
    expect(out).not.toContain("dcd_");
  });

  test("with DEVCORNER_TOKEN set, /dc login asks for no code: the environment wins", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    const out = said(await $.command.run({ command: "dc", args: "login" }));
    expect(out).toContain("DEVCORNER_TOKEN");
    expect(seen.deviceAsks).toEqual([]);
  });

  test("/dc logout revokes the machine's token on devcorner and forgets it here", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
      files: [[handedFile, HANDED]],
    });
    seen.answer = WHOLE;
    await $.session.start(START);
    await flush(clock);
    expect(seen.statusTokens.at(-1)).toBe(machineToken);
    const out = said(await $.command.run({ command: "dc", args: "logout" }));
    expect(out).toContain("devcorner revoked this machine's token");
    expect(seen.events).toEqual([{ name: "SignOut", token: machineToken }]);
    expect(stored.get(STORE_KEY)).toBe(undefined);
    expect(seen.files.has(handedFile)).toBe(false);
    expect(await rowText($)).toContain("not signed in");
  });

  test("/dc logout leaves a DEVCORNER_TOKEN from the environment alone", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await flush(clock);
    const out = said(await $.command.run({ command: "dc", args: "logout" }));
    expect(out).toContain("DEVCORNER_TOKEN");
    expect(seen.events).toEqual([]);
  });

  test("a machine revoked on the connections page is signed out, and its token forgotten", async ($, on) => {
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
    });
    seen.answer = "refused";
    await $.session.start(START);
    await flush(clock);
    expect(await rowText($)).toBe(
      "● devcorner · this machine was signed out · /dc login, or ask Claude to sign it in",
    );
    expect((await drawn($)).buttons).toBe(0);
    expect(stored.get(STORE_KEY)).toBe(undefined);
  });

  test("a session's start hands the stored token to the hooks", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
    });
    await $.session.start(START);
    await flush(clock);
    expect(seen.files.get(handedFile)).toBe(HANDED);
  });

  test("a copy the store no longer holds is taken back at a session's start", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      files: [[handedFile, HANDED]],
    });
    await $.session.start(START);
    await flush(clock);
    expect(seen.files.has(handedFile)).toBe(false);
  });

  test("/dc says which person and which machine this is, when devcorner says", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
    });
    seen.answer = PICTURED;
    seen.who = {
      person: { id: "u1", name: "Ann", email: "ann@example.test" },
      connection: {
        name: "Ann's laptop",
        kind: "hook",
        machine: { client: "Claude Code plugin", os: "macOS" },
      },
    };
    await $.session.start(START);
    await clock.settle();
    const out = await $.command.run({ command: "dc", args: "" });
    expect(out).toMatchObject({
      text: `signed in: Ann (ann@example.test) on Ann's laptop, signed in from this machine with /dc login\n${dcText(PICTURED)}`,
    });
  });
});

describe("the machine's token is the devcorner's that made it (dc-t224)", () => {
  test("a token another devcorner gave is never sent here, and is kept", async ($, on) => {
    const other = tokenKey("http://other.test");
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [other]: machineToken },
    });
    await $.session.start(START);
    await flush(clock);
    expect(seen.statusTokens).toEqual([]);
    expect(await rowText($)).toContain("not signed in");
    expect(stored.get(other)).toBe(machineToken);
  });

  test("a refusal of an old token never forgets a newer one kept meanwhile", async ($, on) => {
    const newer = `dch_${"n".repeat(43)}`;
    const { clock, seen, stored } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
    });
    seen.holdStatus = true;
    await $.session.start(START);
    await flush(clock);
    expect(seen.heldStatus).toHaveLength(1);
    // Another conversation signs in again while this read is on its way.
    stored.set(STORE_KEY, newer);
    seen.heldStatus.pop()!("refused");
    await flush(clock);
    expect(stored.get(STORE_KEY)).toBe(newer);
    expect(await rowText($)).not.toContain("signed out");
  });

  test("/dc logout against a devcorner that does not confirm says to revoke it by hand", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      home: "/home/ann",
      store: { [STORE_KEY]: machineToken },
    });
    seen.answer = WHOLE;
    seen.signOutStatus = 204;
    await $.session.start(START);
    await flush(clock);
    const out = (
      (await $.command.run({ command: "dc", args: "logout" })) as {
        text: string;
      }
    ).text;
    expect(out).toContain("devcorner did not say it revoked it");
    expect(out).toContain("http://dc.test/settings/connections");
  });
});

describe("the sign-in's words (dc-t224)", () => {
  test("osName says a system as a person does", () => {
    expect(osName("Darwin\n")).toBe("macOS");
    expect(osName("Linux")).toBe("Linux");
    expect(osName("MINGW64_NT-10.0")).toBe("Windows");
    expect(osName("")).toBeNull();
  });

  test("readDeviceCode takes devcorner's answer, and nothing else", () => {
    expect(readDeviceCode(JSON.stringify(DEVICE_CODE))).toEqual(DEVICE_CODE);
    expect(readDeviceCode("{}")).toBeNull();
    expect(readDeviceCode("not json")).toBeNull();
    expect(
      readDeviceCode(
        JSON.stringify({
          ...DEVICE_CODE,
          verification_uri_complete: "https://elsewhere.test/x",
        }),
      ),
    ).toBeNull();
  });

  test("tokenFile is beside the markers", () => {
    expect(tokenFile({ home: "/home/ann" })).toBe(
      "/home/ann/.cache/devcorner/token",
    );
    expect(tokenFile({ state: "/s", home: "/home/ann" })).toBe("/s/token");
    expect(tokenFile({})).toBeUndefined();
    expect(markerFile("c1", { home: "/home/ann" })).toBe(
      "/home/ann/.cache/devcorner/waiting/c1.waiting",
    );
  });

  test("whoText names the person and the connection, and where the token came from", () => {
    expect(
      whoText(
        {
          person: { name: "Ann", email: "ann@x.test" },
          connection: { name: "Laptop" },
        },
        "env",
      ),
    ).toBe(
      "signed in: Ann (ann@x.test) on Laptop, with DEVCORNER_TOKEN from the environment",
    );
    expect(whoText({ person: {} }, "store")).toBeNull();
  });

  test("signedOutText says why", () => {
    expect(signedOutText({ step: "out" })).toBe(
      "devcorner · not signed in · /dc login, or ask Claude to sign it in",
    );
    expect(signedOutText({ step: "out", why: "failed", detail: "x" })).toBe(
      "devcorner · could not sign in: x · /dc login, or ask Claude to sign it in",
    );
    expect(signedOutText({ step: "out", why: "expired" })).toBe(
      "devcorner · the code expired before it was approved · /dc login, or ask Claude to sign it in",
    );
  });
});

describe("an OA's run that waits for room (dc-t254)", () => {
  const room = "waits for room until 01:00 18 Oct (UTC)";
  const waiting = { ...WHOLE, overnight: { ...NIGHT, room } };

  test("/dc says until when on the oa line, after the state; the row says nothing of it (dc-t533)", () => {
    expect(lines({ ...PICTURED, overnight: waiting.overnight })).toContain(
      `oa      dc-o3@acme Working (lands), ${room}, 3 acts, 1 wait on you`,
    );
    // None waits, or an older devcorner says nothing of it: as before.
    expect(lines({ ...PICTURED, overnight: { ...NIGHT, room: null } })).toEqual(
      lines(PICTURED),
    );
    expect(row(waiting)).toBe(row(WHOLE));
  });

  test("its OA's word to whoever gave it wakes them, named as the run's news", () => {
    const held: StatusWake = {
      id: "dc-m1",
      from: "run",
      what: "held",
      item: "dc-r22@acme",
      detail: null,
    };
    expect(wakeWords(held, "person")).toBe("run dc-r22@acme waits for room");
    expect(wakeWords(held, "agent")).toBe("run dc-r22@acme waits for room");
  });
});

describe("a conversation with no session is woken too (dc-t312)", () => {
  /** A Status of a conversation that works as no session: `messages` from its person, and `pending` in all. */
  const alone = (
    messages: number,
    latest: string | null,
    pending = messages,
  ): Status => ({
    ...base,
    session: null,
    conversation: {
      id: "dc-h2",
      wakeMessages: messages,
      wakeMessageId: latest,
      wakes:
        latest === null
          ? []
          : [
              {
                id: latest,
                from: "person",
                what: "message",
                item: null,
                detail: null,
              },
            ],
      pending,
    },
  });

  test("reads the held request's notice, and the wake of a conversation", () => {
    expect(readHeld('{"notice":"dc-m5"}')).toEqual({
      kind: "notice",
      id: "dc-m5",
    });
    expect(readHeld('{"wake":"dc-h2","id":"dc-m6"}')).toEqual({
      kind: "wake",
      session: "dc-h2",
      id: "dc-m6",
    });
    expect(readHeld('{"notice":5}')).toEqual({ kind: "empty" });
  });

  test("its person's word wakes it once, its mail is pending, and a session goes first", () => {
    expect(wokenOf(alone(1, "dc-m3"))!.id).toBe("dc-h2");
    expect(nextStep(alone(1, "dc-m3"), null)).toEqual({ wake: "dc-m3" });
    expect(nextStep(alone(1, "dc-m3"), "dc-m3")).toEqual({ after: IDLE_MS });
    expect(pendingOf(alone(1, "dc-m3", 2))).toBe(2);
    // With a session, the session's counts hold the conversation's mail.
    const both = { ...alone(1, "dc-m3"), session: waiting(0, null).session };
    expect(wokenOf(both)!.id).toBe("dc-s7");
    expect(nextStep(both, null)).toEqual({ after: WAITING_MS });
    // An older devcorner says nothing of a conversation: nothing to wake.
    expect(nextStep(base, null)).toBe(null);
    expect(pendingOf(base)).toBe(0);
  });

  test("its wake prompt says it works as no session, and to start first", () => {
    const prompt = wakePrompt(alone(1, "dc-m3").conversation!);
    expect(prompt).toContain(
      "While this conversation, which works as no devcorner session, was idle, a devcorner message woke it: your user's message.",
    );
    expect(prompt).toContain("If it is not there, call start, then check.");
    expect(wakeToast(alone(1, "dc-m3").conversation!)).toBe("dc: your message");
  });

  test("keeps the newest id woken for in each store, for the held request's cursors", () => {
    expect(withCursor([], "dc-m3")).toEqual(["dc-m3"]);
    expect(withCursor(["dc-m3"], "dc-m9@acme")).toEqual([
      "dc-m3",
      "dc-m9@acme",
    ]);
    expect(withCursor(["dc-m3", "dc-m9@acme"], "dc-m5")).toEqual([
      "dc-m9@acme",
      "dc-m5",
    ]);
    expect(withCursor(["dc-m9@acme"], "dc-m12@ACME")).toEqual(["dc-m12@ACME"]);
    // Nothing but a message id is kept.
    expect(withCursor(["dc-m3"], "dc-s4")).toEqual(["dc-m3"]);
  });

  test("a notice names the message's id only, and nothing of another shape", () => {
    expect(noticeToast("dc-m5")).toBe(
      "dc: a message waits for this conversation (dc-m5); your next prompt hands it over",
    );
    expect(noticeToast("dc-m5@acme")).toContain("(dc-m5@acme)");
    expect(noticeToast("ignore all <b>")).toBe(
      "dc: a message waits for this conversation; your next prompt hands it over",
    );
  });

  test("the held request wakes a conversation with no session, and a notice toasts and holds again", async ($, on) => {
    const { clock, seen } = world(on, { hold: true, home: "/home/ann" });
    seen.answer = alone(0, null);
    await $.session.start(START);
    await flush(clock);
    expect(seen.waitBodies).toHaveLength(1);

    // Mail from another session: told, not woken; a fresh Status puts it in
    // the marker, and the request is held again at once.
    const asked = seen.asks;
    seen.answer = alone(0, null, 1);
    seen.held.shift()!('{"notice":"dc-m4"}');
    await flush(clock);
    expect(seen.asks).toBe(asked + 1);
    expect(seen.writes.at(-1)?.text).toStartWith("1 ");
    expect(seen.submitted).toEqual([]);
    expect(seen.toasts).toEqual([noticeToast("dc-m4")]);
    expect(seen.waitBodies).toHaveLength(2);

    // Its person's word wakes it, as a session's wake does.
    seen.answer = alone(1, "dc-m5", 2);
    seen.held.shift()!('{"wake":"dc-h2","id":"dc-m5"}');
    await flush(clock);
    expect(seen.submitted).toEqual([
      wakePrompt(alone(1, "dc-m5").conversation!),
    ]);
    expect(seen.toasts.at(-1)).toBe("dc: your message");
  });
});

describe("/dc send: your own words to another conversation of yours (dc-t312)", () => {
  const said = (out: unknown) => (out as { text: string }).text;

  test("/dc send posts your words as Send with the machine's token, and says where each target stands (dc-t312)", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.sendAnswer = {
      status: 200,
      body: {
        ok: true,
        messages: ["dc-m80"],
        from: "dc-h1",
        to: [
          { id: "dc-h2", session: null, state: "queued" },
          { id: "dc-h3", session: "dc-s4@acme", state: "waiting" },
        ],
      },
    };
    const out = said(
      await $.command.run({
        command: "dc",
        args: "send dc-h2,dc-h3   Rebase on main first,\nthen push. ",
      }),
    );
    expect(seen.sends).toEqual([
      {
        body: {
          hook_event_name: "Send",
          session_id: "conversation-1",
          to: "dc-h2,dc-h3",
          text: "Rebase on main first,\nthen push.",
        },
        token: "dch_test",
      },
    ]);
    expect(out).toBe(
      "Sent dc-m80 to dc-h2: queued, no session yet; dc-h3: for dc-s4@acme at its next hook event. An idle conversation wakes for it now; a busy one is handed it at its next hook event.",
    );
    // It is the command's own answer: nothing is asked of the model.
    await clock.settle();
    expect(seen.submitted).toEqual([]);

    // A space after a list's comma keeps the list whole.
    await $.command.run({
      command: "dc",
      args: "send dc-h2, dc-h3 ,mine Rebase first",
    });
    expect(seen.sends.at(-1)!.body).toMatchObject({
      to: "dc-h2,dc-h3,mine",
      text: "Rebase first",
    });
  });

  test("/dc send says why nothing was sent: no words, devcorner's refusal, its limit, an older devcorner, no answer (dc-t312)", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    for (const args of ["send", "send dc-h2", "send   dc-h2   "]) {
      expect(said(await $.command.run({ command: "dc", args }))).toBe(
        SEND_USAGE,
      );
    }
    expect(seen.sends).toEqual([]);

    const answers: [typeof seen.sendAnswer, string][] = [
      [
        {
          status: 400,
          body: {
            error:
              "dc-s1@acme is e2e:bob's session, and your own send reaches only your own. Nothing was sent.",
          },
        },
        "devcorner did not send it: dc-s1@acme is e2e:bob's session, and your own send reaches only your own. Nothing was sent.",
      ],
      [
        { status: 429, body: {} },
        "devcorner did not send it: that is more sends than a minute allows. Nothing was sent; try again shortly.",
      ],
      [
        { status: 204, body: null },
        "This devcorner does not take /dc send yet, so nothing was sent.",
      ],
      ["down", "devcorner could not be reached, so nothing was sent."],
    ];
    for (const [answer, words] of answers) {
      seen.sendAnswer = answer;
      expect(
        said(await $.command.run({ command: "dc", args: "send dc-h2 hi" })),
      ).toBe(words);
    }
    // "sending" is a question for devcorner, not a send.
    expect(
      await $.command.run({ command: "dc", args: "sending what?" }),
    ).toEqual({ text: "Asking devcorner: sending what?" });
  });

  test("/dc send with a paste's id alone sends that paste, and words that only name one stay words (dc-t312, part 6)", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.sendAnswer = {
      status: 200,
      body: {
        ok: true,
        messages: ["dc-m81"],
        from: "dc-h1",
        to: [{ id: "dc-h2", name: "reviewer", session: null, state: "queued" }],
      },
    };
    const out = said(
      await $.command.run({ command: "dc", args: "send reviewer DC-P4 " }),
    );
    expect(seen.sends.at(-1)).toEqual({
      body: {
        hook_event_name: "Send",
        session_id: "conversation-1",
        to: "reviewer",
        paste: "dc-p4",
      },
      token: "dch_test",
    });
    expect(out).toStartWith("Sent dc-m81 to dc-h2 (reviewer): queued");

    await $.command.run({ command: "dc", args: "send reviewer read dc-p4" });
    expect(seen.sends.at(-1)!.body).toEqual({
      hook_event_name: "Send",
      session_id: "conversation-1",
      to: "reviewer",
      text: "read dc-p4",
    });
  });

  test("/dc send on a machine that is not signed in sends nothing", async ($, on) => {
    const { clock, seen } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    expect(
      said(await $.command.run({ command: "dc", args: "send dc-h2 hi" })),
    ).toBe(
      "This machine is not signed in to devcorner, so nothing was sent. /dc login signs it in.",
    );
    expect(seen.sends).toEqual([]);
  });
});

describe("this conversation in the row, and /dc name (dc-t312, part 5)", () => {
  const said = (out: unknown) => (out as { text: string }).text;
  const named = (name: string | null) => ({
    ...WHOLE,
    thisConversation: { id: "dc-h3", name },
  });

  test("the row labels the session with the conversation's name; /dc opens with the session's id, else the conversation's, and the name (dc-t533)", () => {
    expect(row(named("reviewer"))).toBe("devcorner · s7 reviewer · waiting 2");
    expect(row(named(null))).toBe("devcorner · s7 · waiting 2");
    // A devcorner that names none, or none known, gives the session alone.
    expect(row({ ...WHOLE, thisConversation: null })).toBe(row(named(null)));
    expect(lines(named("reviewer"))[0]).toBe(
      "devcorner · dc-s7@acme reviewer · Acme · Shop",
    );
    // With no session, the row names neither; /dc names the conversation.
    const alone = {
      ...base,
      thisConversation: { id: "dc-h4", name: "builder" },
    };
    expect(row(alone)).toBe("devcorner");
    expect(lines(alone)[0]).toBe("devcorner · dc-h4 builder · personal");
  });

  test("/dc name posts Name with the machine's token, says the name, and reads the row again", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.nameAnswer = {
      status: 200,
      body: { ok: true, conversation: "dc-h3", name: "reviewer", was: null },
    };
    const asked = seen.asks;
    const out = said(
      await $.command.run({ command: "dc", args: "name Reviewer " }),
    );
    expect(seen.names).toEqual([
      {
        body: {
          hook_event_name: "Name",
          session_id: "conversation-1",
          name: "Reviewer",
        },
        token: "dch_test",
      },
    ]);
    expect(out).toBe(
      'This conversation, dc-h3, is reviewer now: /dc send reviewer and message(to: "reviewer") reach it while it is live.',
    );
    expect(seen.asks).toBeGreaterThan(asked);
    await clock.settle();
    expect(seen.submitted).toEqual([]);

    // With no word, it clears the name.
    seen.nameAnswer = {
      status: 200,
      body: { ok: true, conversation: "dc-h3", name: null, was: "reviewer" },
    };
    expect(said(await $.command.run({ command: "dc", args: "name" }))).toBe(
      "This conversation, dc-h3, has no name now.",
    );
    expect(seen.names.at(-1)!.body).toMatchObject({ name: "" });
  });

  test("/dc name says why nothing was named: devcorner's refusal, an older devcorner, no answer, no sign-in", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    const answers: [typeof seen.nameAnswer, string][] = [
      [
        {
          status: 400,
          body: {
            error:
              "dc-h2 is reviewer; rename it first, or pick another name. Nothing was named.",
          },
        },
        "devcorner did not name it: dc-h2 is reviewer; rename it first, or pick another name. Nothing was named.",
      ],
      [
        { status: 204, body: null },
        "This devcorner does not take /dc name yet, so nothing was named.",
      ],
      ["down", "devcorner could not be reached, so nothing was named."],
    ];
    for (const [answer, words] of answers) {
      seen.nameAnswer = answer;
      expect(
        said(await $.command.run({ command: "dc", args: "name reviewer" })),
      ).toBe(words);
    }
    // "names" is a question for devcorner, not /dc name.
    expect(
      await $.command.run({ command: "dc", args: "names of my sessions" }),
    ).toEqual({ text: "Asking devcorner: names of my sessions" });
  });

  test("/dc send names a conversation it reached by its name too", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.sendAnswer = {
      status: 200,
      body: {
        ok: true,
        messages: ["dc-m81"],
        from: "dc-h1",
        to: [{ id: "dc-h2", name: "reviewer", session: null, state: "queued" }],
      },
    };
    expect(
      said(await $.command.run({ command: "dc", args: "send reviewer Hi" })),
    ).toBe(
      "Sent dc-m81 to dc-h2 (reviewer): queued, no session yet. An idle conversation wakes for it now; a busy one is handed it at its next hook event.",
    );
    expect(seen.sends.at(-1)!.body).toMatchObject({ to: "reviewer" });
  });

  test("/dc send says a connection's or a chat's conversation cannot be woken (dc-t312, part 2)", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.sendAnswer = {
      status: 200,
      body: {
        ok: true,
        messages: ["dc-m82"],
        from: "dc-h1",
        to: [
          {
            id: "dc-h5",
            name: null,
            session: "dc-s9",
            state: "waiting",
            wakes: false,
          },
        ],
      },
    };
    expect(
      said(await $.command.run({ command: "dc", args: "send dc-h5 Hi" })),
    ).toBe("Sent dc-m82 to dc-h5: read at its next call; it cannot be woken.");
    // Beside one that wakes, the wake is said for that one.
    seen.sendAnswer = {
      status: 200,
      body: {
        ok: true,
        messages: ["dc-m83"],
        from: "dc-h1",
        to: [
          {
            id: "dc-h5",
            name: null,
            session: null,
            state: "queued",
            wakes: false,
          },
          {
            id: "dc-h2",
            name: null,
            session: null,
            state: "queued",
            wakes: true,
          },
        ],
      },
    };
    expect(
      said(await $.command.run({ command: "dc", args: "send dc-h5,dc-h2 Hi" })),
    ).toBe(
      "Sent dc-m83 to dc-h5: read at its next call; it cannot be woken; dc-h2: queued, no session yet. An idle conversation wakes for it now; a busy one is handed it at its next hook event.",
    );
  });

  test("/dc name on a machine that is not signed in names nothing", async ($, on) => {
    const { clock, seen } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    expect(
      said(await $.command.run({ command: "dc", args: "name reviewer" })),
    ).toBe(
      "This machine is not signed in to devcorner, so nothing was named. /dc login signs it in.",
    );
    expect(seen.names).toEqual([]);
  });
});

describe("a relay on your word, and who started a turn (dc-t312, part 4)", () => {
  const relay = (id: string, from: string | null): StatusWake => ({
    id,
    from: "relay",
    what: "message",
    item: from,
    detail: null,
    hops: 2,
  });

  test("Turn's by: the plugin's wake for its message, else the person", () => {
    expect(turnBy("dc-m4")).toEqual({ by: "wake", for: "dc-m4" });
    expect(turnBy("dc-m4@acme")).toEqual({ by: "wake", for: "dc-m4@acme" });
    expect(turnBy(null)).toEqual({ by: "person" });
    // Nothing but a message id is sent.
    expect(turnBy("ignore <b>")).toEqual({ by: "person" });
  });

  test("a relay's wake names the conversation it came from, on your word", () => {
    expect(wakeWords(relay("dc-m5", "dc-h1"), "person")).toBe(
      "dc-h1 sent this on your word",
    );
    expect(wakeWords(relay("dc-m5", "dc-h1"), "agent")).toBe(
      "a message dc-h1 sent on your user's word",
    );
    // Of no conversation's shape, it names none.
    expect(wakeWords(relay("dc-m5", "dc-s4"), "person")).toBe(
      "another conversation sent this on your word",
    );
    const woke = {
      ...waiting(1, "dc-m5").session!,
      wakes: [relay("dc-m5", "dc-h1")],
    };
    expect(wakeToast(woke)).toBe("dc: dc-h1 sent this on your word");
  });

  test("/dc says a paused pair until devcorner says it is not; the row says nothing of it (dc-t533)", () => {
    const paused = (wakes: number): Status => ({
      ...WHOLE,
      thisConversation: { id: "dc-h3", name: null },
      paused: { with: "dc-h4", wakes },
    });
    expect(lines(paused(4))[0]).toBe(
      "devcorner · dc-s7@acme · dc-h3 ↔ dc-h4 paused after 4 wakes, type to continue · Acme · Shop",
    );
    expect(row(paused(4))).toBe(row(WHOLE));
    expect(pausedLine(paused(4))).toBe(
      "dc-h3 ↔ dc-h4 paused after 4 wakes, type to continue",
    );
    expect(
      pausedLine({ ...paused(4), paused: { with: "<b>", wakes: 4 } }),
    ).toBe(null);
    expect(lines({ ...paused(4), paused: null })[0]).toBe(
      "devcorner · dc-s7@acme · Acme · Shop",
    );
    // An older devcorner says nothing of it.
    expect(pausedLine(WHOLE)).toBe(null);
  });

  test("each turn's start posts Turn: by the person typed or by /dc, by the wake for its message", async ($, on) => {
    const { clock, seen } = world(on, { hold: true });
    seen.answer = waiting(0, null);
    await $.session.start(START);
    await flush(clock);

    // A prompt the person typed.
    await $.turn.start({ text: "work", turnId: "t1" });
    await $.turn.complete(done("t1"));
    await flush(clock);
    expect(seen.turns).toEqual([
      {
        body: {
          hook_event_name: "Turn",
          session_id: "conversation-1",
          turn_id: "t1",
          by: "person",
        },
        token: "dch_test",
      },
    ]);

    // The plugin's wake: its turn is the wake's, for the message it woke for.
    seen.answer = waiting(1, "dc-m3");
    seen.held.pop()!(JSON.stringify({ wake: "dc-s7", id: "dc-m3" }));
    await flush(clock);
    expect(seen.submitted).toHaveLength(1);
    await $.turn.start({ text: seen.submitted[0]!, turnId: "t2" });
    await $.turn.complete(done("t2"));
    await flush(clock);
    expect(seen.turns.at(-1)!.body).toMatchObject({
      turn_id: "t2",
      by: "wake",
      for: "dc-m3",
    });

    // /dc's words are the person's own.
    seen.answer = waiting(0, null);
    await $.command.run({ command: "dc", args: "board" });
    await clock.settle();
    await $.turn.start({ text: "devcorner: board", turnId: "t3" });
    await $.turn.complete(done("t3"));
    await flush(clock);
    expect(seen.turns.at(-1)!.body).toMatchObject({
      turn_id: "t3",
      by: "person",
    });
    expect(seen.turns.at(-1)!.body).not.toHaveProperty("for");
  });

  test("a typed turn that cleared a pause reads the row again", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.turnAnswer = { ok: true, cleared: ["dc-h3", "dc-h4"] };
    const asked = seen.asks;
    await $.turn.start({ text: "carry on", turnId: "t1" });
    await clock.settle();
    expect(seen.asks).toBeGreaterThan(asked);
  });

  test("a machine that is not signed in posts no Turn", async ($, on) => {
    const { clock, seen } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    await $.turn.start({ text: "work", turnId: "t1" });
    await flush(clock);
    expect(seen.turns).toEqual([]);
  });
});

describe("/dc paste and /dc pastes, and the paste /dc names (dc-t490)", () => {
  const said = (out: unknown) => (out as { text: string }).text;
  const DAY = 24 * 60 * 60_000;
  /** What the paste holds, as an agent wrote it. */
  const TEXT = "# Reply\n\nThanks for the review: fixed in 3a2b1c0.\n";
  /** The newest paste of this conversation's sessions, as Status names it; the world's clock reads 1,000,000. */
  const PASTE: StatusPaste = {
    id: "me-p14",
    title: "Reply to the reviewer",
    length: 1240,
    createdAt: 1_000_000,
    expiresAt: 1_000_000 + 30 * DAY,
    count: 1,
    page: "https://dc.test/p/me-p14",
  };
  /** The same, whole, as the hook route's Paste gives it. */
  const WHOLE_PASTE = {
    id: PASTE.id,
    title: PASTE.title,
    text: TEXT,
    length: PASTE.length,
    createdAt: PASTE.createdAt,
    expiresAt: PASTE.expiresAt,
    here: true,
    page: PASTE.page,
  };
  const PASTED: Status = { ...BUSY, paste: PASTE };

  test("its size, its expiry and its age in a few characters", () => {
    expect(sizeText(1)).toBe("1 char");
    expect(sizeText(840)).toBe("840 chars");
    expect(sizeText(1240)).toBe("1.2k chars");
    expect(sizeText(1000)).toBe("1k chars");
    expect(sizeText(20_000)).toBe("20k chars");
    expect(expiresText(30 * DAY, 0)).toBe("expires in 30 d");
    expect(expiresText(DAY + 1, 0)).toBe("expires in 1 d");
    expect(expiresText(DAY - 1, 0)).toBe("expires today");
    expect(agoText(0, 30_000)).toBe("just now");
    expect(agoText(0, 5 * 60_000)).toBe("5 min ago");
    expect(agoText(0, 2 * 60 * 60_000)).toBe("2 h ago");
    expect(agoText(0, 3 * DAY)).toBe("3 d ago");
  });

  test("the row says nothing of a paste; /dc says the paste line after here, whole, then its page and /dc paste", () => {
    expect(row({ ...WHOLE, paste: PASTE })).toBe(row(WHOLE));
    const said = lines(PASTED, 1_000_000);
    expect(
      said.slice(2, 5).map((line) => line.slice(0, LABEL_WIDTH).trim()),
    ).toEqual(["here", "paste", "first"]);
    expect(said[3]).toBe(
      "paste   me-p14 Reply to the reviewer · 1.2k chars · expires in 30 d",
    );
    expect(dcText(PASTED, 1_000_000).split("\n")).toContain(
      `paste: ${PASTE.page} · /dc paste copies it`,
    );
    // How many more of theirs are kept, said last; with no time, no expiry.
    expect(lines({ ...PASTED, paste: { ...PASTE, count: 3 } })[3]).toBe(
      "paste   me-p14 Reply to the reviewer · 1.2k chars · 2 more",
    );
    // With no page, /dc paste alone; an older devcorner names none.
    expect(
      dcText({ ...PASTED, paste: { ...PASTE, page: null } }).split("\n"),
    ).toContain("paste: /dc paste copies it");
    expect(dcText(BUSY)).not.toContain("paste");
  });

  test("/dc paste copies this conversation's newest, else your newest, or the one named, and names its page", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.pasteAnswer = { status: 200, body: { paste: WHOLE_PASTE } };
    expect(said(await $.command.run({ command: "dc", args: "paste" }))).toBe(
      [
        "me-p14  Reply to the reviewer · 1.2k chars",
        `copied to your clipboard · if it is not there, open it and press Copy: ${PASTE.page} · /dc pastes lists yours`,
      ].join("\n"),
    );
    expect(seen.pasteReads.at(-1)).toEqual({
      body: { hook_event_name: "Paste", session_id: "conversation-1" },
      token: "dch_test",
    });
    // No surface named: the session's first takes it.
    expect(seen.copies).toEqual([{ text: TEXT }]);

    // This conversation wrote none: your newest, said so.
    seen.pasteAnswer = {
      status: 200,
      body: { paste: { ...WHOLE_PASTE, here: false } },
    };
    expect(
      said(await $.command.run({ command: "dc", args: "paste" })),
    ).toStartWith(
      "me-p14  Reply to the reviewer · 1.2k chars · your newest; this conversation wrote none\n",
    );
    // Named, it is the one named, whoever wrote it.
    expect(
      said(await $.command.run({ command: "dc", args: "paste me-p14" })),
    ).toStartWith("me-p14  Reply to the reviewer · 1.2k chars\n");
    expect(seen.pasteReads.at(-1)!.body).toMatchObject({ id: "me-p14" });

    seen.copyAnswer = { isCopied: false, reason: "no-surface" };
    expect(
      said(await $.command.run({ command: "dc", args: "paste" })),
    ).toContain(
      `not copied here (nothing draws this session) · open it and press Copy: ${PASTE.page}`,
    );
  });

  test("/dc paste says why nothing was copied: no paste kept, not an id, devcorner's refusal, an older devcorner, no answer", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    const answers: [typeof seen.pasteAnswer, string][] = [
      [
        { status: 200, body: { paste: null } },
        "You have no paste kept. An agent writes one for you to copy with devcorner's paste tool; each is kept 30 days.",
      ],
      [
        { status: 404, body: { error: "There is no paste me-p9." } },
        "devcorner did not give it: There is no paste me-p9.",
      ],
      [
        { status: 204, body: null },
        "This devcorner does not give pastes to copy yet, so nothing was copied: open the paste's page and press Copy.",
      ],
      ["down", "devcorner could not be reached, so nothing was copied."],
    ];
    for (const [answer, words] of answers) {
      seen.pasteAnswer = answer;
      expect(said(await $.command.run({ command: "dc", args: "paste" }))).toBe(
        words,
      );
    }
    const asked = seen.pasteReads.length;
    expect(
      said(await $.command.run({ command: "dc", args: "paste the brief" })),
    ).toBe(PASTE_USAGE);
    expect(seen.pasteReads).toHaveLength(asked);
    expect(seen.copies).toEqual([]);
  });

  test("/dc paste on a machine that is not signed in copies nothing", async ($, on) => {
    const { clock, seen } = world(on, { token: false, home: "/home/ann" });
    await $.session.start(START);
    await flush(clock);
    expect(said(await $.command.run({ command: "dc", args: "paste" }))).toBe(
      "This machine is not signed in to devcorner, so nothing was copied. /dc login signs it in.",
    );
    expect(seen.pasteReads).toEqual([]);
  });

  test("/dc pastes lists yours, newest first, with their size, age, page and which this conversation wrote", async ($, on) => {
    const { clock, seen } = world(on);
    await $.session.start(START);
    await clock.settle();
    seen.pastesAnswer = {
      status: 200,
      body: {
        pastes: [
          {
            id: "me-p14",
            title: "Reply to the reviewer",
            length: 1240,
            createdAt: 1_000_000 - 2 * 60 * 60_000,
            expiresAt: PASTE.expiresAt,
            here: true,
            page: PASTE.page,
          },
          {
            id: "me-p9",
            title: "Prompt for the cloud\nsession",
            length: 840,
            createdAt: 1_000_000 - 3 * DAY,
            expiresAt: PASTE.expiresAt,
            here: false,
            page: "https://dc.test/p/me-p9",
          },
        ],
        more: 3,
      },
    };
    expect(said(await $.command.run({ command: "dc", args: "pastes" }))).toBe(
      [
        "your pastes, newest first (/dc paste <id> copies one):",
        `me-p14  Reply to the reviewer · 1.2k chars · 2 h ago · written here · ${PASTE.page}`,
        "me-p9   Prompt for the cloud session · 840 chars · 3 d ago · https://dc.test/p/me-p9",
        "and 3 more kept",
      ].join("\n"),
    );
    expect(seen.pasteReads.at(-1)).toEqual({
      body: { hook_event_name: "Pastes", session_id: "conversation-1" },
      token: "dch_test",
    });
    seen.pastesAnswer = { status: 200, body: { pastes: [], more: 0 } };
    expect(said(await $.command.run({ command: "dc", args: "pastes" }))).toBe(
      "You have no paste kept. An agent writes one for you to copy with devcorner's paste tool; each is kept 30 days.",
    );
    expect(pastesText(204, null, 0)).toBe(
      "This devcorner does not list pastes yet.",
    );
    expect(pastesText(400, { error: "No." }, 0)).toBe(
      "devcorner did not list them: No.",
    );
  });

  test("only a paste's shape is read: an id of another kind, or no text, is none", () => {
    expect(pasteRead(WHOLE_PASTE)).toEqual({
      id: "me-p14",
      title: PASTE.title,
      text: TEXT,
      length: 1240,
      expiresAt: PASTE.expiresAt,
      here: true,
      page: PASTE.page,
    });
    expect(pasteRead({ ...WHOLE_PASTE, id: "me-t14" })).toBeNull();
    expect(pasteRead({ ...WHOLE_PASTE, text: 7 })).toBeNull();
    expect(pasteRead(null)).toBeNull();
  });

  test("the paste tool's calls are devcorner's, by the connector's name or the plugin's", () => {
    for (const tool of [
      "mcp__Devcorner__paste",
      "mcp__plugin_devcorner_devcorner__paste",
    ]) {
      expect(PASTER.test(tool)).toBe(true);
    }
    for (const tool of ["mcp__other__paste", "mcp__Devcorner__show", "Paste"]) {
      expect(PASTER.test(tool)).toBe(false);
    }
  });

  test("when the session writes a paste the transcript says so in one line, read at once, and the row stays as it was", async ($, on) => {
    const { clock, seen } = world(on, { tools: true });
    seen.answer = WHOLE;
    await $.session.start(START);
    await clock.settle();
    seen.answer = { ...WHOLE, paste: PASTE };
    // What the paste tool answers, as the model reads it.
    const saved = (id: string) =>
      `Saved paste ${id} "${PASTE.title}" (1,240 characters), kept until 2026-11-22 (30 days); only your user reads it.`;
    seen.toolText = saved("me-p14");
    const asked = seen.asks;
    await $.tool.call({
      tool: "mcp__Devcorner__paste",
      title: PASTE.title,
      text: TEXT,
    });
    await clock.settle();
    expect(seen.asks).toBe(asked + 1);
    expect(seen.logs).toEqual([pasteNote(PASTE)]);
    expect(pasteNote(PASTE)).toBe(
      `devcorner: paste me-p14 "Reply to the reviewer" is ready for you to copy: /dc paste copies it, or press Copy on ${PASTE.page}`,
    );
    expect(pasteNote({ ...PASTE, page: null })).toBe(
      'devcorner: paste me-p14 "Reply to the reviewer" is ready for you to copy: /dc paste copies it',
    );
    expect((await drawn($)).line).toBe(row(WHOLE));
    // The call went on as the agent made it.
    expect(seen.toolCalls.at(-1)).toMatchObject({
      tool: "mcp__Devcorner__paste",
      title: PASTE.title,
      text: TEXT,
    });

    // A call that wrote no paste says nothing: one refused, one whose reply
    // names none; nor does one whose paste the row does not name, as one
    // written as no session or for another conversation.
    seen.toolRefused = true;
    await $.tool.call({ tool: "mcp__Devcorner__paste", title: "x", text: "y" });
    await clock.settle();
    seen.toolRefused = false;
    seen.toolText = "A paste needs text: the text your user is to copy.";
    await $.tool.call({ tool: "mcp__Devcorner__paste", title: "x", text: "" });
    await clock.settle();
    seen.toolText = saved("me-p20");
    await $.tool.call({ tool: "mcp__Devcorner__paste", title: "x", text: "y" });
    await clock.settle();
    expect(seen.logs).toHaveLength(1);
    expect(pasteWritten(saved("me-p20"))).toBe("me-p20");
    expect(pasteWritten(saved("DC-P20"))).toBe("dc-p20");
    expect(pasteWritten("Saved paste acm-t1")).toBeNull();
    expect(pasteWritten(undefined)).toBeNull();
    // A long title is cut at a word in the line.
    seen.answer = {
      ...WHOLE,
      paste: { ...PASTE, id: "me-p15", title: TITLE },
    };
    seen.toolText = saved("me-p15");
    await $.tool.call({
      tool: "mcp__Devcorner__paste",
      title: TITLE,
      text: "z",
    });
    await clock.settle();
    expect(seen.logs.at(-1)).toBe(
      `devcorner: paste me-p15 "For you: set up your Claude Code routines on this machine before the next run…" is ready for you to copy: /dc paste copies it, or press Copy on ${PASTE.page}`,
    );
  });

  test("with no token, as in a cloud session, a paste call says nothing and reads nothing", async ($, on) => {
    const { clock, seen } = world(on, {
      token: false,
      remote: true,
      tools: true,
    });
    await $.session.start(START);
    await flush(clock);
    await $.tool.call({ tool: "mcp__Devcorner__paste", title: "x", text: "y" });
    await flush(clock);
    expect(seen.logs).toEqual([]);
    expect(seen.asks).toBe(0);
  });
});

describe("your other live sessions in every project: /dc's others line and /dc sessions (dc-t491)", () => {
  /** Two other live sessions of the person's, as devcorner names them when asked (`others: true`, or with the picture). */
  const BUILDER: StatusOther = {
    id: "dc-s4@beta",
    page: "https://dc.test/s/dc-s4@beta",
    conversation: "dc-h5",
    name: "builder",
    repo: "beta/api",
    ticket: {
      id: "dc-t2@beta",
      title: "Rate limits",
      page: "https://dc.test/t/dc-t2@beta",
    },
    state: "waits on you",
  };
  const NOTES: StatusOther = {
    id: "dc-s2",
    page: "https://dc.test/s/dc-s2",
    conversation: "dc-h6",
    name: null,
    repo: "ann/notes",
    ticket: null,
    state: "idle 2 h",
  };
  const OTHERS = { count: 2, items: [BUILDER, NOTES] };
  const WITH: Status = {
    ...WHOLE,
    thisConversation: { id: "dc-h3", name: "reviewer" },
    expanded: PICTURE,
    others: OTHERS,
  };
  /** A session that says what wakes it, so the idle asking goes on. */
  const AWAKE = {
    id: "dc-s7@acme",
    ticket: "dc-t10@acme",
    waitingOnPerson: false,
    wakeMessages: 0,
    wakeMessageId: null,
  };
  const othersLine = (s: Status) =>
    lines(s).find((line) => line.startsWith("others"));

  test("/dc names them under others, after here, each with its name, repo and how it stands; the row names none of them", () => {
    expect(lines(WITH).slice(2, 4)).toEqual([
      "here    ticket dc-t10@acme",
      "others  dc-s4@beta builder beta/api, waits on you · dc-s2 ann/notes, idle 2 h",
    ]);
    expect(lines(WITH)[4]!.startsWith("first")).toBe(true);
    // None live, none asked for, or an older devcorner: no line.
    for (const others of [{ count: 0, items: [] }, null, undefined]) {
      expect(othersLine({ ...WITH, others })).toBeUndefined();
    }
    // More than devcorner named are counted.
    expect(othersLine({ ...WITH, others: { count: 5, items: [NOTES] } })).toBe(
      "others  dc-s2 ann/notes, idle 2 h · 4 more",
    );
    expect(row(WITH)).toBe("devcorner · s7 reviewer · waiting 2");
    expect(row(WITH)).toBe(row({ ...WITH, others: undefined }));
  });

  test("/dc sessions asks devcorner for them and says every live session of yours, this one first, and how to message one", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = { ...WITH, session: AWAKE };
    await $.session.start(START);
    await clock.settle();
    const out = (await $.command.run({
      command: "dc",
      args: "sessions",
    } as never)) as {
      text: string;
    };
    expect(seen.statusBodies.at(-1)).toMatchObject({
      hook_event_name: "Status",
      others: true,
    });
    expect("expanded" in seen.statusBodies.at(-1)!).toBe(false);
    expect(out.text.split("\n")).toEqual([
      "here    dc-s7@acme reviewer  a/b · on dc-t10@acme",
      "others  dc-s4@beta builder  beta/api · waits on you · on dc-t2@beta",
      "        dc-s2       ann/notes · idle 2 h",
      SESSIONS_SEND,
    ]);
    // Only the exact word: other words ask devcorner.
    await $.command.run({ command: "dc", args: "sessions please" } as never);
    await clock.settle();
    expect(seen.submitted.at(-1)).toBe("devcorner: sessions please");
  });

  test("/dc sessions says why it names none: none live, a devcorner that lists none, a read that listed none, no answer", () => {
    expect(sessionsText({ ...WITH, others: { count: 0, items: [] } })).toBe(
      "here    dc-s7@acme reviewer  a/b · on dc-t10@acme\nothers  none live, in any project",
    );
    expect(sessionsText({ ...WITH, others: undefined })).toContain(
      "This devcorner does not list your other sessions yet.",
    );
    expect(sessionsText({ ...WITH, others: null })).toContain(
      "devcorner did not list your other sessions this time.",
    );
    expect(
      sessionsText({
        ...base,
        thisConversation: { id: "dc-h3", name: null },
        others: { count: 3, items: [NOTES] },
      }).split("\n"),
    ).toEqual([
      "here    dc-h3  a/b · no session",
      "others  dc-s2  ann/notes · idle 2 h",
      "        and 2 more",
      SESSIONS_SEND,
    ]);
  });
});

describe("what waits on you, by work stream, latest first: /dc and /dc waits (dc-t492)", () => {
  const DAY = 24 * 60 * 60_000;
  /** When /dc speaks in these tests. */
  const NOW = Date.UTC(2026, 9, 23, 12);
  /** A work stream as devcorner lists it, its things the newest first. */
  const stream = (
    id: string,
    title: string,
    asks: string,
    count: number,
    days: number,
    items: [string, string][],
    repo: string | null = "a/b",
  ): StatusWait => ({
    id,
    title,
    asks,
    count,
    at: NOW - days * DAY,
    repo,
    page: id === "setup" ? LINKS.inbox : `https://dc.test/t/${id}`,
    items: items.map(([item, words]) => ({
      id: item,
      title: words,
      page: /^[a-z]+-[a-z]\d/.test(item) ? `https://dc.test/q/${item}` : null,
    })),
  });
  /** The canvas's queue (dc-t313's board "Waits on you, by work stream"), the newest first. */
  const WAITS: StatusWait[] = [
    stream(
      "dc-t423",
      "devcorner owns the changelog and the contract",
      "Decide 4",
      4,
      2,
      [
        ["dc-t423-q4", "Landed?"],
        ["dc-t423-q3", "Prose files"],
        ["dc-t423-q2", "Migrations"],
        ["dc-t423-q1", "Changelog"],
      ],
    ),
    stream(
      "dc-t206",
      "Work and navigation overhaul",
      "Decide 6 · Yours 1",
      7,
      2,
      [
        ["dc-t206-q18", "New screens"],
        ["dc-t237-q1", "Keep it?"],
        ["dc-t238", "Yours"],
        ["dc-t206-q17", "Phase two"],
        ["dc-t206-q16", "Finish done"],
        ["dc-t206-q15", "OA close"],
      ],
    ),
    stream(
      "dc-t359",
      "devcorner's own guidance as its system layer",
      "Decide 2",
      2,
      2,
      [
        ["dc-t445-q1", "Promote plugin 0.20.0"],
        ["dc-t368-q1", "Keep me-d147"],
      ],
    ),
    stream("dc-t331", "Work model, the engine", "Decide 1", 1, 2, [
      ["dc-t333-q1", "Stage rules"],
    ]),
    stream("dc-t16", "Hold first-run setup?", "Yours 1", 1, 3, [
      ["dc-t16", "Yours"],
    ]),
    stream(
      "dc-t312",
      "Reliable messages between your sessions",
      "Decide 1",
      1,
      5,
      [["dc-t316-q1", "Stop"]],
      "acme/notes",
    ),
    stream(
      "setup",
      "Your setup",
      "Reconnect 1",
      1,
      7,
      [["trig_01SHOP", "Shop"]],
      null,
    ),
  ];
  /**
   * A quiet picture with the queue: 20 streams wait, 7 listed, with 30 things
   * in all, as the canvas's 30 questions; its four newest hold 14, so 16
   * are not shown.
   */
  const QUEUE: Status = {
    ...WHOLE,
    waiting: 20,
    expanded: {
      ...PICTURE,
      firstWaiting: { ...PICTURE.firstWaiting },
      cloud: [],
      next: [
        { id: "dc-t5", title: "Export", page: "https://dc.test/t/dc-t5" },
        // Named by a stream already: next leaves it out.
        {
          id: "dc-t423",
          title: "devcorner owns the changelog and the contract",
          page: "https://dc.test/t/dc-t423",
        },
      ],
      code: null,
      waits: WAITS,
      waitingThings: 30,
    },
  };

  test("/dc lists the newest work streams under waits, in place of first, each with what it asks and how long ago, then how many more", () => {
    expect(WAITS_SHOWN).toBe(4);
    expect(lines(QUEUE, NOW)).toEqual([
      "devcorner · dc-s7@acme · Acme · Shop",
      "Project home · Active actions: 20 · In flight: 6",
      "here    ticket dc-t10@acme",
      "waits   dc-t423 devcorner owns the changelog and the contract · Decide 4 · 2 d ago",
      "        dc-t206 Work and navigation overhaul · Decide 6 · Yours 1 · 2 d ago",
      "        dc-t359 devcorner's own guidance as its system layer · Decide 2 · 2 d ago",
      "        dc-t331 Work model, the engine · Decide 1 · 2 d ago",
      "        16 more, in /dc waits and the inbox",
      "moving  3 live sessions · 1 run · 1 pull request · an OA",
      // The streams' ids and Next's share one column.
      "next    dc-t5   Export",
    ]);
    // The count is the lead line's alone, and no stream is said twice.
    const text = lines(QUEUE, NOW).join("\n");
    expect(text).not.toContain("on you");
    expect(text).not.toContain("first ");
    expect(text.match(/dc-t423/g)).toHaveLength(1);
    // Without the time, no age is said.
    expect(lines(QUEUE)[3]).toBe(
      "waits   dc-t423 devcorner owns the changelog and the contract · Decide 4",
    );
    // The row says the count alone.
    expect(row(QUEUE)).toBe("devcorner · s7 · waiting 20");
  });

  test("a stream says another repo's name, and devcorner's setup is said by its word", () => {
    const later: Status = {
      ...QUEUE,
      expanded: { ...QUEUE.expanded!, waits: WAITS.slice(4) },
      waiting: 3,
    };
    expect(lines(later, NOW).slice(3, 6)).toEqual([
      "waits   dc-t16  Hold first-run setup? · Yours 1 · 3 d ago",
      "        dc-t312 Reliable messages between your sessions · Decide 1 · 5 d ago · acme/notes",
      "        setup   Reconnect 1 · 7 d ago",
    ]);
  });

  test("streams that hold every thing that waits end with no more line", () => {
    const few: Status = {
      ...QUEUE,
      waiting: 2,
      expanded: {
        ...QUEUE.expanded!,
        waits: WAITS.slice(3, 5),
        waitingThings: 2,
      },
    };
    expect(lines(few, NOW).slice(3, 6)).toEqual([
      "waits   dc-t331 Work model, the engine · Decide 1 · 2 d ago",
      "        dc-t16  Hold first-run setup? · Yours 1 · 3 d ago",
      "moving  3 live sessions · 1 run · 1 pull request · an OA",
    ]);
  });

  test("next leaves out a ticket a stream /dc names and names one it leaves out; an older devcorner, which lists no streams, keeps first", () => {
    const withNext = (
      next: { id: string; title: string; page: string | null }[],
    ) => lines({ ...QUEUE, expanded: { ...QUEUE.expanded!, next } }).slice(-2);
    const export5 = {
      id: "dc-t5",
      title: "Export",
      page: "https://dc.test/t/dc-t5",
    };
    expect(
      withNext([
        {
          id: "dc-t359",
          title: "devcorner's own guidance as its system layer",
          page: "https://dc.test/t/dc-t359",
        },
        export5,
      ]),
    ).toEqual([
      "moving  3 live sessions · 1 run · 1 pull request · an OA",
      "next    dc-t5   Export",
    ]);
    // The fifth stream's ticket is not named above Next.
    expect(
      withNext([
        {
          id: "dc-t16",
          title: "Hold first-run setup?",
          page: "https://dc.test/t/dc-t16",
        },
        export5,
      ]),
    ).toEqual([
      "next    dc-t16  Hold first-run setup?",
      "        dc-t5   Export",
    ]);
    const older: Status = {
      ...QUEUE,
      expanded: { ...QUEUE.expanded!, waits: undefined },
    };
    expect(lines(older)[3]).toBe("first   dc-t4@acme Decide the name");
    // Nothing waits: no waits line, and no first.
    const none: Status = {
      ...QUEUE,
      waiting: 0,
      expanded: { ...QUEUE.expanded!, waits: [], waitingThings: 0 },
    };
    expect(
      lines(none).some((l) => l.startsWith("waits") || l.startsWith("first")),
    ).toBe(false);
  });
  test("a thing is named by what its stream's id does not say", () => {
    expect(waitItemName("dc-t423-q4", "dc-t423")).toBe("q4");
    expect(waitItemName("acme-t7-q2@acme", "acme-t7@acme")).toBe("q2");
    expect(
      waitItemName("dc-t237-q1@devcorner-app", "dc-t206@devcorner-app"),
    ).toBe("dc-t237-q1");
    // Its own ticket, session or run says itself; a routine's id is no name.
    expect(waitItemName("dc-t16", "dc-t16")).toBeNull();
    expect(waitItemName("dc-s4@acme", "dc-s4@acme")).toBeNull();
    expect(waitItemName("trig_01SHOP", "setup")).toBeNull();
    // A ticket whose id only starts like the stream's is another ticket.
    expect(waitItemName("dc-t4231", "dc-t423")).toBe("dc-t4231");
  });

  test("/dc waits says every stream devcorner listed with its things, then how many more, and the inbox's page", () => {
    expect(waitsText(QUEUE, NOW).split("\n")).toEqual([
      "waits   30 on you, by work stream, latest first",
      "        dc-t423 devcorner owns the changelog and the contract · Decide 4 · 2 d ago",
      "                q4 Landed? · q3 Prose files · q2 Migrations · q1 Changelog",
      "        dc-t206 Work and navigation overhaul · Decide 6 · Yours 1 · 2 d ago",
      "                q18 New screens · dc-t237-q1 Keep it? · dc-t238 Yours · q17 Phase two · q16 Finish done · q15 OA close · 1 more",
      "        dc-t359 devcorner's own guidance as its system layer · Decide 2 · 2 d ago",
      "                dc-t445-q1 Promote plugin 0.20.0 · dc-t368-q1 Keep me-d147",
      "        dc-t331 Work model, the engine · Decide 1 · 2 d ago",
      "                dc-t333-q1 Stage rules",
      "        dc-t16  Hold first-run setup? · Yours 1 · 3 d ago",
      "                Yours",
      "        dc-t312 Reliable messages between your sessions · Decide 1 · 5 d ago · acme/notes",
      "                dc-t316-q1 Stop",
      "        setup   Reconnect 1 · 7 d ago",
      "                Shop",
      "        and 13 more, in the inbox",
      `inbox: ${LINKS.inbox}`,
    ]);
    // Nothing waits, a part unread, an older devcorner.
    expect(
      waitsText({
        ...QUEUE,
        waiting: 0,
        expanded: { ...QUEUE.expanded!, waits: [], waitingThings: 0 },
      }),
    ).toBe(`waits   nothing waits on you\ninbox: ${LINKS.inbox}`);
    expect(
      waitsText({
        ...QUEUE,
        waiting: 0,
        couldNotRead: ["Your usage alerts could not be read."],
        expanded: { ...QUEUE.expanded!, waits: [], waitingThings: 0 },
      }).split("\n"),
    ).toEqual([
      "waits   ? on you, by work stream, latest first",
      "Your usage alerts could not be read.",
      `inbox: ${LINKS.inbox}`,
    ]);
    expect(waitsText(WHOLE)).toBe(WAITS_OLDER);
  });

  test("/dc waits asks devcorner for the picture and says every stream; only the exact word does it", async ($, on) => {
    const { clock, seen } = world(on);
    seen.answer = QUEUE;
    await $.session.start(START);
    await clock.settle();
    const out = (await $.command.run({
      command: "dc",
      args: "waits",
    } as never)) as { text: string };
    expect(seen.statusBodies.at(-1)).toMatchObject({
      hook_event_name: "Status",
      expanded: true,
    });
    expect(out.text.split("\n")[0]).toBe(
      "waits   30 on you, by work stream, latest first",
    );
    expect(out.text).toContain("q4 Landed? · q3 Prose files");
    await $.command.run({ command: "dc", args: "waits please" } as never);
    await clock.settle();
    expect(seen.submitted.at(-1)).toBe("devcorner: waits please");
  });
});
