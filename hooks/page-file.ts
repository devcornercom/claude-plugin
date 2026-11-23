// How the window fetches a file the person's words from devcorner's page
// sent: a shell runs curl, which posts the hook route's `ChatFile` asking for
// the bytes themselves (`raw`) and writes them to the file as they come, so
// no byte passes through the plugin's runtime, whose fetch hands over a
// body only as text and gave up on a file of a few megabytes as base64 in
// JSON. Kept apart from the hooks, with nothing to import, so a test of the
// repo's runs the script itself against a server (`test/page-file.test.ts`).

/** How long curl may take for one file, in seconds: 10 MB on a slow uplink. */
export const PAGE_FILE_SECONDS = 120;

/** How long curl may take to reach devcorner, in seconds (`--connect-timeout`). */
export const PAGE_FILE_CONNECT_SECONDS = 15;

/**
 * The script, run as `sh -c PAGE_FILE_SCRIPT sh <path> <url> <event JSON>
 * <seconds>` with the request's headers on standard input, one a line, so the
 * hook token is never in a command line another user of the machine could
 * read. The file is written readable by its owner alone, whole or not at
 * all: into `<path>.new`, moved over `<path>` once complete. It exits 0 once
 * the file is there; with curl's own exit status when the request failed
 * (6 or 7 never reached devcorner, 28 timed out or could not connect in
 * time, 23 could not write), with curl's words on standard error; 120 when
 * the folder could not be made, 122 when the file could not be moved into
 * place; and 121 when devcorner answered other than 200, printing its status
 * on the first line and the start of its answer after it. The event's JSON
 * starts with `{`, so curl never reads it as `@file`.
 */
export const PAGE_FILE_SCRIPT = [
  'umask 077 && mkdir -p "${1%/*}" || exit 120',
  `code=$(curl -sS --connect-timeout ${PAGE_FILE_CONNECT_SECONDS} --max-time "$4" -H @- --data-binary "$3" -o "$1.new" -w "%{http_code}" -- "$2")`,
  "got=$?",
  'if [ "$got" -ne 0 ]; then rm -f "$1.new"; exit "$got"; fi',
  'if [ "$code" != 200 ]; then printf "%s\\n" "$code"; head -c 2000 "$1.new"; rm -f "$1.new"; exit 121; fi',
  'mv -f "$1.new" "$1" || exit 122',
].join("\n");

/** What the script's run came to: null once the file is there, else why not, in words for the line the typed words carry. */
export function pageFileProblem(run: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string | null {
  const said = curlWords(run.stderr);
  switch (run.exitCode) {
    case 0:
      return null;
    case 121:
      return devcornerAnswered(run.stdout);
    case 6:
    case 7:
      return `devcorner could not be reached${said ? ` (${said})` : ""}`;
    case 28:
      // curl exits 28 for both --connect-timeout and --max-time: its words
      // say which one ran out.
      return connectTimedOut(said)
        ? `it could not connect within ${PAGE_FILE_CONNECT_SECONDS} s`
        : `it timed out after ${PAGE_FILE_SECONDS} s`;
    case 23:
    case 120:
    case 122:
      return `it could not be written${said ? ` (${said})` : ""}`;
    case 127:
      return "curl, which fetches it, is not installed on this machine";
    default:
      return `the fetch failed${said ? ` (${said})` : ` (curl exit ${run.exitCode})`}`;
  }
}

/** curl's own words on standard error, its "curl: (7) " prefix left out, on one line and short. */
function curlWords(stderr: string): string {
  return stderr
    .replace(/^curl: \(\d+\)\s*/m, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Whether curl's exit 28 came from the connect timeout, not the whole one: only its words say. */
function connectTimedOut(said: string): boolean {
  return /^(?:Failed to connect|Connection timed out)\b/.test(said);
}

/** devcorner's answer other than 200: its own words when it gave them as `error`, else its status. */
function devcornerAnswered(stdout: string): string {
  const cut = stdout.indexOf("\n");
  const status = (cut === -1 ? stdout : stdout.slice(0, cut)).trim();
  try {
    const body = JSON.parse(cut === -1 ? "" : stdout.slice(cut + 1)) as {
      error?: unknown;
    };
    if (typeof body.error === "string" && body.error.trim() !== "")
      return body.error.trim();
  } catch {
    // Not JSON, or cut at 2000 bytes: its status says it.
  }
  return `devcorner answered ${status || "nothing"}`;
}
