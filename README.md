# sumo-agents

One repo you open and talk to. It works across every other project on the machine, remembers what you
tell it so you never explain twice, learns each project as you go, and hands big work to cheaper
sub-agents. Built for Claude Code; the core is harness-neutral.

The repo holds only the process. Everything learned lives in `~/.sumo-agents/` on each machine and is
never committed — a work laptop and a personal one learn separately.

## Set up a machine

Needs Node 22.13+, Claude Code, and llama.cpp (`brew install llama.cpp`) for the local router model.

```sh
git clone <this repo> ~/sumo-agents && cd ~/sumo-agents
node bin/mem.mjs setup     # creates ~/.sumo-agents, links `mem` into a directory on your PATH
mem doctor                 # every line should say ok
claude                     # open it here. Approve the project hooks once when asked.
```

Setup asks one question, once: where to download the router model from. Enter keeps the default,
Hugging Face. Behind a corporate proxy, give the base URL of an Artifactory Hugging Face remote
instead (`https://<host>/artifactory/api/huggingfaceml/<repo-key>`); the same
`<repo>/resolve/main/<file>` path is fetched under it. The 2.5 GB file lands in
`~/.sumo-agents/models/` and is skipped when it is already there.

```sh
mem setup --model-source https://<host>/artifactory/api/huggingfaceml/hf-remote   # non-interactive
mem setup --no-model                                                               # skip the download
mem config model.source <url>                                                      # change it later
```

Without llama.cpp or the model, everything still works: jobs fall back to a fixed route per role and
`mem doctor` says what is missing.

Then just talk. Mention a project the way you normally would; the first time, the agent finds it on
disk, confirms the path with you, and registers it.

## Update a machine

```sh
cd ~/sumo-agents && git pull
mem doctor                 # first line shows the commit now running — compare it with GitHub
```

That is all: `mem` runs straight from the repo, so new code is live the moment it is pulled, and the
database upgrades itself the next time it is opened. Your memory is not touched — it lives in
`~/.sumo-agents/`, outside the repo. Run `mem setup` again only if `mem doctor` tells you to (you moved
the repo, or changed Node versions). Start a new Claude Code session afterwards, so it loads the new
`AGENTS.md` and hooks.

## What happens while you talk

| When | What runs | Cost to the model you chat with |
|---|---|---|
| Session starts | A hook prints the core block: your global preferences, workflows, projects, where you left off, open jobs, things to confirm. Hard cap 800 tokens. | ≤ 800 tokens, once |
| You send a message | A hook stores it word for word (secrets redacted). First mention of a project adds its card: path, stack, commands, your rules for it, gotchas. | 0, or ≤ 200 once per project |
| The agent is about to run a command that would wipe a tree (`rm -rf ~`, `git reset --hard`, `git clean -f`, `DROP TABLE` …), or to print or open a secret file (`.env`, a private key, `~/.aws/credentials`) | A hook refuses it before it runs, in plain code, and says why. No memory is consulted. The way through is you: `! <command>` runs it yourself. A force-push is not on the list — it is an accepted way of cleaning up history here. | 0 |
| The agent is about to run a shell command a taught workflow gates (`gh pr create`, for a workflow taught with `--gate 'gh(-axi)? pr create'`) | A hook holds the command back once and hands the agent the workflow's steps. It follows them, then runs the command. The same steps ride in with your message when you ask for the thing yourself. | 0 until it fires |
| The agent is about to ask you something — a turn ending on a question, or the question tool | A hook searches memory with the question's own words, in plain code. If something close is there, the agent is handed it once and carries on instead of waiting for you; if nothing is, the question reaches you untouched. | 0 unless memory answers |
| The assistant finishes a turn | A hook wakes the **scribe** — a detached, headless Haiku call that reads the new turns and proposes memories. Code checks every proposal against what you actually typed before saving it. | 0 |
| 3 finished sessions pile up | The **dream** pass reads them side by side: contradictions, repeated corrections, routines worth naming. | 0 |

What you state is saved silently. What the model could not tie to your exact words is held and put
to you as a one-line question at the next session start. Nothing from web pages, files or tool output
can become a memory.

## See what it knows

