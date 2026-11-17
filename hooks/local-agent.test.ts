// The plugin's answer to devcorner's subagent tool on a laptop: the call's
// own gate, what it needs on the machine, the first-use question, the round
// begun and ended on devcorner's hook route, the launcher spawned with its
// spec on standard input, and the result the model reads.

import { describe, expect, test } from "claude-code/testing";
import type { On } from "claude-code";
import {
  LOCAL_AGENT,
  LOCAL_AGENT_ANSWER,
  LOCAL_AGENT_ENV,
  LOCAL_DECLINED,
  LOCAL_IN_CLOUD,
  LOCAL_NO_SESSION,
  LOCAL_NOBODY_FIRST,
  LOCAL_SIGNED_OUT,
  SUBAGENT_CALL,
  childResultText,
  installedLauncher,
  launcherSpec,
  localFirstUse,
  localNobodyText,
  nodeRunsLocalAgent,
  readRoundLine,
  subagentCallOf,
  type RoundLines,
} from "./register";

const TOOL = "mcp__Devcorner__subagent";
const NODE = "/home/ann/.nvm/versions/node/v24.7.0/bin/node";
const STATE = "/home/ann/.cache/devcorner";
const STUB = "/home/ann/stub-launcher.js";
const CALL = {
  tool: TOOL,
  subagent_type: "edit",
  description: "rename the cart",
  prompt: "Rename Cart to Basket in src/cart.ts.",
};

/** What devcorner answers a ChildBegin with, as the hook route does today. */
const BEGUN = {
  child: "dc-s7@acme",
  round: 1,
  credential: "dck_secret",
  expires_at: "2026-11-16T20:20:00.000Z",
  minutes: 15,
  budget_usd: 1,
  repo: "acme/shop",
  mcp: "http://dc.test/mcp",
};

/** A round's lines, as the launcher writes them. */
const LINES = [
  {
    type: "child-started",
    child: "c1",
    kind: "edit",
    model: "deepseek-v4.1-flash-1017",
    effort: "max",
  },
  { type: "tool", child: "c1", tool: "edit" },
  {
    type: "child-answer",
    child: "c1",
    round: 1,
    answer: "Renamed Cart to Basket.",
    change: {
      files: ["src/cart.ts"],
      patch: `${STATE}/local-agent/children/dc-s7@acme/1.patch`,
      kept: null,
    },
  },
  {
    type: "child-ended",
    child: "c1",
    outcome: "done",
    ms: 92_000,
    usd: 0.024,
    tokensIn: 1000,
    tokensOut: 200,
    reason: null,
  },
];

