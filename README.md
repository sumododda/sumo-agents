# sumo-agents

One repo you open and talk to. It works across every other project on the machine, remembers what you
tell it so you never explain twice, learns each project as you go, and hands big work to cheaper
jobs that run in its own loop against the Anthropic API. No harness: Sumo owns its prompt, its tools,
its context and its cost.

The repo holds only the process. Everything learned lives in `~/.sumo-agents/` on each machine and is
never committed — a work laptop and a personal one learn separately.

## Set up a machine

Needs Node 22.19+ on the 22.x line or Node 24.6+, llama.cpp (`brew install llama.cpp`) for the local model that
routes jobs and writes memory, and, for the chat and jobs, either `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token` in the environment.

```sh
git clone https://github.com/sumododda/sumo-agents.git ~/sumo-agents && cd ~/sumo-agents
npm ci                     # install the locked dependencies
node bin/sumo.mjs setup     # creates ~/.sumo-agents, links `sumo` into a directory on your PATH
sumo doctor                 # every line should say ok
sumo chat                   # talk
```

Setup asks one question, once: where to download the router model from. Enter keeps the default,
Hugging Face. Behind a corporate proxy, give the base URL of an Artifactory Hugging Face remote
instead (`https://<host>/artifactory/api/huggingfaceml/<repo-key>`); the same
`<repo>/resolve/main/<file>` path is fetched under it. The 2.5 GB file lands in
`~/.sumo-agents/models/` and is skipped when it is already there.

Sumo enables `NODE_USE_SYSTEM_CA=1` automatically, including for hooks and background processes.
It trusts the OS certificate store alongside Node's bundled CAs, so enterprise CAs installed and
trusted by IT work without a shell export. If IT supplies a separate PEM bundle, set
`NODE_EXTRA_CA_CERTS` to its path before starting Sumo; that bundle is preserved. Restart existing
Sumo processes after changing certificate trust.

```sh
sumo setup --model-source https://<host>/artifactory/api/huggingfaceml/hf-remote   # non-interactive
sumo setup --no-model                                                               # skip the download
sumo config model.source <url>                                                      # change it later
sumo config chat.model opus                                                        # what `sumo chat` runs on; `auto` routes each turn
sumo config chat.effort high                                                       # effort when using a fixed chat model
sumo models                                                                         # the API models: on or off, and why
sumo models discover                                                                # ask the API again which of them this credential can use
sumo models disable fable                                                           # keep one out of the chat, the router and the passes
```

Then just talk. Mention a project the way you normally would; the first time, the agent finds it on
disk, confirms the path with you, and registers it. In the chat: `/fix`, `/feature`, `/review`, `/dream`
load the matching guide; `/model` says the route and sets it — `/model opus high`, `/model haiku`,
or `/model auto` to have the same local router that routes jobs pick a model and effort for each turn
from what you typed (the menu offers the choices as you type; a switch costs one uncached turn, and a
router that cannot answer refuses the turn); `/new` starts a fresh session, the memory block given to
the model again, on a cleared screen; `/memory` opens the memory in your browser; `! <command>` runs a command yourself, where the agent would be refused; `/exit` (or `/quit`) ends it.

