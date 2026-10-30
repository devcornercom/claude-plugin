#!/bin/sh
# Passes a Claude Code hook event to devcorner. The event's name is the first
# argument, as hooks.json gives it.
#
# SessionStart, SessionEnd and SubagentStart are passed on as they are, with
# the repo and branch that only this side can read from git. devcorner answers
# the two starts with the JSON Claude Code adds to the model's context. A
# SessionStart also says the session its conversation states it runs as
# (dc-t588): the one the conversation's own start returned, which the
# plugin's module keeps in a file of its own (claimFile in register.tsx), so
# devcorner ties the window back to it before it briefs a resume or a
# compaction.
#
# PostToolUse, UserPromptSubmit and Stop ask devcorner for messages the session
# has not seen, and SubagentStop tells it a subagent stopped. For these, only
# the ids of the conversation and of the subagent are sent: the prompt, the
# tool's input and output and the model's last message never leave this
# machine. SubagentStop adds one number, how many background tasks the
# subagent started itself still run (dc-t576): a subagent that ends its turn to
# wait on its own background work, as one does for a check longer than a
# foreground command may run, has not stopped, and Claude Code resumes it when
# that work ends, so devcorner leaves its session and its run alone. Claude
# Code lists every task in flight in the conversation, with no word of whose it
# is, so a task counts when its id is in the subagent's own transcript, other
# than as the name of an agent's worktree or transcript, which this reads on
# this machine and never sends. With no such list (an older
# Claude Code) or no transcript to read, the number is left out, and devcorner
# takes the stop as one that may yet resume.
#
# PostToolUse runs after every tool call, so it asks devcorner at most once
# every DEVCORNER_HOOK_EVERY seconds (10 unless set, 0 for every call), and
# after a call to devcorner fails, none of the three asks again for a minute.
# When devcorner is not running, this prints nothing and Claude Code carries
# on as usual.
#
# In the main conversation the three ask only when something waits (dc-t173).
# The plugin's module (register.tsx) asks devcorner's Status event at the
# start of the session, every 30 s while a turn runs and as a turn ends, and
# writes what it says to a marker, one small file per conversation: how many
# messages a prompt's hook would hand over now, and when it heard. While the
# marker says none, the hooks stay quiet, and so they do while it counts only
# what an ask of theirs since then handed over: the module is the marker's one
# writer, and the hooks keep when they last handed everything over in their
# own stamp, so neither can write over what the other learnt later (dc-t179).
# Since the module cannot hear of a message that wakes nothing while the
# conversation is idle, they ask anyway
# once the marker and their own last ask are both DEVCORNER_HOOK_FALLBACK
# seconds old (300 unless set): the first prompt after five minutes' quiet
# asks, and nothing that waits is ever left for longer than that in a working
# conversation. With no marker (no module, as in a plain -p run, or an older
# Claude Code) or one that says it does not know, they ask as before. A
# subagent's events always ask: the module knows only the conversation's own
# session.
#
# The MCP connection signs in through the browser, and a hook cannot. So this
# sends a hook token, which works on the hook route alone: the one in
# DEVCORNER_TOKEN, which a person makes on devcorner's connections page,
# /settings/connections, and sets themselves; else the one the plugin's
# module was given when this machine signed in from Claude Code (dc-t224:
# /dc login, or Claude through its own connection). The module keeps that one in its own
# store and hands it to these hooks as one file readable by its owner alone,
# in their folder beside the markers (`tokenFile` in register.tsx), which it
# removes at sign-out. With no token this does nothing, since it could not
# say whose conversation it is; the module says so instead, at each
# session's start and in /dc, and on a machine's first run begins /dc login
# itself (dc-t576).
#
# DEVCORNER_URL overrides the local address, as it does in the plugin's
# .mcp.json.
#
# Claude Code waits for each hook, so a call to devcorner gets 2 seconds when
# it asks and 3 when it passes an event on, and is given up after that.
# DEVCORNER_HOOK_WAIT sets both, in whole seconds above 0, for a run outside
# Claude Code: devcorner's own tests, which call a server busy with the rest
# of their suite, give it longer. Under Claude Code the hook's own timeout in
# hooks.json (5 or 10 seconds) still ends the script first.