```sh
mem export                         # everything, readable, grouped by project
mem prime                          # exactly what a new session is shown
mem project show <name>            # a project's card
mem search "<words>" [--project <name>]
mem search "<words>" --turns       # what you literally typed
mem history <id>                   # what a memory replaced, and what replaced it
mem gate <workflow-id> '<regex>'   # which shell commands a workflow must come before  (off to remove)
mem scribe show                    # exactly what the cheap model would be sent right now
mem scribe stats                   # what the background passes have cost
mem forget <id>                    # stop it being true (history kept);  --purge erases it for good
```

`mem help` lists the rest. Ids look like `m12` (memories) and `j3` (jobs).

## Delegation

The main agent does small things itself. Big, parallel or reading-heavy work goes to a sub-agent through
a written brief (`mem job new`). All three refuse to start without a job:

| Sub-agent | Model and effort | Can edit | For |
|---|---|---|---|
| `scout` | always Haiku | no | finding, tracing, auditing, summarizing — anything reading-heavy |
| `worker` | chosen per job, Sonnet/medium by default | yes | building and fixing |
| `reviewer` | chosen per job, never below Opus/high | no | judging a change it did not write |

A blocked sub-agent asks; the main agent checks memory before it asks you. Briefs, notes, answers,
reports and check results live in `~/.sumo-agents/jobs/<id>/`, so a job started today can be picked up
tomorrow. One worker per project at a time — they share a working tree, and `mem job new` says so when
a second one is created.

## Which model and effort a job gets

The model you chat with never decides this. `mem job new` does, in plain code, and prints the result:

```
created j27 [worker·sumo-agents·running] Session hygiene: context gauge …
route: opus/xhigh — router: a new feature across hooks and sessions with tests; floor: security
start it with the worker-xhigh sub-agent and exactly this prompt: JOB: run `mem job brief 27` …
```

The route is settled in this order, first match wins:

1. **You named it**: `--model opus --effort high` on `mem job new`.
2. **It is a retry**: one rung above the job it retries.
3. **A project rule** you stated: a decision shaped `worker model opus effort high` for that project.
4. **The router**: a 4B open model (Qwen3, through llama.cpp) reads the role, project, task text and the
   project's history — how each model/effort scored in past reviews — and answers with a model, an
   effort and one sentence. It runs locally, costs nothing, and takes about 1.5 s including startup.
5. **The role default** when the router is unavailable or answers badly: Haiku, Sonnet/medium, Opus/high.

Then floors the router cannot cross, each named in the printed reason: a scout is Haiku; a reviewer is
at least Opus/high; work that mentions credentials, payments, migrations or concurrency is at least
Opus/xhigh; each axis is raised on its own, so a strong model never excuses low effort.

Effort is real, not advisory: `worker-low` … `worker-max` and `reviewer-high` … `reviewer-max` are agent
files whose frontmatter carries the level. A hook on the Agent call rewrites its model and agent type to
the job's route, and logs requested vs applied in the job folder, so what was chosen is what runs.

Models available to sub-agents: `haiku`, `sonnet`, `opus`, `fable`. Effort levels: `low`, `medium`,
`high`, `xhigh`, `max`; Haiku takes none.

**The label that grades a route is a review, not a green check.** A worker's DONE only proves the
checks passed; every Sonnet worker here passed its checks and the Opus reviews that followed found 1 to 7
Important issues each. So when a reviewer finishes, its Important count is stored on the job it judged,
and that is what the router's history and `mem job stats` report:

```sh
mem job stats --project <slug>     # per model/effort: jobs, done, failed, reviewed, avg important
mem job retry <id>                 # a failed job, or one reviewed with 3+ Important: same brief,
                                   # previous notes and report attached, one rung up
```

The ladder climbs effort before model — Sonnet/medium → Sonnet/high → Opus/high → Fable/high →
Fable/xhigh — and `retry` refuses at the top and says to ask you.

## How coding work gets done

Three kinds of work have a written way of doing them. Each is a short numbered list in `guides/`, read
only when that work comes up:

