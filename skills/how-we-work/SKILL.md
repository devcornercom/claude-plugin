---
name: how-we-work
description: devcorner's operating model, how to work with it and why, for any project. Load it when you plan, file or kick off work, coordinate work through devcorner, such as handing work to cloud runs, subagents or an OA, waiting on them, reviewing and landing pull requests, keeping docs current, writing a pull request, asking your person a question, or at a natural pause.
---

How to work with devcorner, and why. devcorner gives every session its rules at start, one line each: its system rules, then its ways of working, then your workspace's and your own instructions, which win over the ways and over this text. This is the how and the why behind those lines, the same for every project. Read the part you need; each tool's details are in help("<tool>").

## Sessions

A session is one conversation's work, from start to finish.

- start before any work: a one-line goal, your git branch, the repo (owner/name), and the ticket's id when there is one. Pass role "review" or "qa" when you judge or test a ticket's work, parent when you are a subagent, and harness when devcorner's note gives you one. Read the reply: it opens with your instructions, and warns of live sessions that overlap yours.
- note when you change approach, learn something another session should know, or are blocked on your person. Record each commit with note(commit: its sha), and its ticket when it counts toward one.
- check at natural pauses, such as before a commit or a push, to pick up messages.
- finish when you stop: an outcome and a summary for someone with no context (what was done, what was decided and why, what is left), and lessons for what you learned the hard way.
- A session needs no ticket. File one only when your person asks or agrees, or when you must ask them something no ticket covers.
- A small change still belongs to a ticket. A follow-up on an open ticket rides it as a todo: start(ticket, todo). The work your person asked for in this conversation, with no ticket that fits, gets a small ticket that start(file: "<title>") files in the same call, once a session, shown to them to object to; never for something you noticed on the way, which is filed and not started. start(small: true) says the change on your branch is a small one. A small change takes the light path while its pull request stays small, which devcorner reads from its diff (help("batches:small")).

## Planning

Next is the order of a repo's open tickets, and devcorner reads it everywhere. start and the briefing say what is next. A hand-off and a dispatch take from it. An OA's ready set is its head. A person's Queue is their part of it. So Next is only useful when it is true: the work in flight at the top, then what comes after, in order. Work started outside Next makes it stale for everyone who reads it.

- Work comes in sets a person can follow. A project is a lasting area, kept as long as the product. An initiative is one outcome you would say out loud, with its tasks (a ticket with parts), and it closes when the outcome is reached. A task is one change toward it. Put a ticket under an initiative with ticket(parent) only when that helps follow the work. A build's slices and steps are todos on its one ticket, not tickets of their own. A true one-off, such as a single fix, an incident or a question, stays loose.
- Name plainly everything a person reads in a list: tickets, initiatives, documents, questions, OAs, pastes and pull requests. A title is 3 to 8 everyday words that say the outcome or the subject, or for a bug what goes wrong for the person, such as "Upgrade Rango to 0.32", "Tidy up the board", "Show official docs on the Docs tab" or "Board cleanup proposal". It holds no ids, slice codes or code names: the precision goes in the description or the body.
- A ticket says what done looks like, in a way a check or a reviewer can confirm ("find returns the archived ticket", "the board shows the count"). Then its finish and its review judge the same thing.
- Plan before you start. Work that will ship (a branch, a pull request, a run) starts only once its ticket is open and placed in Next. When your person asks for the work, that is their agreement to its ticket: find it with find, or file it, then place it. A lookup, an answer, or a document on a ticket already in flight needs no place of its own. What you notice on the way is filed, not started.
- Kick it off, in four steps. (1) The ticket sits under its initiative, when one helps follow it. (2) Place it after the last ticket in flight with ticket(id, place: "after <id>"), or with place: "first" only when your person says it goes before what runs now. (3) Dispatch its runs with run(action: "dispatch", ticket), with your person's agreement where the dispatch starts work on their machine. (4) Update the living plan, the plan document start names, with section.
- In flight means that a live session works on the ticket, a run is out for it, or its pull request is in review or on a train. Next matches what is in flight when those tickets are at the top and nothing below them is being worked on. When work stops or changes direction, move its ticket and say so in the plan.

## Evidence

devcorner reads where work stands from what happened, never from a status someone set: a commit noted, a pull request opened from the branch, a verdict recorded at a head, a merge, a deploy. So record the evidence and let the state follow.

- A review or a check is recorded with ticket(id, record) at the sha it judged, and counts only at that sha: a new head needs a new verdict.
- Name what you rely on by its id or sha (a ticket, a run, a verdict, a commit), never "it passed" or "it is done".
- Change a ticket's status by hand only when your person asks.

## Finishing work

A change is done when it is small, proven and handed on, so the next session builds on it instead of redoing it.