url="${DEVCORNER_URL:-https://devcorner.devcorner.workers.dev}"
token="${DEVCORNER_TOKEN:-}"
endpoint="$url/mcp/hooks/claude-code"
event="$1"
limit="${DEVCORNER_HOOK_WAIT:-}"
case $limit in
'' | *[!0-9]*) limit= ;;
*) [ "$limit" -gt 0 ] || limit= ;;
esac

if [ -z "$token" ]; then
  # The file holds the token, then the devcorner that made it: it is sent
  # only to that one.
  token_file="${DEVCORNER_HOOK_STATE:-${XDG_CACHE_HOME:-$HOME/.cache}/devcorner}/token"
  token_url=
  [ -r "$token_file" ] && { read -r token && read -r token_url; } <"$token_file"
  [ "$token_url" = "${url%/}" ] || token=
  # Only a hook token's shape is sent: dch_ and 43 letters of base64url.
  case $token in
  dch_*[!A-Za-z0-9_-]*) token= ;;
  dch_*) [ ${#token} -eq 47 ] || token= ;;
  *) token= ;;
  esac
fi

[ -n "$token" ] || exit 0

# How much of an event is read to find its ids. They come first, before
# anything the model or a tool wrote.
HEAD_BYTES=8192
# Seconds to leave devcorner alone after a call to it failed.
DOWN_HOLD=60
# One small file per session: when it last asked, how that call went, and
# when an ask last handed over all there was.
state="${DEVCORNER_HOOK_STATE:-${CLAUDE_PLUGIN_DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/devcorner}}/hook-stamps"
# The module's markers: whether messages wait for a conversation. The module
# cannot read CLAUDE_PLUGIN_DATA, so both name the folder from the same
# variables (markerFile in register.tsx).
markers="${DEVCORNER_HOOK_STATE:-${XDG_CACHE_HOME:-$HOME/.cache}/devcorner}/waiting"

# Sets `value` to the string held by key $2 in the JSON text $1. Fails if the
# key is missing, or holds anything an id or a name would not.
field() {
  value=
  case $1 in
  *"\"$2\":\""*) value=${1#*"\"$2\":\""} ;;
  *"\"$2\": \""*) value=${1#*"\"$2\": \""} ;;
  *) return 1 ;;
  esac
  value=${value%%\"*}
  case $value in
  '' | *[!A-Za-z0-9._:-]*)
    value=
    return 1
    ;;
  esac
}

