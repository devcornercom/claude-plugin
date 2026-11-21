// devcorner's listener: one per Claude Code window, started by the plugin's
// module (hooks/register.tsx, `listen`) with `node`, and ended with it.
//
// It holds the window's sockets to devcorner's stores, which hibernate while
// they are idle, so an idle window asks devcorner nothing on a timer: the
// `Listen` hook event hands it a one-time ticket for each socket (the
// window's conversation in the person's own store, and the session it works
// as where that is kept), and it prints each frame a socket is sent as one
// line of JSON on standard output, ids only, for the module to act on. It
// alone reconnects, after a deploy, a lost connection or a change of the
// session the window works as (`{claim}`), waiting longer after each
// failure.
//
// Plain JavaScript with Node's own fetch and WebSocket (Node 22 or later), no
// dependency, run by its path with no shell, so it runs alike on macOS,
// Linux and Windows. What it needs comes on standard input, so the token is
// never in its arguments: { base, token, conversation, cursors, launcher,
// revive }, and `pingMs`, which only a test sets, to hear silence sooner.
//
// Lines it prints:
//   {"connected": 2}              its sockets are open
//   {"frame": {"wake": ..., ...}} a frame a socket was sent
//   {"down": "closed", "retry": ms}  it lost them, and tries again in ms
//   {"end": "refused"}            it stops (refused, gone, unsupported):
//                                 the module falls back to the held request

/** How often each socket says "ping", which the store answers without waking. */
const PING_MS = 30_000;
/** A socket that has answered nothing for this many pings' time is taken as gone. */
const SILENT_PINGS = 2.5;
/** The first wait after a failure, doubled each time, with jitter, up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 1_000;
/**
 * The longest wait between tries. Nothing else listens for the window while
 * the helper is down (the module holds no request while it runs), so this
 * bounds how late a wake is told once devcorner is back.
 */
const MAX_RETRY_MS = 60_000;
/** A connection that stayed up this long resets the wait. */
const STEADY_MS = 30_000;
/** How long devcorner may take to answer `Listen` or open a socket. */
const ASK_MS = 20_000;

const print = (line) => {
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    process.exit(0);
  }
};
// The module reads standard output: once it is gone, so is the window.
process.stdout.on("error", () => process.exit(0));

/** Says why it stops, then stops once the line is written: a pipe may write later. */
const end = (why) => {
  try {
    process.stdout.write(`${JSON.stringify({ end: why })}\n`, () =>
      process.exit(1),
    );
  } catch {
    process.exit(1);
  }
  // Nothing more runs meanwhile.
  return new Promise(() => {});
};