- One ticket's outcome goes in one pull request that lands whole: no step left for later. Take the smallest change that does it, and remove what is in the way before you add. What you find outside the ticket is a follow-up ticket, filed, not started.
- Each step ends in a state you can check. Check it before the next step. Order commits so the change reads as an argument, such as the failing test first, then the fix.
- Prove the work on the real thing: run the check, load the page, read the value, read the diff you push. A subagent's report, a cached result, truncated output and "it compiles" prove nothing. When a check surprises you, suspect how you looked before you suspect the system. Name the evidence by its id or sha (see Evidence).
- When two fixes that rest on one belief have failed, write the belief down and test it before you try a third fix.
- Comments stand on their own. Write each for the next person who reads the code, who has the code and nothing else: technical, short, no emoji. Where the reason is not obvious, such as an invariant, a constraint or something that broke before, say why in plain words and name the exact file or identifier. Never describe the change or talk to a reviewer: the diff and the review say that, and they go stale in the code.
- Keep tracker references out of the repo's code, tests and docs: no devcorner ids, and no GitHub issue or pull request numbers. A reader without the tracker learns nothing from one, and it goes stale when the ticket moves or closes. Say what broke instead. The ids go in the pull request and the commit message, where the devcorner line links them. A file named for its item, such as a change note named for its ticket, is that item's own record, not a reference. Where a project turns it on (an instruction tagged check:stand-alone-texts), devcorner's GitHub App flags each reference a pull request adds, and never blocks the merge.
- A finish's summary says the intent, what is verified and how, what is left, and the first step for whoever comes next. When you pick up a ticket, read its last finish, its comments and its open findings first, and do not redo what is verified.
- A mistake that comes back is a class of mistake. Prevent it at the highest level that works: the design (one owner, one way to do it), a type, a lint or check whose error names the fix, or a test. An instruction line comes last and only for a judgment call, because nothing fails when someone skips it. finish(lessons) keeps what you learned the hard way for the next session.

## What goes where

Each text holds only what belongs to it, so whoever reads it later finds it true and whoever reads the ticket finds the rest.

- A pull request's body is about its change: what it does and why, how it was checked, and what a reviewer should look at. Coordination does not go in it: a merge order, a decision, a plan or a note that part of the work is not in this push is stale once the work moves, and whoever reads the ticket never sees it there. A pull request that cannot stand on its own stays a draft until it can. One plain "Depends on #N" line may stay, for a person who merges by hand.
- An order between pull requests or tickets ("merge after", "merge order") is a dependency of the later ticket: ticket(id: "<later ticket>", depends_on: ["<earlier ticket>"]). The list replaces the one it had, so name each ticket it waits on.
- A decision for your person is a question on the ticket: question(action: "ask", ticket: "<ticket>", questions).
- A technical decision of yours, a finding or progress is a comment on the ticket: ticket(id: "<ticket>", comment).
- Work not in this change is a todo of the ticket, ticked when it is done with ticket(id: "<ticket>", todo: <n>, done: true), or a sub-ticket: ticket(id: "<ticket>", subtickets: [{ title }]).
- The sequence of work across tickets is the initiative's living plan: doc(id: "<plan>", section: { heading, text, mode: "append" }).
- Why the code is as it is goes in a comment in the code, standing on its own; which ticket and run the change is for, in the devcorner line and the commit message.
- Where a project turns it on (check:stand-alone-texts), devcorner's GitHub App flags coordination in a pull request's description and names the call that moves each kind, and never blocks the merge.

## Coordinating

The main conversation coordinates and talks to your person; the work is done elsewhere.

- Start work only through Next: kick it off as Planning says, and keep the board's order the same as what is in flight.
- Hand each part to a cloud run first: run(action: "dispatch", route: "cloud"). One that names no routine goes to the repo's routine with the most room. Use a local subagent only when the work must run on this machine.
- A subagent calls start with parent set to your session id, and passes the id it gets as session on every later call.
- A run's model and effort go by its kind (the ways' line says which), unless the run or its ticket names another.
- A message of kind dispatch is your person's own request: hand it to a subagent (the plugin's devcorner:worker agent) that calls start with parent and run, and carry on with your own task.
- A dispatch starts work on your person's machine, so ask them first, and pass agreed: true only once they said yes.
- A subagent hands its result back to the session that started it and never watches that session's runs or OAs: only the session that owns the work watches it.

## OAs and merge trains

An Orchestrator Agent (OA) carries a list of tickets to their end by fixed rules while nobody watches: it sends builds, reviews and fixes, stacks merge trains and lands them.

- Propose one with run(action: "oa", mandate), show your person its restatement and refusals, and arm it with run(action: "confirm", id, agreed: true) only on their yes.
- Give an OA only the tickets that can land before its end. For more, propose the next one with mandate: {after: "<its id>"}, which starts when it ends.
- A merge train lands pull requests together: each is reviewed alone, the approved ones are stacked, the full checks run once at the train's head, and they land together. Your project's instructions say which checks are the full ones and who runs them.
- Every change lands in a train, and a train of one is a train: an urgent fix forms its own, with the full checks at its head and one deploy. A train of only small changes forms too, so they never wait for a large one.
- No change gets a QA run of its own: each member's touched end-to-end specs run in its train's touched run. A member that fails there is left out of the train, its ticket told the failure and brought up to its base, and the train runs its touched specs again at its new head and goes on, so one member never holds the rest and your person's signed check.
- Bring a pull request up to its base by merging the base into its branch and a plain push, never a rebase and a forced push: a merge rewrites no commit that was reviewed.