function laptop(
  on: On,
  options: {
    env?: Record<string, string | undefined>;
    /** The plugin's store; unless told, its person said yes to local subagents. */
    store?: Record<string, unknown>;
    /** What `node --version` prints. */
    nodeVersion?: string;
    /** What origin's HEAD names; null for a clone that has none. */
    originHead?: string | null;
    claim?: string | null;
    decision?: "allow" | "ask" | "deny";
    /** The person's answer to each question, in order; null where nobody can be asked. */
    answers?: (string | null)[];
    /** The launcher's lines; a string is written as it is. */
    lines?: (object | string)[];
    exit?: { code: number | null; signal: string | null };
    stderr?: string;
    begin?: { status: number; body: unknown }[];
    files?: string[];
    processRefused?: boolean;
  } = {},
) {
  const stored = new Map<string, unknown>(
    Object.entries(options.store ?? { [LOCAL_AGENT_ANSWER]: "yes" }),
  );
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
  const variables: Record<string, string | undefined> = {
    DEVCORNER_URL: "http://dc.test",
    DEVCORNER_TOKEN: "dch_machine",
    HOME: "/home/ann",
    SHELL: "/bin/zsh",
    [LOCAL_AGENT_ENV]: STUB,
    ...options.env,
  };
  on("env.get", async (_$, e) => ({ value: variables[e.name] }));
  on("session.id", async () => ({ value: "conversation-1" }));
  on("session.cwd", async () => ({ value: "/work/shop/src" }));
  const claim = options.claim === undefined ? "dc-s5@acme" : options.claim;
  const files = new Set(options.files ?? [NODE]);
  on("fs.exists", async (_$, e) => ({
    value: files.has(e.path) || (e.path.endsWith(".claim") && claim !== null),
  }));
  on("fs.read", async (_$, e) => {
    if (e.path.endsWith(".claim") && claim !== null)
      return { value: `${claim}\n` };
    return { deny: "missing" };
  });
  const seen = {
    store: stored,
    events: [] as {
      name: string;
      body: Record<string, unknown>;
      token: string;
    }[],
    runs: [] as string[][],
    spawns: [] as {
      argv: readonly string[];
      cwd?: string;
      env?: Record<string, string>;
      input?: string;
    }[],
    asks: [] as string[],
    checks: [] as { tool: string; input: unknown }[],
    logs: [] as string[],
  };
  const begins = [...(options.begin ?? [])];
  on("http.fetch", async (_$, e) => {
    const body = JSON.parse(String(e.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    const token = String(
      (e.init?.headers as Record<string, string> | undefined)?.Authorization ??
        "",
    ).replace(/^Bearer /, "");
    const name = String(body.hook_event_name);
    seen.events.push({ name, body, token });
    const reply = (status: number, answer: unknown) => ({
      value: {
        status,
        ok: status === 200,
        headers: {},
        text: JSON.stringify(answer),
      },
    });
    if (name === "SubagentToken")
      return reply(200, {
        token: `dcs_${seen.events.filter((s) => s.name === name).length}`,
        session: body.claim,
      });
    if (name === "ChildBegin" || name === "ChildResume") {
      const next = begins.shift() ?? { status: 200, body: BEGUN };
      return reply(next.status, next.body);
    }
    if (name === "ChildEnd") return reply(200, { ok: true, ended: 1 });
    return reply(404, {});
  });
  const ran = (stdout: string, exitCode = 0) => ({
    value: {
      exitCode,
      stdout,
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  });
  on("process.run", async (_$, e) => {
    seen.runs.push([...e.argv]);
    const [first] = e.argv;
    if (first === "true") {
      if (options.processRefused) throw new Error("$.process is CLI only");
      return ran("");
    }
    if (first === "/bin/zsh") return ran(`Welcome\n${NODE}\n`);
    if (first === NODE && e.argv[1] === "--version")
      return ran(`${options.nodeVersion ?? "v24.7.0"}\n`);
    if (first === "git" && e.argv.includes("--show-toplevel"))
      return ran("/work/shop\n");
    if (first === "git" && e.argv.includes("--show-current"))
      return ran("feature\n");
    if (first === "git" && e.argv.includes("symbolic-ref"))
      return options.originHead === null
        ? ran("", 1)
        : ran(`${options.originHead ?? "origin/main"}\n`);
    if (first === "git" && e.argv.includes("--verify"))
      return ran("", e.argv.at(-1) === "refs/remotes/origin/master" ? 0 : 1);
    return ran("");
  });
  on("process.spawn", async function* (_$, e) {
    seen.spawns.push({ ...e, env: e.env ? { ...e.env } : undefined });
    if (options.stderr)
      yield { stream: "stderr" as const, text: options.stderr };
    for (const line of options.lines ?? LINES) {
      const text =
        typeof line === "string" ? line : `${JSON.stringify(line)}\n`;
      // Written in two pieces, as a pipe may split a line.
      yield { stream: "stdout" as const, text: text.slice(0, 7) };
      yield { stream: "stdout" as const, text: text.slice(7) };
    }
    return { value: options.exit ?? { code: 0, signal: null } } as never;
  });
  // The session's rules for the subagent tool; its questions to the person
  // are allowed.
  on("tool.check", async (_$, e) => {
    if (e.tool !== TOOL) return { decision: "allow" };
    seen.checks.push({ tool: e.tool, input: e.input });
    return { decision: options.decision ?? "allow" };
  });
  const answers = [...(options.answers ?? [])];
  on("tool.call", { tool: "AskUserQuestion" }, async (_$, e) => {
    const questions = (e as { questions: { question: string }[] }).questions;
    seen.asks.push(questions[0]!.question);
    const answer = answers.shift();
    if (answer === undefined || answer === null)
      return { deny: "No one is here to answer." };
    return {
      result: { questions, answers: { [questions[0]!.question]: answer } },
    } as never;
  });
  on("ui.log", async (_$, e) => {
    seen.logs.push(e.text);
    return { value: undefined };
  });
  return seen;
}

/** The text of a call's result, or of its refusal. */
function said(got: { result?: unknown; text?: string; deny?: string }): string {
  return String(got.deny ?? got.text ?? got.result ?? "");
}

describe("a subagent call answered on this laptop", () => {
  test("the hook answers devcorner's subagent by the connector's name or the plugin's, and no other", () => {
    for (const tool of [
      "mcp__Devcorner__subagent",
      "mcp__plugin_devcorner_devcorner__subagent",
      "mcp__claude_ai_devcorner__subagent",
    ])
      expect(SUBAGENT_CALL.test(tool)).toBe(true);
    for (const tool of [
      "mcp__linear__subagent",
      "Agent",
      "mcp__Devcorner__subagents",
    ])
      expect(SUBAGENT_CALL.test(tool)).toBe(false);
  });

  test("a call runs the launcher in the repo's root with the spec on its standard input and no hook token, and ends the round", async ($, on) => {
    const seen = laptop(on);
    const got = await $.tool.call(CALL as never);
    expect(got.isError).toBeUndefined();
    const text = said(got);
    expect(text).toContain(
      "Subagent c1 (session dc-s7@acme, edit on deepseek-v4.1-flash-1017 at max) ended done after 1 min 32 s, spending $0.0240 by its own reckoning.",
    );
    expect(text).toContain('resume: "dc-s7@acme"');
    expect(text).toContain("Renamed Cart to Basket.");
    expect(text).toContain(
      `git apply --check ${STATE}/local-agent/children/dc-s7@acme/1.patch`,
    );
    // The token is made with the machine's hook token for the window's
    // session; the round is begun and ended with the subagent token alone.
    expect(seen.events.map((e) => [e.name, e.token])).toEqual([
      ["SubagentToken", "dch_machine"],
      ["ChildBegin", "dcs_1"],
      ["ChildEnd", "dcs_1"],
    ]);
    expect(seen.events[0]!.body.claim).toBe("dc-s5@acme");
    expect(seen.events[1]!.body).toMatchObject({
      subagent_type: "edit",
      description: "rename the cart",
      branch: "feature",
    });
    expect(seen.events[1]!.body).not.toHaveProperty("prompt");
    expect(seen.events[2]!.body).toMatchObject({
      child: "dc-s7@acme",
      round: 1,
      outcome: "done",
      ms: 92_000,
    });
    expect(seen.spawns).toHaveLength(1);
    const [spawn] = seen.spawns;
    expect(spawn!.argv).toEqual([NODE, STUB, "run"]);
    expect(spawn!.cwd).toBe("/work/shop");
    expect(spawn!.env).toEqual({ DEVCORNER_TOKEN: "" });
    const spec = JSON.parse(spawn!.input!);
    expect(spec).toMatchObject({
      session: "dc-s7@acme",
      kind: "edit",
      round: 1,
      prompt: CALL.prompt,
      base: "main",
      capUsd: 1,
      credential: "dck_secret",
      mcp: "http://dc.test/mcp",
      children: `${STATE}/local-agent/children`,
    });
    expect(JSON.stringify(spec)).not.toContain("dch_machine");
    expect(seen.checks).toEqual([
      {
        tool: TOOL,
        input: {
          subagent_type: "edit",
          description: "rename the cart",
          prompt: CALL.prompt,
        },
      },
    ]);
  });

  test("calls side by side share one subagent token, and a window keeps it for the next call", async ($, on) => {
    const seen = laptop(on);
    await Promise.all([$.tool.call(CALL as never), $.tool.call(CALL as never)]);
    await $.tool.call(CALL as never);
    expect(seen.events.filter((e) => e.name === "SubagentToken")).toHaveLength(
      1,
    );
    expect(
      seen.events.filter((e) => e.name === "ChildBegin").map((e) => e.token),
    ).toEqual(["dcs_1", "dcs_1", "dcs_1"]);
  });

  test("a held token refused as expired is made again once; any other refusal is devcorner's words and runs nothing", async ($, on) => {
    const seen = laptop(on, {
      begin: [
        { status: 401, body: { error: "expired" } },
        { status: 200, body: BEGUN },
        {
          status: 429,
          body: { error: "You began 40 rounds of local subagents today." },
        },
      ],
    });
    expect(said(await $.tool.call(CALL as never))).toContain("ended done");
    expect(seen.events.map((e) => [e.name, e.token])).toEqual([
      ["SubagentToken", "dch_machine"],
      ["ChildBegin", "dcs_1"],
      ["SubagentToken", "dch_machine"],
      ["ChildBegin", "dcs_2"],
      ["ChildEnd", "dcs_2"],
    ]);
    const refused = await $.tool.call(CALL as never);
    expect(said(refused)).toBe("You began 40 rounds of local subagents today.");
    expect(seen.spawns).toHaveLength(1);
  });

  test("calls side by side refused with the expired token make one new token between them", async ($, on) => {
    const seen = laptop(on, {
      begin: [
        { status: 200, body: BEGUN },
        { status: 401, body: { error: "expired" } },
        { status: 401, body: { error: "expired" } },
      ],
    });
    await $.tool.call(CALL as never);
    await Promise.all([$.tool.call(CALL as never), $.tool.call(CALL as never)]);
    expect(seen.events.filter((e) => e.name === "SubagentToken")).toHaveLength(
      2,
    );
    expect(
      seen.events.filter((e) => e.name === "ChildBegin").map((e) => e.token),
    ).toEqual(["dcs_1", "dcs_1", "dcs_1", "dcs_2", "dcs_2"]);
  });

  test("a resume sends ChildResume naming the child, and its spec takes the kind and round devcorner gives", async ($, on) => {
    const seen = laptop(on, {
      begin: [
        {
          status: 200,
          body: { ...BEGUN, round: 2, kind: "edit", credential: "dck_two" },
        },
      ],
    });
    await $.tool.call({
      tool: TOOL,
      resume: "dc-s7@acme",
      prompt: "Also rename it in the tests.",
    } as never);
    expect(seen.events[1]).toMatchObject({
      name: "ChildResume",
      body: { child: "dc-s7@acme" },
    });
    expect(JSON.parse(seen.spawns[0]!.input!)).toMatchObject({
      session: "dc-s7@acme",
      round: 2,
      kind: "edit",
      prompt: "Also rename it in the tests.",
    });
  });

  test("a deny rule refuses and runs nothing", async ($, on) => {
    const deny = laptop(on, { decision: "deny" });
    expect(said(await $.tool.call(CALL as never))).toContain("denies");
    expect(deny.events).toEqual([]);
  });

  test("an ask is put to the person in a window, and Run it runs the child", async ($, on) => {
    const seen = laptop(on, { decision: "ask", answers: ["Run it"] });
    expect(said(await $.tool.call(CALL as never))).toContain("ended done");
    expect(seen.asks).toHaveLength(1);
    expect(seen.asks[0]).toContain(
      "start a local subagent (edit: rename the cart)",
    );
    expect(seen.asks[0]!.endsWith("?")).toBe(true);
  });

  test("an ask the person turns down runs nothing", async ($, on) => {
    const seen = laptop(on, { decision: "ask", answers: ["Don't run it"] });
    expect(said(await $.tool.call(CALL as never))).toBe(
      "The person did not let devcorner's subagent run.",
    );
    expect(seen.events).toEqual([]);
    expect(seen.spawns).toEqual([]);
  });

  test("in claude -p an ask is refused, naming the allow rule to add", async ($, on) => {
    const seen = laptop(on, { decision: "ask", answers: [null] });
    expect(said(await $.tool.call(CALL as never))).toBe(localNobodyText(TOOL));
    expect(seen.spawns).toEqual([]);
  });

  test("a machine with no hook token is told to sign in", async ($, on) => {
    laptop(on, { env: { DEVCORNER_TOKEN: undefined } });
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_SIGNED_OUT);
  });

  test("a cloud session, never signed in, is told to use the Agent tool, not to sign in", async ($, on) => {
    laptop(on, {
      env: { DEVCORNER_TOKEN: undefined, CLAUDE_CODE_REMOTE: "true" },
    });
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_IN_CLOUD);
  });

  test("a window that has not started is told to call start first", async ($, on) => {
    laptop(on, { claim: null });
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_NO_SESSION);
  });

  test("where $.process is refused, the desktop app's or an IDE's, the call says the command line runs it", async ($, on) => {
    laptop(on, { processRefused: true });
    expect(said(await $.tool.call(CALL as never))).toContain(
      "Local subagents need Claude Code's command line on this machine; use the Agent tool here.",
    );
  });

  test("a Node older than 22.19 is refused, naming it, its version read at each call", async ($, on) => {
    laptop(on, {
      store: { [LOCAL_AGENT_ANSWER]: "yes", localAgentNode: NODE },
      nodeVersion: "v22.18.0",
    });
    expect(said(await $.tool.call(CALL as never))).toBe(
      `Local subagents need Node 22.19 or later; ${NODE} is v22.18.0. /dc local-agent install looks for Node again.`,
    );
    expect(nodeRunsLocalAgent("v22.19.0")).toBe(true);
    expect(nodeRunsLocalAgent("v23.0.1")).toBe(true);
    expect(nodeRunsLocalAgent("v20.11.0")).toBe(false);
    expect(nodeRunsLocalAgent("node")).toBe(false);
  });

  test("the first use asks once, trust before size, and its yes stands for the call's own", async ($, on) => {
    const seen = laptop(on, {
      store: {},
      decision: "ask",
      answers: ["Run them"],
    });
    expect(said(await $.tool.call(CALL as never))).toContain("ended done");
    // A launcher on the machine already: nothing to download, so no size.
    expect(seen.asks).toEqual([localFirstUse(false)]);
    expect(seen.store.get(LOCAL_AGENT_ANSWER)).toBe("yes");
    const installs = localFirstUse(true);
    expect(installs.indexOf("as you")).toBeLessThan(installs.indexOf("26 MB"));
    expect(installs.endsWith("Run devcorner's subagents on this laptop?")).toBe(
      true,
    );
  });

  test("calls side by side on a new machine ask the first-use question once", async ($, on) => {
    const seen = laptop(on, { store: {}, answers: ["Run them"] });
    const got = await Promise.all([
      $.tool.call(CALL as never),
      $.tool.call(CALL as never),
    ]);
    expect(got.map((g) => said(g).includes("ended done"))).toEqual([
      true,
      true,
    ]);
    expect(seen.asks).toHaveLength(1);
  });

  test("Not now is kept and refuses until /dc local-agent install", async ($, on) => {
    const seen = laptop(on, { store: {}, answers: ["Not now"] });
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_DECLINED);
    expect(seen.store.get(LOCAL_AGENT_ANSWER)).toBe("no");
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_DECLINED);
    expect(seen.asks).toHaveLength(1);
    expect(seen.spawns).toEqual([]);
  });

  test("where nobody can answer the first-use question, the call says how to say yes", async ($, on) => {
    laptop(on, { store: {}, answers: [null] });
    expect(said(await $.tool.call(CALL as never))).toBe(LOCAL_NOBODY_FIRST);
  });

  test("with the package unpublished and no launcher named, nothing is asked or installed and the call says so", async ($, on) => {
    const seen = laptop(on, {
      store: {},
      env: { [LOCAL_AGENT_ENV]: undefined },
    });
    expect(LOCAL_AGENT.integrity).toBeNull();
    expect(said(await $.tool.call(CALL as never))).toContain(
      `devcorner's local agent ${LOCAL_AGENT.version} is not on npm yet`,
    );
    expect(seen.asks).toEqual([]);
    expect(seen.runs.some((argv) => argv.includes("install"))).toBe(false);
  });

  test("an installed launcher runs with the person's earlier yes and no question", async ($, on) => {
    const launcher = installedLauncher(`${STATE}/local-agent`);
    const seen = laptop(on, {
      env: { [LOCAL_AGENT_ENV]: undefined },
      files: [NODE, launcher],
    });
    expect(said(await $.tool.call(CALL as never))).toContain("ended done");
    expect(seen.asks).toEqual([]);
    expect(seen.spawns[0]!.argv).toEqual([NODE, launcher, "run"]);
  });

  test("a review reads against origin's default branch, else origin's main or master", async ($, on) => {
    const seen = laptop(on, { originHead: null });
    await $.tool.call(CALL as never);
    expect(JSON.parse(seen.spawns[0]!.input!).base).toBe("master");
  });

  test("a launcher that ends before its round is the call's error with what it said, and the round is ended as an error", async ($, on) => {
    const seen = laptop(on, {
      lines: [],
      exit: { code: 2, signal: null },
      stderr:
        "local-agent: served must name the child's model and its pinned serving.\n",
    });
    expect(said(await $.tool.call(CALL as never))).toBe(
      "devcorner's local agent ended (exit 2) before its round ended: local-agent: served must name the child's model and its pinned serving.",
    );
    expect(seen.events.at(-1)).toMatchObject({
      name: "ChildEnd",
      body: { outcome: "error" },
    });
  });
});