# Prints how many background tasks the subagent $2 started itself are still in
# flight as it stops, read from what follows the name of its SubagentStop
# event, $1 (dc-t576): `background_tasks` lists every task in flight in the
# conversation, so each counts whose id its own transcript, at
# `agent_transcript_path`, names, as it names the tasks it started; the
# subagent's own entry, there when it runs in the background, never counts.
# An id is matched anywhere, not as a whole word: Claude Code's are random (a
# shell's or a monitor's 9 letters and digits, an agent's 17), so none is part
# of another, and a word's edge would miss one written right after an escape
# such as `\n`. A name right after `agent-` is not counted: that is an agent's
# worktree, its branch or its transcript file, which a tool's output shows for
# a sibling as well (`git worktree list`), and never how a launch names its
# task. A subagent's transcript keeps no structured task id of what it
# launched, only the words of each tool's result, which Claude Code does not
# promise; matching those words would take a wait for a stop the day they
# change, so every other mention counts. Each key is matched with its quotes,
# which a JSON string escapes, so nothing the model or a tool wrote can stand
# for one. Only the list's own entries are read, to its closing bracket: a
# scheduled task after it is no task in flight. The transcript is read once,
# however many tasks are in flight.
# Prints nothing when it cannot tell: no list, as from a Claude Code before
# it, or no transcript to read.
own_background() {
  self=$2
  case $1 in
  *'"background_tasks":['*) list=${1#*'"background_tasks":['} ;;
  *'"background_tasks": ['*) list=${1#*'"background_tasks": ['} ;;
  *) return 0 ;;
  esac
  case $list in
  '' | ' ' | ']'* | ' ]'*)
    echo 0
    return 0
    ;;
  esac
  # The list ends at its own closing bracket (dc-t582), found by depth outside
  # strings: an entry may carry an array or object of its own, or a string
  # with a bracket, whose `]` would end the list early, drop the ids after it
  # and read a wait as a stop; and what follows the list, as the scheduled
  # tasks, is no task in flight, so an id there that the transcript names
  # never counts. A list that never closes, as in an event cut short, is read
  # to the end, where an id counts only when the transcript names it.
  list=$(printf '%s' "$list" | awk '
    BEGIN { depth = 1; quoted = 0; escaped = 0 }
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (quoted) {
          if (escaped) escaped = 0
          else if (c == "\\") escaped = 1
          else if (c == "\"") quoted = 0
        } else if (c == "\"") quoted = 1
        else if (c == "[" || c == "{") depth++
        else if ((c == "]" || c == "}") && --depth == 0) {
          printf "%s", substr($0, 1, i - 1)
          exit
        }
      }
      print
    }')
  case $1 in
  *'"agent_transcript_path":"'*) transcript=${1#*'"agent_transcript_path":"'} ;;
  *'"agent_transcript_path": "'*) transcript=${1#*'"agent_transcript_path": "'} ;;
  *) return 0 ;;
  esac
  transcript=${transcript%%\"*}
  # A path JSON had to escape is not read.
  case $transcript in '' | *\\*) return 0 ;; esac
  [ -f "$transcript" ] && [ -r "$transcript" ] || return 0
  # The ids to look for, each as a pattern of grep's.
  set --
  while :; do
    case $list in
    *'"id":"'*) list=${list#*'"id":"'} ;;
    *'"id": "'*) list=${list#*'"id": "'} ;;
    *) break ;;
    esac
    id=${list%%\"*}
    case $id in '' | *[!A-Za-z0-9_-]*) continue ;; esac
    [ "$id" = "$self" ] && continue
    set -- "$@" -e "$id"
  done
  if [ $# -eq 0 ]; then
    echo 0
    return 0
  fi
  count=$(sed 's/agent-[A-Za-z0-9_-]*//g' "$transcript" 2>/dev/null |
    grep -oF "$@" | sort -u | wc -l)
  echo $((count))
}