## Waiting

Waiting costs nothing when something wakes you, and a whole context when you poll.

- Keep one watcher for each thing you wait on: the plugin's hold and devcorner's wakes. A wake starts an idle conversation's turn for a run that ended, a dispatch, your person's answer, or an OA's news (its question to your person, its mind stopped, it ended, a checkpoint waits on their go), and names what came.
- Never a polling or sleep loop, and never a show or check only to see whether something changed.
- A finished run's message carries its summary: do not read the run again for what it already said.
- A wake is news, not a decision: check what decides (a gate, a head, a verdict) yourself before you act.
- An event that needs no action ends your turn silently: no still-waiting message, note or comment.
- Read long material (a run's whole record, an OA's journal, a log) in a subagent, and keep only its conclusion.
- A cloud run's coordinator has no person to tell and no hold: its steps say how it waits.

## Reviews

A review loop has grades, a ledger and a budget, so it ends.

- Every finding is a blocker (the intended case is wrong), a should (a real bug callers will hit, within the ticket's intent) or a nit (everything else). Only a blocker or a should requests changes; a round of nits alone approves.
- Findings are kept by id on the ticket (show("<ticket>:findings")). Each later round marks each one fixed, declined (in one line, a follow-up where it is worth one), disputed (with evidence) or open.
- A re-review reads only the change since the last verdict and the findings still open, never the whole pull request again.
- Three rounds, five where the change touches security, permissions, sign-in, data loss or concurrency. Past the budget, or with a finding disputed twice, your person decides. Running out is never an approval.
- A fix takes the smallest change that does it, and prefers deleting or narrowing code to a new guard, option or helper. What is outside the ticket is a follow-up, not a fix.
- A review is by a session that did not write the change. Passing tests, a green check and the author's own reading are not a review.
- A fix round goes to a fresh run with the whole brief: the ticket, every later decision, and the findings still open at the head it starts from.

## Questions

Only the person a question is put to decides it; an agent proposes.

- Ask on its ticket with question(action: "ask"). Ask only what is theirs to decide (a preference, a risk they carry, a cost they pay), at most 3 at once: each as one plain line of what they decide and what changes for them, then your recommendation, with the technical detail in context. Decide technical details yourself, list them in your document as decided unless they object, and say where in the ask's intro.
- A subagent's question goes to its coordinator first, and to your person after about ten minutes. A run that cannot go on without the answer asks it and finishes partial, naming the question's id: it continues once they answer.
- Going ahead without the answer means marking the option you built in the same step: question(action: "implement").
- Pass agreed: true (a dispatch, a shared memory, an OA's confirm, an instruction) only once your person said yes.

## Documents

Docs come in two layers.

- Working docs are research, designs, plans and notes. They are live documents: keep them in devcorner with doc, not as files in the repo, give each its project, link it to its initiative or task, and change it in place with section or append.
- Official docs describe what is built, and live on the project or the workspace. By default a project has an Overview (what it is, its goals, where it stands), an Architecture (as built) and a Runbook (how to run, deploy and test it). A workspace has an Overview of its projects and a Glossary. The workspace or project may add to that set, drop from it or rename it. When a repo keeps its own docs, such as docs/architecture/, devcorner points to them and never copies them.
- Fold a design when it describes what was built: move what lasts into the official doc, then archive the design.
- Reviewing and reorganising docs is a session's work, on demand, under a ticket like any other. There is no scheduled check.
- A team's own instructions may say otherwise, and the narrower scope wins.
- A ticket's description stays as filed: progress, findings and answers go on it as comments, follow-ups as sub-tickets.
- A short fact every later session should be given is a memory. One shared with the workspace needs your person's agreement.

## Compaction

Tool results stay in context until a compaction, and only your person can /compact.

- Suggest it at a natural pause (a train landed and deployed, a phase done, a review recorded), never while a train, a signing or a run you wait on is in flight.
- On a 1M context, suggest /autocompact 300000 once.
- After a compaction devcorner gives your session, its runs and questions and what waits on your person again, so keep no list of them for it.

## Lean reads

Every read comes as a head with parts, and what you read stays in your context.

- show(id) gives an item's head and its Parts line; read one part with show("<id>:<part>"), with from and to, last or since, and whole: true only when you need all of it.
- help(topic) gives a topic's head; help("<topic>:<part>") one part.
- Search with find, by words and by meaning, before you investigate a bug or an unfamiliar area: it may be answered.
- Never read again what a wake, a message or a reply already gave you.

## What your project decides

devcorner's rules are the same everywhere; how a project builds is its own. Its checks before a push and before a landing, who runs or signs the full checks, which test modes count, its branch names, its deploys and its release steps go in its instructions, never in this text.

- A workspace's instructions are one text (doc(type: "instructions")), and your person's own are another. A line may say where it applies, such as "In owner/name: …" or "As a reviewer: …"; the narrower one wins.
- Change an instruction only with your person's agreement (agreed: true).
- When a project's instruction says otherwise than this text, follow the instruction.