| You type | Guide | The gist |
|---|---|---|
| `/fix <what is wrong>` | `guides/fix.md` | What changed recently → make it fail on demand → find *where* it breaks before saying *why* → one cause at a time, each with evidence → fix where it starts → the same reproduction passes |
| `/feature <what to build>` | `guides/feature.md` | Size it (experiment · change to existing code · new subsystem) → agree what done means → tests first, seen failing → build without touching them → name a wrong implementation that would still pass, and kill it |
| `/review <what to judge>` | `guides/review.md` | A reviewer that did not write the code, reading only the change: first "does it do what was asked" (missing · extra · misunderstood), then "can it be trusted"; every finding has a file:line and a concrete way it fails |

You do not have to type the command: `AGENTS.md` tells the agent to read the matching guide first.

**`--guide`** is how the same steps reach a sub-agent. `mem job new --guide fix` pastes `guides/fix.md`
into the worker's brief, so a delegated fix is done the same way as one done in the conversation. A
reviewer job always carries `guides/review.md`.

## How a worker's DONE is checked

Whoever did the work does not grade it. A worker's `DONE` rests on what the project's own checks say,
run by `mem` — not on what the report says.

```
mem job new            records where the work starts: the tree exactly as it is, your uncommitted
                       edits included, so they are never counted as the job's
mem job baseline <id>  the worker's first step — runs the project's checks before any edit and records
                       what already fails
   … the worker works …
mem job verify <id>    runs the same checks and gives the verdict, without closing anything
mem job finish <id> --status DONE
                       uses that verdict if the files have not moved since, otherwise runs the checks
                       again — and refuses DONE while anything is blocking
```

Which commands are "the project's checks": its `check` script or Makefile target when it has one (that
is the project's own gate), otherwise its `test`, `lint` and `typecheck` commands — the same ones shown
on the project card. Each gets nine minutes (`SUMO_AGENTS_CHECK_TIMEOUT_MS`); the end of its output is
kept in the job's folder.

| The verdict says | Meaning | Effect |
|---|---|---|
| a check `FAILED` that passed at the baseline | the job broke it | **blocks DONE** |
| a check `FAILED` and no baseline was taken | nothing shows it was already broken, so it counts as the job's | **blocks DONE** |
| a test that already existed was edited, renamed or deleted | tests judge the change; they are not part of it | **blocks DONE** — unless the job was created with `--tests-may-change` |
| a check `was already failing` | broken before the job began, and still is | allowed; both outputs are kept to compare |
| a key, token or private key was added (`ghp_…`, `sk-…`, `AKIA…`, a PEM block, a JWT), or a secret file (`.env`, `*.pem`, `id_rsa`) is in the change | a credential is about to be committed | **blocks DONE** |
| `look at:` added lines with `eslint-disable`, `@ts-ignore`, `# noqa`, `.skip(`, `t.Skip(` … | a checker was told to look away | allowed, and printed beside the STATUS line for a person to judge |
| `look at:` added lines with `password=`, `token=`, or a long random string | a credential, or a fixture that looks like one | allowed, and printed for a person to judge |
| `note:` not a git repository / no commands | it could not be known | said, never guessed |

A refused worker always has an honest way out, and the refusal names it: fix it, finish as `FAILED`, or
`mem job ask`. When the checks cannot run on this machine, `--accept "<why>"` takes the work anyway and
marks it `DONE (UNVERIFIED …)` in the STATUS line and in the report. So a plain `STATUS: DONE` from a
worker means the checks agreed.

A baseline asked for after the first edit is refused: it would call the job's own breakage "already
there". New test files are always welcome — only tests that were there before the job are protected.

The worker's report has two sections for things that would otherwise go unsaid: **Concerns** (finished,
but not sure of) and **Decisions** (each call made on your behalf: what, why, what it costs if wrong).
A running worker settles small questions itself and lists them; it stops to ask only for something
destructive, security-sensitive, outside the project, or too unclear to do without guessing.

## Reviews

```sh
mem job new --project <slug> --agent reviewer --reviews <job id> --title "review j12"   # that job's change
mem job new --project <slug> --agent reviewer --title "review the tree"                  # whatever is uncommitted
```

What was asked for goes on stdin — a review is against that, not against taste. The reviewer is handed
the whole change as one file (`changes.diff` in its job folder; `mem job changes <id>` writes the same
file for any worker job), the original brief, and the author's report marked as *claims, not facts*.
It reports: asked vs built · findings, worst first · minor (listed, never a reason to reopen the work) ·
what the change alone could not show.