describe("the pieces of a local round", () => {
  test("a call's arguments: the task, then a new child's kind and words or the child to resume", () => {
    expect(subagentCallOf({ prompt: " " })).toBe(
      "prompt must say the whole task: the child knows nothing else.",
    );
    expect(subagentCallOf({ prompt: "x", subagent_type: "edit" })).toBe(
      "A new child needs subagent_type and description; resume names an earlier child to continue.",
    );
    expect(subagentCallOf({ prompt: "x", resume: " dc-s7 " })).toEqual({
      resume: "dc-s7",
      kind: null,
      description: null,
      prompt: "x",
      minutes: undefined,
      budget_usd: undefined,
    });
  });

  test("the spec is devcorner's answer named as the launcher reads it, with what the laptop knows", () => {
    const spec = launcherSpec(BEGUN, {
      ask: subagentCallOf({ ...CALL }) as never,
      base: "main",
      children: "/c",
      now: Date.parse("2026-11-16T20:00:00.000Z"),
    });
    expect(spec).toMatchObject({
      session: "dc-s7@acme",
      kind: "edit",
      round: 1,
      capUsd: 1,
      deadline: "2026-11-16T20:15:00.000Z",
      prompt: CALL.prompt,
      base: "main",
      children: "/c",
    });
    // What devcorner decides wins over the laptop's reckoning.
    expect(
      launcherSpec(
        { ...BEGUN, deadline: "2026-11-16T20:10:00.000Z", name: "c3" },
        {
          ask: subagentCallOf({ ...CALL }) as never,
          base: "main",
          children: "/c",
          now: 0,
        },
      ),
    ).toMatchObject({ deadline: "2026-11-16T20:10:00.000Z", name: "c3" });
  });

  test("the result cuts a long answer at 16 KB and names a kept clone", () => {
    const kept: RoundLines = { started: null, answer: null, ended: null };
    readRoundLine(kept, "not json");
    readRoundLine(
      kept,
      JSON.stringify({
        type: "child-answer",
        answer: "é".repeat(10_000),
        change: {
          files: [],
          patch: null,
          kept: { dir: "/c/x/c1", why: "its patch could not be written" },
        },
      }),
    );
    readRoundLine(
      kept,
      JSON.stringify({
        type: "child-ended",
        outcome: "budget",
        ms: 4_000,
        usd: null,
        reason: "it reached its cap",
      }),
    );
    const text = childResultText("dc-s7", kept);
    expect(text).toContain("ended budget (it reached its cap) after 4 s.");
    expect(text).toContain("[its answer is cut here: 3616 more bytes]");
    expect(text).toContain(
      "Its clone is kept at /c/x/c1: its patch could not be written.",
    );
  });
});