/** The store a message id is from, its number left out: me-m, ra-m@rangojs. */
const storeOf = (id) => String(id).replace(/-m\d+/, "-m");

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  if (typeof WebSocket !== "function" || typeof fetch !== "function")
    return end("no-websocket");
  let input;
  try {
    input = await readInput();
  } catch {
    return end("no-input");
  }
  const { base, token, conversation } = input;
  if (!base || !token || !conversation) return end("no-input");
  const ping =
    Number.isFinite(input.pingMs) && input.pingMs > 0 ? input.pingMs : PING_MS;
  // The newest id woken for in each store, sent with each Listen so a
  // socket that opens again gives no wake twice.
  const cursors = new Map(
    (Array.isArray(input.cursors) ? input.cursors : []).map((id) => [
      storeOf(id),
      id,
    ]),
  );
  // The window's parent: once it is gone (its Claude Code killed), so is
  // this helper, with no socket left open in its name. Windows keeps the
  // old ppid after the parent ends, so its being there is asked too.
  const parent = process.ppid;
  const orphaned = () => {
    if (process.ppid !== parent) return true;
    try {
      process.kill(parent, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  let failures = 0;

  for (;;) {
    // Before each Listen too: one posted for a window that is gone would
    // mark its conversation heard and its launcher live.
    if (orphaned()) process.exit(0);
    const began = Date.now();
    const why = await connectOnce();
    if (orphaned()) process.exit(0);
    if (Date.now() - began >= STEADY_MS) failures = 0;
    let wait;
    if (typeof why === "number") {
      // devcorner is updating: as long as it said.
      wait = why;
    } else if (why === "claim") {
      // The session the window works as changed: its sockets, at once.
      wait = 0;
    } else {
      failures += 1;
      const top = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
      wait = Math.round(top / 2 + Math.random() * (top / 2));
    }
    print({ down: typeof why === "number" ? "updating" : why, retry: wait });
    await sleep(wait);
  }

  /**
   * Asks for tickets, opens a socket with each, and holds them until one
   * closes or falls silent: answers why it stopped ("closed", "silent",
   * "claim", "failed"), or how long devcorner asked to be left (updating).
   * Ends the helper where devcorner refuses it.
   */
  async function connectOnce() {
    let res;
    try {
      res = await fetch(`${base}/mcp/hooks/claude-code`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hook_event_name: "Listen",
          session_id: conversation,
          launcher: input.launcher === true,
          revive: input.revive === true,
          ...(cursors.size > 0 ? { cursors: [...cursors.values()] } : {}),
        }),
        signal: AbortSignal.timeout(ASK_MS),
      });
    } catch {
      return "failed";
    }
    // A devcorner older than `Listen` answers it with nothing.
    if (res.status === 204) return end("unsupported");
    // A refusal asking again would not change (signed out, revoked, a body
    // it cannot read): the module falls back to the held request, which
    // says why. Too many asks, or one that timed out, is tried again.
    if (
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 408 &&
      res.status !== 429
    )
      return end("refused");
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 503 && body?.error === "updating") {
      const said = Number(res.headers.get("retry-after") ?? body.retryAfter);
      return (Number.isFinite(said) && said > 0 ? said : 5) * 1000;
    }
    if (!res.ok) return "failed";
    // devcorner knows no open conversation of this id: nothing to hold.
    if (body?.session === null) return end("gone");
    const urls = Array.isArray(body?.sockets) ? body.sockets : [];
    if (urls.length === 0) return "failed";
    return hold(urls);
  }

  /**
   * Holds a socket with each address until one that opened closes or falls
   * silent. One refused as it opens (a session that is not live) is left
   * out, as a held request leaves it, and the others hold; none opened is a
   * failure.
   */
  function hold(urls) {
    return new Promise((done) => {
      // Each open socket, with when it was last heard: each its own, so one
      // half-open is not kept alive by another's pongs.
      const sockets = new Map();
      // Every socket made, open or still opening: each is closed as the hold
      // ends, so one that opens later is not left beside the next hold's.
      const made = [];
      let settled = 0;
      let over = false;
      const finish = (why) => {
        if (over) return;
        over = true;
        clearInterval(ticker);
        clearTimeout(opening);
        for (const ws of made) {
          try {
            ws.close(1000, "done");
          } catch {
            // Closed already.
          }
        }
        done(why);
      };
      // Each address is settled once: open, or refused before it opened.
      const opened = () => {
        if (++settled < urls.length) return;
        clearTimeout(opening);
        if (sockets.size === 0) finish("failed");
        else print({ connected: sockets.size });
      };
      const opening = setTimeout(() => finish("failed"), ASK_MS);
      const ticker = setInterval(() => {
        if (orphaned()) process.exit(0);
        const now = Date.now();
        for (const [ws, heard] of sockets) {
          if (now - heard > ping * SILENT_PINGS) return finish("silent");
          try {
            ws.send("ping");
          } catch {
            return finish("closed");
          }
        }
      }, ping);
      for (const url of urls) {
        let ws;
        try {
          ws = new WebSocket(url);
        } catch {
          opened();
          continue;
        }
        made.push(ws);
        // "opening", then "open", or "left" when refused as it opened.
        let state = "opening";
        ws.addEventListener("open", () => {
          if (over) return;
          state = "open";
          sockets.set(ws, Date.now());
          opened();
        });
        ws.addEventListener("message", (event) => {
          if (over) return;
          sockets.set(ws, Date.now());
          if (typeof event.data !== "string" || event.data === "pong") return;
          let frame;
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }
          if (frame === null || typeof frame !== "object") return;
          if (typeof frame.wake === "string" && typeof frame.id === "string") {
            cursors.set(storeOf(frame.id), frame.id);
            // Said back, so the store records the wake as reaching this
            // window; one sent into a socket that had died is given again.
            try {
              ws.send(JSON.stringify({ woke: frame.id }));
            } catch {
              // Closing: the next socket is given it again.
            }
          }
          print({ frame });
          // The session the window works as changed: the sockets it waits
          // on may be other ones now, so it asks for them again.
          if (typeof frame.claim === "string") finish("claim");
        });
        const gone = () => {
          if (over) return;
          if (state === "open") return finish("closed");
          if (state === "left") return;
          state = "left";
          opened();
        };
        ws.addEventListener("close", gone);
        ws.addEventListener("error", gone);
      }
    });
  }
}

main().catch(() => end("failed"));