The reviewer runs in a fresh context on a stronger model than the worker, on purpose: review in a
separate session finds more than re-reading in the same one, and a weaker judge makes work worse
rather than better. Findings are still claims — `guides/review.md` ends with how to receive them.

## When to start a new session

Model quality falls with the absolute size of the context, not with the share of the window that is
full: degradation is measurable from tens of thousands of tokens, and a coding-agent study passed 8 of
10 runs clean and 3 of 10 with about 75k tokens of extra context, relevant or not. Anthropic's own rule
is that a new task gets a new session, and that a compaction is only good when the model is told what
to keep. So:

- **A gauge, not a guess.** Every prompt, a hook reads the exact context size from the session
  transcript. At 80k tokens it says so once — finish the piece in hand, then `/clear`; mid-task and it
  must continue, `/compact` with the hint it prints. At 150k it says start fresh now.
- **A boundary nudge.** `mem job finish` and `mem job abandon` end with a clear-now line when the session
  is already heavy, because a task boundary is the cheapest place to start over.
- **Nothing is lost.** The Stop hook records where you left off, and `mem prime` brings it back in the
  next session's first block. Open jobs resume from their briefs.
- **Compaction knows what to keep.** `AGENTS.md` carries a three-line compact instruction: open job ids
  and status, decisions made this session, the current project, the last failing command; drop tool
  output and file contents.

## What a project card tells you about hygiene

`mem project add` scans what the project declares about itself. Besides stack and commands, the card
says what is absent — `not set up here: a lint command, a CI workflow` — so that "nothing failed" is
never mistaken for "it was checked". A `check` script or target counts as the project's gate and stands
in for test and lint. `mem project rescan <slug>` after setting one up.

## What is enforced, and what is only asked

| Enforced by code | Asked in a prompt |
|---|---|
| a worker's DONE against the project's checks and a baseline | the steps in `guides/fix.md`, `feature.md`, `review.md` |
| existing tests untouched by a worker | the rules in `AGENTS.md` for work done in the conversation itself |
| no reviewer or scout can edit (no edit tools) | a worker running `mem job baseline` first — though skipping it only hurts the worker |
| a taught workflow's steps before a gated shell command | |
| no job, no sub-agent | |
| a destructive command, or a read of a secret file, refused before it runs | |
| a key or token in a worker's change blocks DONE | |
| a job's model and effort, rewritten onto the Agent call by a hook | the compact instructions, and the nudge to start a new session |

The split is deliberate: a line in a prompt is a request, and the things that are cheap to check by
running something are checked by running something.

## What it costs

Measured on this machine, Claude Code 2.1, Haiku 4.5, subscription login:

- One scribe call: about 4,300 tokens in, 300–600 out, **$0.011–0.013**, 4–8 s, in the background.
- 30 labelled turns over six conversations: **$0.07**. It remembered 16 of 16 things it should, put
  16 of 16 in the right project, proved all 16 with a real quote, and remembered 0 of 14 throwaway turns.
- The always-loaded prompt (`AGENTS.md`) is about 650 tokens, and a test keeps it there.
- The router: one local call per job, about 1.5 s, $0. llama-server holds about 3.6 GB while it answers
  and is stopped right after, so nothing stays resident between jobs. The 21 briefs on this machine all
  came back as valid answers, 0.7–2.2 s each.

`mem config scribe.model sonnet` switches the writer's model; `off` makes the chat model save directly.

## Tests

```sh
npm test                              # 138 tests, no network, no model calls (recorded answers)
node probes/scope-accuracy.mjs        # live: real model, about 7 cents
```

## Layout

```
AGENTS.md            the only always-loaded instructions (CLAUDE.md just imports it)
guides/              read on demand: memory · projects · workflows · delegation · fix · feature · review
prompts/             system prompts for the scribe and dream passes
bin/mem.mjs  src/    the `mem` CLI — Node, zero dependencies, SQLite full-text search
.claude/             hooks, the `mem` permission, the agents (scout · worker and reviewer at each effort), /dream /fix /feature /review
src/route.mjs        how a job's model and effort are chosen: precedence, floors, the ladder, the stats
test/  probes/       the suite, and the live measurement
docs/PLAN.md         the design, the evidence behind it, and what was measured while building it
```