# Prints the remote of origin in folder $1, whose host devcorner keeps when it
# is not GitHub, without a user or token an https remote may hold. A remote
# that is a folder on this machine, an absolute path as a clone of a folder
# keeps or a file:/// URL, names no repo to devcorner, so the remote that
# folder's repo came from is read in its place, up to three folders on
# (dc-t565), as the plugin's module does. Prints nothing when there is none.
remote() {
  folder=$1
  for hop in 0 1 2 3; do
    origin=$(git -C "$folder" remote get-url origin 2>/dev/null) || return 0
    case $origin in
    file:///?*) folder=${origin#file://} ;;
    /?* | [A-Za-z]:[\\/]?*) folder=$origin ;;
    # A relative folder, which git reads from the repo's own top folder.
    ./* | ../*) return 0 ;;
    *)
      printf '%s\n' "$origin" |
        sed 's#^\([A-Za-z][A-Za-z0-9+.-]*://\)[^@/]*@#\1#'
      return 0
      ;;
    esac
  done
}

# The module's claims (dc-t588): the session each conversation's own start
# returned, one small file a conversation (claimFile in register.tsx).
claims="${DEVCORNER_HOOK_STATE:-${XDG_CACHE_HOME:-$HOME/.cache}/devcorner}/claims"

# Passes the whole event on, with the repo and branch from git, and the
# session the conversation states it runs as when $1 names one (dc-t588).
forward() {
  dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  repo=$(remote "$dir")
  [ -n "$repo" ] || repo=$(basename "$dir")
  branch=$(git -C "$dir" branch --show-current 2>/dev/null)
  curl -sf --connect-timeout 1 -m "${limit:-3}" -X POST "$endpoint" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "X-Devcorner-Repo: $repo" \
    -H "X-Devcorner-Branch: $branch" \
    ${1:+-H "X-Devcorner-Claim: $1"} \
    --data-binary @- || true
}

# Prints the session conversation $1 states it runs as (dc-t588): the one
# its own start returned, which the module keeps, or nothing. Only an id's
# shape is sent: me-s4, acm-s4 or dc-s4@acme.
claim_of() {
  [ -r "$claims/$1.claim" ] || return 0
  said=
  read -r said <"$claims/$1.claim" || :
  case $said in
  '' | *[!A-Za-z0-9@-]*) return 0 ;;
  *-s[0-9]*) printf '%s' "$said" ;;
  esac
}

# Passes a SessionStart on with the session its conversation states it runs
# as (dc-t588), so a resume or a compaction is briefed on that session when
# the window had drifted from it. The event holds no words of the model's,
# so its session_id is read wherever it stands.
start_event() {
  chunk=$(cat)
  said=
  if field "$chunk" session_id; then
    case $value in
    *[!A-Za-z0-9_-]*) ;;
    *) said=$(claim_of "$value") ;;
    esac
  fi
  printf '%s' "$chunk" | forward "$said"
}

case $event in
SessionStart)
  start_event
  # Stamps and markers of conversations that ended a day or more ago are no
  # use; a claim is kept a month, for a resume.
  find "$state" -maxdepth 1 -type f -name '*.stamp' -mtime +1 -delete 2>/dev/null
  find "$markers" -maxdepth 1 -type f -name '*.waiting' -mtime +1 -delete 2>/dev/null
  find "$claims" -maxdepth 1 -type f -name '*.claim' -mtime +30 -delete 2>/dev/null
  exit 0
  ;;
SessionEnd | SubagentStart)
  forward
  exit 0
  ;;
SubagentStop)
  # Whole: the background tasks come after the model's last message.
  chunk=$(cat)
  ;;
PostToolUse | UserPromptSubmit | Stop)
  # The start of each line is enough, and reading to the end lets Claude Code
  # finish writing.
  chunk=$(cut -b "1-$HEAD_BYTES")
  ;;
'')
  # With no name given, the event names itself.
  chunk=$(cat)
  case $chunk in
  *'"hook_event_name":"'*) event=${chunk#*'"hook_event_name":"'} ;;
  *'"hook_event_name": "'*) event=${chunk#*'"hook_event_name": "'} ;;
  esac
  event=${event%%\"*}
  case $event in
  SessionStart)
    printf '%s' "$chunk" | start_event
    exit 0
    ;;
  SessionEnd | SubagentStart)
    printf '%s' "$chunk" | forward
    exit 0
    ;;
  PostToolUse | UserPromptSubmit | Stop | SubagentStop) ;;
  *) exit 0 ;;
  esac
  ;;
*) exit 0 ;;
esac

# The ids come before the event's name. What follows it can hold text the
# model or a tool wrote, so nothing after it is trusted to name the caller.
case $chunk in
*'"hook_event_name"'*) ;;
*) exit 0 ;;
esac
ids=${chunk%%'"hook_event_name"'*}
rest=${chunk#*'"hook_event_name"'}

field "$ids" session_id || exit 0
session=$value
case $session in *[!A-Za-z0-9_-]*) exit 0 ;; esac

agent=
agent_type=
case $ids in
*'"agent_id"'*)
  field "$ids" agent_id || exit 0
  agent=$value
  case $agent in *[!A-Za-z0-9_-]*) exit 0 ;; esac
  field "$ids" agent_type && agent_type=$value
  ;;
*)
  # A subagent is named among the ids. If one is named only further on, this
  # cannot tell who is calling, and a subagent must never be handed its
  # parent's messages. So it does nothing.
  case $rest in *'"agent_id"'*) exit 0 ;; esac
  ;;
esac

# A turn that a stop hook already carried on is not carried on again.
if [ "$event" = Stop ]; then
  case ${rest%%'"last_assistant_message"'*} in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
  esac
fi

body="{\"hook_event_name\":\"$event\",\"session_id\":\"$session\"${agent:+,\"agent_id\":\"$agent\"}${agent_type:+,\"agent_type\":\"$agent_type\"}}"

if [ "$event" = SubagentStop ]; then
  background=$(own_background "$rest" "$agent")
  [ -n "$background" ] && body="${body%\}},\"background\":$background}"
  # Claude Code is told nothing: an answer here could keep the subagent going.
  curl -sf --connect-timeout 1 -m "${limit:-3}" -X POST "$endpoint" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data-binary "$body" >/dev/null 2>&1 || true
  exit 0
fi

stamp="$state/$session${agent:+.$agent}.stamp"
every="${DEVCORNER_HOOK_EVERY:-10}"
case $every in '' | *[!0-9]*) every=10 ;; esac
# The longest the main conversation's hooks stay quiet on a marker that says
# nothing waits: they ask anyway once it and their own last ask are older.
fallback="${DEVCORNER_HOOK_FALLBACK:-300}"
case $fallback in '' | *[!0-9]*) fallback=300 ;; esac

now=$(date +%s)
last=0
mark=
cleared=0
if [ -r "$stamp" ]; then
  read -r last mark cleared <"$stamp" || :
  case $last in '' | *[!0-9]*) last=0 ;; esac
  case $cleared in '' | *[!0-9]*) cleared=0 ;; esac
fi

# What the module last heard: how many messages wait, and when. Only the
# conversation's own session has a marker.
pending=
heard=0
if [ -z "$agent" ] && [ -r "$markers/$session.waiting" ]; then
  read -r pending heard <"$markers/$session.waiting" || :
  case $pending in '' | *[!0-9]*) pending= ;; esac
  case $heard in '' | *[!0-9]*) heard=0 ;; esac
  # A count the module heard before an ask of the hooks began that handed
  # over all there was is spent: that ask took what it counted. One it heard
  # in the same second or later stands, so of the two the hooks would rather
  # ask once too often than miss a message.
  [ -n "$pending" ] && [ "$heard" -lt "$cleared" ] && pending=0
fi
fresh=$last
[ "$heard" -gt "$fresh" ] && fresh=$heard

if [ "$mark" = down ]; then
  [ "$now" -lt "$((last + DOWN_HOLD))" ] && exit 0
elif [ "$pending" = 0 ] && [ "$now" -lt "$((fresh + fallback))" ]; then
  exit 0
elif [ "$event" = PostToolUse ]; then
  [ "$now" -lt "$((last + every))" ] && exit 0
fi

if out=$(curl -sf --connect-timeout 1 -m "${limit:-2}" -X POST "$endpoint" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary "$body" 2>/dev/null); then
  # Once it has asked, nothing the module counted before the ask began waits
  # for the hooks: PostToolUse and UserPromptSubmit hand over all there is
  # (past the hourly limit, check has it), and Stop has handed over what it
  # carried the turn on for. A Stop that handed nothing leaves the rest for
  # the next turn, so what the module counted stands. The marker is the
  # module's alone: a message it hears of while this ask is on its way is
  # never marked spent by it.
  if [ "$event" != Stop ] || [ -n "$out" ]; then cleared=$now; fi
  went=ok
else
  went=down
  out=
fi
line="$now $went $cleared"
{ printf '%s\n' "$line" >"$stamp"; } 2>/dev/null ||
  { mkdir -p "$state" && printf '%s\n' "$line" >"$stamp"; } 2>/dev/null ||
  true

[ -n "$out" ] && printf '%s\n' "$out"
exit 0