The chat is a screen, not a scroll of lines: a box to type in (`\`+Enter, Shift-Enter or Option-Enter
for a new line, Up for what you sent before — the last fifty, kept across sessions — `/` for the command menu;
Ctrl-V pastes an image from the clipboard, on macOS, and an image file dropped on the box is the image —
either stands in the box as `[Image #1]` and goes to the model with the message that names it), each tool call with the top
of its result (Ctrl-O for all of it, and again to fold it back), tables drawn as tables, and a working
line while the model is busy. Esc stops the turn; a message sent while it works is queued and goes
next; Ctrl-C twice leaves. A resized window is redrawn to fit. The memory block goes to the model, not
the screen; only a warning in it is shown. While the conversation is short the box stands at the foot of
the window, a lion faint behind the room above it, covered as the conversation grows. The words on the
working line are yours: `spinner.txt`, one a line, a random one to start each turn and the next every five
seconds; so is the lion, `logo.txt`.
Piped (`echo … | sumo chat`), it prints plain lines, the memory block first.

## Update a machine

```sh
cd ~/sumo-agents && git pull
npm ci                      # refresh dependencies from the lockfile
sumo doctor                 # first line shows the commit now running — compare it with GitHub
```

`sumo` runs straight from the repo, so new code is live the moment it is pulled, and the
database upgrades itself the next time it is opened. Your memory is not touched — it lives in
`~/.sumo-agents/`, outside the repo. Run `sumo setup` again only if `sumo doctor` tells you to (you moved
the repo, or changed Node versions). Start a new `sumo chat` afterwards, so it loads the updated code
and `AGENTS.md`.

## What happens while you talk

Every session runs in Sumo's own loop: one request per turn to the Anthropic Messages API, two tools
(a shell and a file editor, both Anthropic-defined so no schema is sent), a frozen system prompt that
caches across turns, and old tool results cleared server-side once the context passes 60k tokens.
History is never rewritten on the client.

| When | What runs | Cost to the model you chat with |
|---|---|---|
| Session starts | The first user turn is the core block: your global preferences, workflows, projects, where you left off, open jobs, things to confirm. Default cap 800 tokens (`prime.budget`); overflow is reachable by search. | ≤ 800 tokens by default, once |
| You send a message | It is stored word for word (secrets redacted). First mention of a project adds its card — path, stack, commands, your rules for it, gotchas — as an operator message after the cached prefix. | 0, or ≤ 200 once per project |
| A shell command matches a destructive or secret-reading guard (`rm -rf ~`, `git reset --hard`, `git clean -f`, `DROP TABLE`, `cat .env` …), or the editor tries to access a secret file | Refused in plain code before it runs, and the refusal says why. No memory is consulted. The way through is you: `! <command>` runs it yourself. A force-push is not on the list — it is an accepted way of cleaning up history here. | 0 |
| The editor reaches for a path outside the project | Refused: the editor is jailed to the project (symlinks followed). Shell commands start in the project directory but can access other paths. The child environment omits variables whose names indicate credentials. | 0 |
| The agent is about to run a shell command a taught workflow gates (`gh pr create`, for a workflow taught with `--gate 'gh(-axi)? pr create'`) | The command is held back once and the agent is handed the workflow's steps. It follows them, then runs the command. The same steps ride in with your message when you ask for the thing yourself. | 0 until it fires |
| The agent ends a turn on a question | Memory is searched with the question's own words, in plain code. If something close is there, the agent is handed it once and carries on instead of waiting for you; if nothing is, the question reaches you untouched. | 0 unless memory answers |
| A turn ends | The **scribe** is scheduled when a pending turn contains a standing instruction, three turns are waiting, or its last run was at least five minutes ago (or it has never run). Session start and end also sweep up pending turns. A detached call to the local model proposes memories; code checks each against what you actually typed. | 0 |
| 3 finished sessions pile up | The **dream** pass reads them side by side: contradictions, repeated corrections, routines worth naming. | 0 |
| Every model response | One ledger row: tokens in, cached, written, out, cost, the job or session it served. `sumo scribe stats` sums them. | 0 |

What you state is saved silently. What the model could not tie to your exact words is held and put
to you as a one-line question at the next session start. Nothing from web pages, files or tool output
can become a memory.

Corrections that differ by one word or a case-sensitive name are kept as distinct statements;
similar memories can be flagged for you to settle. One message can also state separate rules for
several projects. Background passes serialize their runs and mark only the turns they actually
read as processed, so a message arriving during a pass remains pending. Dream waits for the writer
to finish filing a session before consolidating it.

In `sumo memory`, unsaved edits survive filtering, scope changes and a refused save within the page.
A successful save or Cancel clears that draft; reloading or closing the page loses it.

## See what it knows

```sh
sumo memory                         # the same, as a page in your browser: say yes or no to guesses, edit, forget
sumo export                         # everything, readable, grouped by project
sumo prime                          # exactly what a new session is shown
sumo project show <name>            # a project's card
sumo search "<words>" [--project <name>]
sumo search "<words>" --turns       # what you literally typed
sumo history <id>                   # what a memory replaced, and what replaced it
sumo gate <workflow-id> '<regex>'   # which shell commands a workflow must come before  (off to remove)
sumo scribe show                    # exactly what the cheap model would be sent right now
sumo scribe stats                   # what the background passes have cost
sumo forget <id>                    # stop it being true (history kept);  --purge erases it for good
```

`sumo help` lists the rest. Ids look like `m12` (memories) and `j3` (jobs).

## Delegation

The main agent does small things itself. Big, parallel or reading-heavy work goes to a job: a written
brief (`sumo job new`) run in its own loop (`sumo job run <id>`, or `… &` for a Herdr pane). The job gets
the brief as its only user turn, a short frozen system prompt, and tools by role:

| Role | Model and effort | Tools | For |
|---|---|---|---|
| `scout` | Haiku — or, while Haiku is off, the cheapest model that is on, at low effort | shell | finding, tracing, auditing, summarizing — anything reading-heavy |
| `worker` | chosen per job by the router | shell + editor | building and fixing |
| `reviewer` | chosen per job by the router | shell | judging a change it did not write |

A `sumo job run` typed by the chat agent runs inside the chat process, so the Anthropic credential never enters a
shell — which is why it goes alone in its command: piped or chained it is refused. While it runs the chat
shows it: a line saying which job, on what model, then each thing it runs (one line each; Ctrl-O for the
output) and what it says. A line starting with `@` is said to the job, and read with its next request. A
chat started inside [Herdr](https://herdr.dev) gives every job a tab of its own, listed on the left and
showing the same lines; the chat waits for it to close and reads how it ended, or carries on when the run was
typed with `&`. A job that finished closes its tab behind itself; one that failed or stopped on a question
keeps it, with what went wrong or what it asked on it. Outside Herdr `&` is refused — Herdr is required for tabs. `@j<id> …` reaches a job in a
pane too (on disk, through `sumo job tell <id>`), so does any shell. A blocked job asks (`sumo job ask`); the main agent checks memory before it asks you. Briefs,
notes, answers, reports and check results live in `~/.sumo-agents/jobs/<id>/`, so a job started today
can be picked up tomorrow with the same command. One worker per project at a time — they share a
working tree, and `sumo job new` says so when a second one is created.

## Which model and effort a job gets

The model you chat with never decides this. `sumo job new` does, in plain code, and prints the result:

```
created j27 [worker·sumo-agents·running] Session hygiene: context gauge …
route: opus/xhigh — router: a new feature across hooks and sessions with tests
run it: sumo job run 27   (append & to run it in the background)
```

The route is the router's answer, and nothing else's. On every `sumo job new` and every `sumo job retry`, a
4B open model (Qwen3-4B, through llama.cpp) reads the role, project, task text and the project's history,
describes the job — its kind, how much code it touches, whether it is risky — and then answers with a
model, an effort and one sentence. It runs locally, costs nothing, and takes about a second once the
model is loaded. There are no flags to override it, no project rules, no retry ladder and no floors.

The same model, through the same server, writes memory; see *The local model* below for what it is, how it
is run and how it was measured.

The history it reads is only the evidence against a route: a model/effort that failed here, or that a
review found Important issues in. A clean record is left out — it says nothing about what a cheaper
route would have done, and a router shown one keeps choosing it.

If the router is missing, fails, or answers something no job can run on (a model outside the list, or
no effort for a model that takes one), the command exits with the error and **no job is created**. The
answer schema pairs Haiku with no effort and every other model with one. The only change made to an
answer: a scout runs on Haiku — or, while Haiku is off, on the cheapest model that is on, at low effort.
`sumo doctor` fails while the router is missing.

Effort is real, not advisory: the route's effort goes on the request as `output_config.effort`, its model as the
model id, and the run's ledger rows say what ran — so what was chosen is what runs.

Models available to jobs: `haiku`, `sonnet`, `opus`, `fable`. Effort levels: `low`, `medium`,
`high`, `xhigh`, `max`; Haiku takes none.

Each of the four has a switch on this machine, and nothing assumes the API has all of them. `sumo setup`
asks the API once which of them this credential can use (one `GET /v1/models/<id>` per model) and turns
off the ones it does not have; `sumo models` lists them with the API id and the reason for each switch;
`sumo models discover` asks again and sets the switches from the answer; `sumo models enable|disable
<name>` sets one by hand. A check that fails — no credential, an error, or an answer with none of them —
changes nothing and says why. A model that is off is outside the router's grammar and prompt, refused by
`/model` and by `sumo config chat.model` / `scribe.model` / `dream.model`, never retried on by the passes
(the retry goes to the cheapest model that is on, or nowhere), and a job routed to it before it was
turned off is not run. `sumo doctor` says which are on, warns while nothing was checked, and fails when
none is on or a configured one is off.

**The label that grades a route is a review, not a green check.** A worker's DONE only proves the
checks passed; every Sonnet worker here passed its checks and the Opus reviews that followed found 1 to 7
Important issues each. So when a reviewer finishes, its Important count is stored on the job it judged,
and that is what the router's history and `sumo job stats` report:

```sh
sumo job stats --project <slug>     # per model/effort: jobs, done, failed, reviewed, avg important
sumo job retry <id>                 # a failed job, or one reviewed with 3+ Important: same brief,
                                   # previous notes and report attached, routed afresh
```

The router itself is graded by a set of labelled tasks, each with the cheapest and the dearest route that
would be right for it. Run it after changing the router's prompt, its history or its model; it asks the
real router in a throwaway home and prints how many tasks were routed too high and too low:

```sh
node --disable-warning=ExperimentalWarning test/router-probes.mjs
```

A retry is routed like any job, except that the router is also told what the previous attempt ran on
and how it ended.

## How coding work gets done

Three kinds of work have a written way of doing them. Each is a short numbered list in `guides/`, read
only when that work comes up:

| You type | Guide | The gist |
|---|---|---|
| `/fix <what is wrong>` | `guides/fix.md` | What changed recently → make it fail on demand → find *where* it breaks before saying *why* → one cause at a time, each with evidence → fix where it starts → the same reproduction passes |
| `/feature <what to build>` | `guides/feature.md` | Size it (experiment · change to existing code · new subsystem) → agree what done means → tests first, seen failing → build without touching them → name a wrong implementation that would still pass, and kill it |
| `/review <what to judge>` | `guides/review.md` | A reviewer that did not write the code, reading only the change: first "does it do what was asked" (missing · extra · misunderstood), then "can it be trusted"; every finding has a file:line and a concrete way it fails |

You do not have to type the command: `AGENTS.md` tells the agent to read the matching guide first.

**`--guide`** is how the same steps reach a job. `sumo job new --guide fix` pastes `guides/fix.md`
into the worker's brief, so a delegated fix is done the same way as one done in the conversation. A
reviewer job always carries `guides/review.md`.

## How a worker's DONE is checked

Whoever did the work does not grade it. A worker's `DONE` rests on what the project's own checks say,
run by `sumo` — not on what the report says.

```
sumo job new            records where the work starts: the tree exactly as it is, your uncommitted
                       edits included, so they are never counted as the job's
sumo job baseline <id>  the worker's first step — runs the project's checks before any edit and records
                       what already fails
   … the worker works …
sumo job verify <id>    runs the same checks and gives the verdict, without closing anything
sumo job finish <id> --status DONE
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
| a check declared at the start was removed, or its definition was changed | the original checks must still judge the work | **blocks DONE** — `--tests-may-change` allows definition changes, not removed commands |
| files changed while the checks ran | the verdict does not cover the resulting tree | **blocks DONE** — verify again after the files settle |
| a check `was already failing` | broken before the job began, and still is | allowed; both outputs are kept to compare |
| a key, token or private key was added (`ghp_…`, `sk-…`, `AKIA…`, a PEM block, a JWT), or a secret file (`.env`, `*.pem`, `id_rsa`) is in the change | a credential is about to be committed | **blocks DONE** |
| `look at:` added lines with `eslint-disable`, `@ts-ignore`, `# noqa`, `.skip(`, `t.Skip(` … | a checker was told to look away | allowed, and printed beside the STATUS line for a person to judge |
| `look at:` added lines with `password=`, `token=`, or a long random string | a credential, or a fixture that looks like one | allowed, and printed for a person to judge |
| `note:` not a git repository / no commands | it could not be known | said, never guessed |

A refused worker always has an honest way out, and the refusal names it: fix it, finish as `FAILED`, or
`sumo job ask`. When the checks cannot run on this machine, `--accept "<why>"` takes the work anyway and
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
sumo job new --project <slug> --agent reviewer --reviews <job id> --title "review j12"   # that job's change
sumo job new --project <slug> --agent reviewer --title "review the tree"                  # whatever is uncommitted
```

What was asked for goes on stdin — a review is against that, not against taste. The reviewer is handed
the whole change as one file (`changes.diff` in its job folder; `sumo job changes <id>` writes the same
file for any worker job), the original brief, and the author's report marked as *claims, not facts*.
It reports: asked vs built · findings, worst first · minor (listed, never a reason to reopen the work) ·
what the change alone could not show.

The reviewer runs in a fresh context, with its model and effort chosen by the local router for that
review. There is no guarantee that its model is stronger than the worker's. Findings are still
claims — `guides/review.md` ends with how to receive them.

## When to start a new session

Model quality falls with the absolute size of the context, not with the share of the window that is
full: degradation is measurable from tens of thousands of tokens, and a coding-agent study passed 8 of
10 runs clean and 3 of 10 with about 75k tokens of extra context, relevant or not. A new task gets a
new session. So:

- **A gauge, not a guess.** The exact context size comes back with every response and shows in the
  chat's status line (or the plain-text prompt, `sumo 92k>`). At 80k tokens the agent is told once —
  finish the piece in hand, then ask for `/new`. At 150k it is told to stop and note where it is.
- **A boundary nudge.** `sumo job finish` and `sumo job abandon` end with a `/new` line when the session
  is already heavy, because a task boundary is the cheapest place to start over.
- **Nothing is lost.** The end of a turn records where you left off, and the next session's first
  block brings it back. Open jobs resume from their briefs.
- **Old tool output goes first.** Past 60k tokens the API clears the oldest tool results from what
  the model reads, keeping the last five; the conversation itself stays intact.

## What a project card tells you about hygiene

`sumo project add` scans what the project declares about itself. Besides stack and commands, the card
says what is absent — `not set up here: a lint command, a CI workflow` — so that "nothing failed" is
never mistaken for "it was checked". A `check` script or target counts as the project's gate and stands
in for test and lint. `sumo project rescan <slug>` after setting one up.

## What is enforced, and what is only asked

| Enforced by code | Asked in a prompt |
|---|---|
| a worker's DONE against the project's checks and a baseline | the steps in `guides/fix.md`, `feature.md`, `review.md` |
| existing tests untouched by a worker | the rules in `AGENTS.md` for work done in the conversation itself |
| reviewers and scouts receive no editor tool | reviewers and scouts use their shell only for reading |
| | a worker running `sumo job baseline` first — though skipping it only hurts the worker |
| a taught workflow's steps before a gated shell command | the nudge to start a new session |
| no job, no run | |
| matched destructive and secret-reading shell commands are refused; editor paths stay inside the project and exclude secret files | shell commands stay inside the project |
| environment variables with credential names are omitted; recognized secrets in output are redacted | |
| a key or token in a worker's change blocks DONE | |
| a job's model and effort, set on the request from its route | |

The split is deliberate: a line in a prompt is a request, and the things that are cheap to check by
running something are checked by running something.

## The local model

One open model does the machine's bookkeeping: it routes every job and every `auto` chat turn, and it
writes memory — the scribe after your turns, the dream pass over finished sessions. It is Qwen3-4B at
Q4_K_M (a 2.5 GB file), run by llama.cpp's `llama-server`, downloaded once by `sumo setup` from
`model.source`, `model.repo` and `model.file`. The router asks it without thinking and has an answer in
about a second; the passes ask it with thinking on, capped at 1,024 tokens of thought by the server's
reasoning budget, and have one in 8–15 s. Every answer is held to a JSON schema by the server's grammar,
then checked by code against what you actually typed before anything is filed.

It is one server, started by the first call that needs it and left running, detached, in router mode over
`~/.sumo-agents/models/` with a 32k-token context. It sleeps after ten idle minutes (under 0.5 GB resident)
and wakes in under a second; the first load after it starts takes up to about 15 s; it holds about 7 GB
while it answers. `sumo scribe status` shows its pid, port and whether the model is loaded. `sumo setup`
stops it, so a changed model file or binary takes effect. Its output goes to `~/.sumo-agents/logs/llama-server.log`.

```sh
sumo config model.repo <org>/<repo>     # another GGUF repository on the model source
sumo config model.file <name>.gguf      # the file within it — then: sumo setup
sumo config scribe.model haiku          # send the writer to the API instead (also sonnet, or off); dream.model likewise
```

### How it was chosen

Measured on this machine (M5 Pro, 48 GB) on 2026-10-04 with the repo's own probes. The scope probe is
30 labelled turns over six conversations, 16 of them worth remembering: it asks whether the writer keeps
what it should, puts each memory in the right project, proves it with a quote from what was typed, and
leaves the 14 throwaway turns alone. Haiku 4.5 ran the same day for the baseline.

| Writer | Remembered | Right scope | Quoted | Noise filed | Per call | Resident |
|---|---|---|---|---|---|---|
| **Qwen3-4B, thinking capped at 1,024 — the default** | 16/16 | 16/16 | 16/16 | 0 | 8–15 s | ~7 GB awake |
| Haiku 4.5, through the API | 16/16 | 16/16 | 16/16 | 0 | 8–22 s, $0.088 for six | — |
| Qwen3.5-4B, thinking capped | 16/16 | 15/16 | 16/16 | 0 | 8–13 s | 3.7 GB |
| Qwen3.5-9B, thinking capped | 15/16 | 14/15 | 15/15 | 0 | 26–29 s | 6.4 GB |
| Qwen3.5-9B, thinking uncapped | every call hit the token limit with no answer | | | | 137 s | |
| Qwen3-4B, no thinking | 14/16 | 12/14 | 14/14 | 4 | 1–5 s | |
| Qwen3.5-4B, no thinking | 14/16 | 11/14 | 14/14 | 2 | 1–4 s | |
| Qwen3.5-9B, no thinking | 14/16 | 10/14 | 14/14 | 0 | 2–7 s | |
| Gemma 4 E4B, no thinking | 14/16 | 13/14 | 14/14 | 0 | 2–5 s | 5.3 GB |

Two things decided it. Thinking is what closes the gap to Haiku, and the cap is what makes thinking safe:
uncapped, the 9B thought until the token limit on every call, and the 4B did once on a trivial prompt. And
the model already here is the best of them: on the router's own grading set — 12 labelled tasks, each with
the cheapest and dearest acceptable route, over three project histories — Qwen3-4B routes 11 of 12 right on
each history, where Qwen3.5-4B fell to 9, 9 and 11. The larger candidates (Qwen3.6-35B-A3B, Nemotron 3 Nano
30B) are 22–25 GB files, too much to keep resident on a laptop that is also being worked on.

Caveats: the probe's bundles are about 750 tokens, while real scribe bundles are 4,800 tokens at the median
and 9,400 at the 90th percentile and carry the assistant's replies and related memories, so real accuracy
may be lower. Every number is one run at temperature 0 of a set written by the author.

```sh
node probes/scope-accuracy.mjs                                    # the configured writer: local, $0, about 90 s
node probes/scope-accuracy.mjs haiku                              # the same turns on the API model, about 9 cents
node --disable-warning=ExperimentalWarning test/router-probes.mjs  # the router's grading set
```

## What it costs

- A scribe or dream pass: $0, 8–15 s in the background, no credential needed. On this machine the 224 Haiku
  scribe calls before the switch cost $1.86 in all, and dream's 18 cost $0.17.
- The router: one local call per job, about a second once the model is loaded, $0.
- The server: about 7 GB while it answers, under 0.5 GB asleep.
- The always-loaded prompt (`AGENTS.md`) is about 650 tokens, and a test keeps it there.

When a local call fails (server down, a bundle past the 32k context, an answer cut off) and a credential is in
the environment, the pass is retried once on Haiku; both calls are in the ledger, and `sumo scribe stats` sums
it per kind. `sumo config scribe.model haiku` (or `sonnet`) sends the writer straight to the API; `off` makes
the chat model save directly. `dream.model` is the same.

## Tests

```sh
npm test                              # offline suite, no real model calls (recorded answers)
node probes/scope-accuracy.mjs        # live: the local writer on 30 labelled turns, $0 (`haiku` to compare, about 9 cents)
```

## Layout

```
AGENTS.md            the system prompt of the chat, and the only always-loaded instructions
prompts/             agent.md — the system prompt of a job; scribe.md, dream.md — the memory passes
guides/              read on demand: memory · projects · workflows · delegation · fix · feature · review
bin/sumo.mjs  src/    the `sumo` CLI — Node, the Anthropic SDK, SQLite full-text search
src/loop.mjs         the loop every conversation runs in; src/tools.mjs the shell and editor with their policy
src/chat.mjs         the chat; src/hooks.mjs the session policy as events
src/ui.mjs           the chat's screen (Ink, loaded only by `sumo chat`); src/editor.mjs the box you type in
spinner.txt          the words the chat shows while it works — edit them; logo.txt the lion behind the screen
src/route.mjs        how a job's model and effort are chosen: the router, and the stats
src/local-server.mjs the one llama-server behind the router and the memory passes; src/model.mjs the calls to it and to the API
test/  probes/       the suite, and the live measurements
docs/ADR-runtime.md  the decision to own the runtime, and the plan it followed; docs/PLAN.md the original design
```
