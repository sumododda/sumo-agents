# sumo-agents

A coding agent you talk to from one place. It works across every project on your machine, remembers what
you tell it, and hands big work off to background jobs.

- **One chat for everything.** Mention a project by name; Sumo finds it on disk and works there.
- **Persistent memory.** Your preferences, project rules and where you left off are stored locally and
  loaded into every new session. You never explain the same thing twice.
- **Background jobs.** Large, parallel or reading-heavy work goes to `scout`, `worker` and `reviewer`
  jobs. A local model picks the model and effort for each one.
- **Checked results.** A worker can't report `DONE` until the project's own tests and linters agree.
- **No harness.** Sumo runs its own agent loop against the Anthropic API. It owns its prompt, tools,
  context and cost.

This repo holds only the code and prompts. Everything Sumo learns lives in `~/.sumo-agents/` on each
machine and is never committed, so a work laptop and a personal one learn separately.

## Contents

- [Install](#install) · [Update](#update) · [Configuration](#configuration)
- [Using the chat](#using-the-chat) · [Projects](#projects) · [Memory](#memory)
- [Jobs and delegation](#jobs-and-delegation) · [Routing](#routing-which-model-a-job-gets)
- [Coding guides](#coding-guides) · [Verifying a worker's DONE](#verifying-a-workers-done) · [Reviews](#reviews)
- [Web search](#web-search) · [MCP servers](#mcp-servers)
- [Safety](#safety) · [Context and sessions](#context-and-sessions) · [How a turn runs](#how-a-turn-runs)
- [The local model](#the-local-model) · [Costs](#costs) · [Development](#development) · [Repository layout](#repository-layout)

---

## Install

**Requirements**

- Node 22.19+ (on the 22.x line) or Node 24.6+
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`), for the local model that
  routes jobs and writes memory
- One of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment
- Optional: `herdr` (`brew install herdr`), which opens a tab per job so you can watch it work

```sh
git clone https://github.com/sumododda/sumo-agents.git ~/sumo-agents && cd ~/sumo-agents
npm ci                     # install locked dependencies
node bin/sumo.mjs setup    # create ~/.sumo-agents and link `sumo` onto your PATH
sumo doctor                # every line should say ok (warn on optional items like herdr is fine)
sumo chat                  # start talking
```

The first `sumo setup` asks one question: where to download the router model from. Press Enter for the default
(Hugging Face). The 2.5 GB model file goes to `~/.sumo-agents/models/` and is skipped if already there.

```sh
sumo setup --model-source <url>   # non-interactive
sumo setup --no-model             # skip the download
sumo setup --bin-dir <dir>        # where to link `sumo` (or --no-link to skip linking)
```

**Behind a corporate proxy**

- *Model download:* use the base URL of an Artifactory Hugging Face remote,
  `https://<host>/artifactory/api/huggingfaceml/<repo-key>`. The usual `<repo>/resolve/main/<file>` path is
  fetched under it.
- *Certificates:* Sumo sets `NODE_USE_SYSTEM_CA=1` for itself, its hooks and its background processes, so
  CAs your IT team installed in the OS store just work. For a separate PEM bundle, set
  `NODE_EXTRA_CA_CERTS` before starting Sumo. Restart running Sumo processes after changing trust.

## Update

```sh
cd ~/sumo-agents && git pull
npm ci        # refresh dependencies
sumo doctor   # the first line shows the running commit; compare it with GitHub
```

`sumo` runs straight from the repo, so pulled code is live immediately and the database migrates itself on
next open. Your memory in `~/.sumo-agents/` is untouched. Start a new `sumo chat` to pick up the new code and
`AGENTS.md`. Re-run `sumo setup` only if `sumo doctor` asks (you moved the repo or changed Node versions).

## Configuration

Set with `sumo config <key> <value>`; `sumo config` alone lists them.

| Key | Default | What it does |
|---|---|---|
| `chat.model` | `opus` | Model for `sumo chat`. `auto` lets the local router pick model and effort per turn. |
| `chat.effort` | `high` | Effort when `chat.model` is a fixed model. |
| `chat.notify` | `on` | Bell + notification when a long turn ends in a background window. |
| `guides.auto` | `on` | `off` stops guides from loading unasked and stops holding turns with unchecked edits. |
| `projects.home` | `~` | Where new projects are created. |
| `scratch.days` | `14` | Days before a scratch folder nothing was written in is deleted. |
| `prime.budget` | `800` | Token cap on the memory block that starts each session. |
| `scribe.model` | `local` | Who writes memory: `local`, `off` (the chat model saves directly), or any API model that is on. |
| `dream.model` | `local` | Same choices, for the dream pass. |
| `model.source` | `https://huggingface.co` | Where the local model is downloaded from. |
| `model.repo` | `Qwen/Qwen3-4B-GGUF` | GGUF repository on the model source. |
| `model.file` | `Qwen3-4B-Q4_K_M.gguf` | File within it. Run `sumo setup` after changing. |

**API models.** Jobs and the chat can use `haiku`, `sonnet`, `opus` and `fable`. Each has an on/off switch on
this machine.

```sh
sumo models                  # each model: on or off, its API id, and why
sumo models discover         # ask the API again which ones this credential can use
sumo models disable fable    # keep one out of the chat, router and memory passes (`enable` undoes it)
```

`sumo setup` checks once (`GET /v1/models/<id>` per model) and turns off the ones your credential lacks.
`discover` re-checks but leaves models you turned off by hand off. A failed check changes nothing. A model
that is off is hidden from the router, refused by `/model` and `sumo config`, never used for a retry, and
won't run a job that was routed to it earlier. `sumo doctor` fails if no model is on or a configured one is off.

**Environment variables**

- `SUMO_AGENTS_HOME`: use a directory other than `~/.sumo-agents` (e.g. a second profile).
- `SUMO_AGENTS_CHECK_TIMEOUT_MS`: time limit per project check (default 9 minutes).

---

## Using the chat

Run `sumo chat` and talk. Piped input (`echo … | sumo chat`) prints plain lines instead of the full screen.

### Commands

| Command | What it does |
|---|---|
| `/fix`, `/feature`, `/review` | Load that [coding guide](#coding-guides) for this message. |
| `/model [model] [effort]` | Show or set the chat model, e.g. `/model opus high`, `/model haiku`, `/model auto`. Changing the model costs one uncached turn. |
| `/new` | Start a fresh session. The old one scrolls up; it is not wiped. Refused while a background job is at work. |
| `/resume [id]` | Without an id, list saved sessions (newest first, heavy ones marked). With one, reopen it and redraw its last five turns. Refused while a background job is at work. |
| `/copy` · `/copy code` | Copy the last reply, or its last code block, to the clipboard exactly as written. |
| `/dream` | Tidy the memory now and report what changed. |
| `/memory` | Open the memory in your browser. |
| `/mcp` | List MCP servers, their tools and what may run unasked. |
| `/stop [job]` | Stop a background job (e.g. `/stop j43`). |
| `! <command>` | Run a shell command yourself, including ones the agent is refused. The model sees its output. |
| `/help` | List commands and keys. |
| `/exit`, `/quit` | Leave. |

From the shell: `sumo chat --model M --effort E` starts on that route, and `sumo chat --resume [id]` reopens a
session (the newest if no id).

### Keys

| Key | Action |
|---|---|
| `\`+Enter, Shift-Enter, Option-Enter, Ctrl-J | New line |
| Up | Previous messages (last 50, kept across sessions). On an empty box, takes back a queued message. |
| `/` | Command menu |
| `@` + letters | Insert a file path from the project's git tree (Enter or Tab to accept, Esc to dismiss) |
| Ctrl-V | Paste an image from the clipboard (macOS). Dropping an image file also works. |
| Ctrl-G | Edit the message in `$VISUAL` / `$EDITOR` |
| Ctrl-O | Open the whole conversation, every command and its full output, in `$PAGER` (or `less`) |
| Esc | Close the menu or an open job; otherwise stop the current turn |
| Ctrl-C | Clear the box. On an empty box: stop the running turn, or press twice within 2 s to exit. |
| Ctrl-D | Exit (on an empty box) |
| Ctrl-A / Ctrl-E, Ctrl-U / Ctrl-K, Ctrl-W, Option-←/→ | Readline-style editing (`/help` lists them all) |
| Down, then Enter | Step onto a background job and open it (see [Jobs](#jobs-and-delegation)) |

### Sending while it works

- A **message** sent mid-turn is read with the model's next request, in the same turn (shown as `next step:`,
  or `when j<id> reports:` while the turn waits on a job).
- A **command or image** waits for the turn to end (shown as `queued:`).
- Stopping the turn puts everything queued back in the box.

### What the screen shows

- **Your messages** at full weight with a bar down the side. Images appear as `[Image #1]`.
- **Tool calls:** a command shows its first lines, and while it runs, its last three lines of output and the
  elapsed time. When done: the first two and last three lines of output. Edits show as numbered diffs with
  context and a `+1 −1` count.
- **Replies** rendered as markdown: bold, italics, lists, task boxes, quotes, code blocks and tables.
- **A working line** while the model is busy, with the last three lines of its thinking summary below it
  (every model but Haiku). It says so if the model goes quiet for 20 seconds with nothing running.
- **A summary line** after any turn that made calls or took 10+ seconds: duration, calls, files edited, cost.
  If the turn took 10+ seconds and the window is in the background, it also rings a bell and sends a
  notification (OSC 9). So does an MCP call waiting for your approval, and a background job's report.
  `chat.notify off` turns this off.
- **The status line** under the box: model and effort, context size, session cost, and the project and branch.
- **The window title:** `sumo · <project>`, marked while working or waiting.

The memory block goes to the model, not the screen (only warnings in it are shown). Opening the chat scrolls
old terminal output up rather than wiping it; resizing redraws from the top and does wipe it.

**Customize:** the working-line phrases come from `spinner.txt` (one per line, rotated every five seconds),
and the lion shown in an empty chat from `logo.txt`.

---

## Projects

Mention a project the way you normally would. The first time, Sumo finds it on disk, confirms the path with
you and registers it. Any name it had to look up becomes an alias.

Each project gets a **card**: path, stack, commands, your rules for it and known gotchas. The card is added to
the conversation the first time the project comes up. It also lists what is *missing*, e.g.
`not set up here: a lint command, a CI workflow`, so "nothing failed" is never mistaken for "it was
checked". A `check` script or Makefile target counts as the project's gate and stands in for test and lint.

```sh
sumo project add <path> [--slug S] [--alias A]
sumo project show <slug>
sumo project list [--all]      # --all includes archived projects
sumo project rescan <slug>     # after adding a test/lint/check command
sumo project alias <slug> <alias>
sumo project archive <slug>    # memories kept; `project add` brings it back
```

**Scratch.** Work that belongs to no project happens in `~/.sumo-agents/scratch/`, one folder per chore. With
no project named, tools start there; a job gets it as the project `scratch`. Nothing in scratch is
remembered or checked, and anything in it nothing was written in for 14 days (`scratch.days`) is deleted at the next session start. To keep one, move it
out and register it as a project.

## Memory

Everything you type is stored word for word, with secrets redacted. Two background passes turn it into memory:

- **Scribe** runs after turns. It reads what you said, proposes memories, and code checks each against your
  exact words. Statements it can tie to your words are saved silently. Anything it can't is held and asked
  as a one-line question at the next session start.
- **Dream** runs after every three finished sessions. It reads them side by side to find contradictions,
  repeated corrections and routines worth naming.

Only your words become memory. Nothing from web pages, files or tool output is ever saved.

```sh
sumo memory                            # browser page: confirm guesses, edit, forget
sumo prime                             # exactly what a new session is shown
sumo export [--json]                   # everything, grouped by project
sumo search "<words>" [--project S]    # search memories
sumo search "<words>" --turns          # search what you literally typed
sumo add <type> "<text>" [--project S] # types: preference, fact, decision, gotcha
sumo learn "<title>" --cue "<action>" [--gate '<regex>']   # teach a workflow (steps on stdin)
sumo gate <workflow-id> '<regex>'|off  # shell commands a workflow must run before
sumo confirm <id> · sumo reject <id>   # settle a pending guess
sumo history <id>                      # what a memory replaced, and what replaced it
sumo forget <id> [--purge]             # retire it (history kept); --purge erases it
sumo scribe show                       # what the scribe would be sent right now
sumo scribe stats                      # what the background passes have cost
sumo backup
```

Ids look like `m12` (memories) and `j3` (jobs). `sumo help` lists every command.

**Details**

- Corrections that differ by one word or a case-sensitive name are kept as separate statements. Similar
  memories can be flagged for you to settle.
- One message can set separate rules for several projects.
- Passes run one at a time and only mark the turns they actually read, so a message that arrives mid-pass
  stays pending. Dream waits for the scribe to finish a session before consolidating it.
- In `sumo memory`, unsaved edits survive filtering, scope changes and a refused save. Saving or Cancel
  clears the draft; reloading or closing the page loses it.

---

## Jobs and delegation

The chat does small things itself. For big, parallel or reading-heavy work it calls its `delegate` tool: a
written brief becomes a **job**, routed to a model by the [router](#routing-which-model-a-job-gets).

| Role | Tools | For |
|---|---|---|
| `scout` | shell, web search and fetch, job tools | finding, tracing, auditing, summarizing |
| `worker` | shell, editor, `baseline` / `verify`, job tools | building and fixing |
| `reviewer` | shell, job tools | judging a change it didn't write |

Job tools are `note`, `ask`, `search_memory` and `finish`. A job gets its brief (with the project card and
your global rules), a short system prompt carrying the coding rules from `AGENTS.md`, and the tools for its role.

**In the chat, jobs run in the background.** The `delegate` call returns at once and you keep working.
Several `delegate` calls in one reply run in parallel.

- Each running job has a row under the box: `⏺ j43 scout — Map the parser · 2m 10s · 14 tool calls · working`.
  Above them is a row for the chat itself (`⏺ main · working`).
- **Down** steps onto a job, **Enter** opens its live record (each call, the top of its output, what it
  said). Then `@ message` talks to it, Ctrl-O shows the full record, and Esc closes it.
- `@ …` messages the one running job; `@j<id> …` a specific one. The job reads it with its next request.
- When a job reports, the result is drawn in the conversation and the chat model picks the work back up on
  its own. The report is marked as an automated event, never as your words.
- Esc stops the chat's turn, not the jobs. `/stop` (or `/stop j43`) stops a job.
- A question from a job can be answered or refused (Esc) without stopping it.
- `/new` and `/resume` wait until no job is running. Leaving the chat stops running jobs; they can be resumed later.

Piped, or via `sumo job run`, a delegate call simply blocks and returns the report.

**Jobs persist.** Briefs, notes, answers, reports and check results live in `~/.sumo-agents/jobs/<id>/`. Resume
one with `delegate` and its id, or `sumo job run <id>`. Only one worker runs per project at a time, since
they share a working tree.

**Job tools run as separate `sumo job` processes**, so a worker's checks never stall the chat or other jobs.
A job that stops without calling `finish` is told once to close itself. The Anthropic credential never enters
a shell: `sumo job run` and `sumo job new` typed into the chat's shell are refused with a pointer to `delegate`.

```sh
sumo job new --project S --title T [--agent scout|worker|reviewer]   # brief on stdin
sumo job run <id>          # run it (append & to background it)
sumo job list [--all] · show <id> · watch <id> · brief <id>
sumo job tell <id> · answer <id> · abandon <id>
sumo job retry <id>        # failed, or reviewed with 3+ Important issues: same brief, previous notes attached, routed afresh
sumo job stats [--project S]
```

## Routing: which model a job gets

The chat model never decides this. When a job is created or retried, a local 4B model (Qwen3-4B via
llama.cpp) reads the role, project, task and the project's history, classifies the job (kind, how much code it
touches, risk), and answers with a model, an effort and a one-sentence reason. It runs locally, costs nothing,
and takes about a second once loaded.

```
created j27 [worker·sumo-agents·running] Session hygiene: context gauge …
route: opus/xhigh — router: a new feature across hooks and sessions with tests
run it: sumo job run 27   (append & to carry on without waiting for it)
```

- **The router's answer is final.** No override flags, project rules, retry ladders or floors.
- **If the router fails** (missing, errors, or answers something invalid), the command exits with an error
  and **no job is created**. `sumo doctor` fails while the router is missing.
- **Scouts are judged as reading.** Finding and describing are routine; only judging (an audit, a review, a
  bug hunt) is hard. Without this, audits and summaries were read as "novel changes" and sent to the most
  expensive model.
- **History is evidence against a route only:** a model/effort that failed in this project, or that a
  review found Important issues in. Clean runs are left out, since a router shown one keeps choosing it.
- **A retry** is routed like a new job, plus what the previous attempt ran on and how it ended.
- **Effort is real.** It is sent as `output_config.effort`, and the ledger records what actually ran.
- Models: `haiku`, `sonnet`, `opus`, `fable` (only those [switched on](#configuration)). Effort: `low`,
  `medium`, `high`, `xhigh`, `max`. Haiku takes no effort.

**Routes are graded by reviews, not by green checks.** A worker's `DONE` only proves the checks passed. Every
Sonnet worker here passed its checks, and the Opus reviews that followed found 1 to 7 Important issues each.
So a reviewer's Important count is stored on the job it judged, and that is what the router's history and
`sumo job stats` report (per role and route: jobs, done, failed, reviewed, average Important, requests, time, cost).

**Testing the router.** `test/router-probes.mjs` runs the real router in a throwaway home over 18 labelled
tasks, each with the cheapest and dearest acceptable route, and reports how many were routed too high or too
low. Run it after changing the router's prompt, history or model:

```sh
node --disable-warning=ExperimentalWarning test/router-probes.mjs
```

Six of the 18 are scout tasks labelled from this machine's ledger: Haiku scouts took 39–77 requests and
$0.15–$0.50 per job, while one on `sonnet/low` did a similar audit in 6 requests for $0.07. For anything
beyond a single lookup, Haiku is not the cheap option. Measured 2026-10-10: 15, 15 and 16 of 18 right across
three histories (14, 14 and 15 before scouts had their own prompt).

## Coding guides

Three kinds of work have a written procedure in `guides/`. Each loads automatically when your message asks
for that kind of work.

| Command | Guide | Steps |
|---|---|---|
| `/fix <what is wrong>` | `guides/fix.md` | What changed recently → reproduce on demand → find *where* it breaks before *why* → one cause at a time, with evidence → fix at the source → the same reproduction passes |
| `/feature <what to build>` | `guides/feature.md` | Size it (experiment, change, new subsystem) → agree what done means → write tests first and see them fail → build without touching them → name a wrong implementation that would still pass, and rule it out |
| `/review <what to judge>` | `guides/review.md` | A reviewer that didn't write the code reads only the change: first "does it do what was asked" (missing, extra, misunderstood), then "can it be trusted". Every finding has a file:line and a concrete failure. |

**Auto-matching.** Each guide starts with a `when:` line of trigger words (`fix, bug, broken, failing, crash, …`).
Your message is matched against them by word stem — no model, no delay. Rules:

- At most one guide per message, and each guide once per session. (`/fix`, `/feature` and `/review` load their
  guide every time, even if it was already shown or a taught workflow matched.)
- Priority: review, then fix, then feature ("review my fix" is a review; "fix the broken add button" is a fix).
- A taught workflow that matches the same message wins.
- In the chat, `review` becomes "delegate this to a reviewer", since code written in a session is never judged in it.
- The screen shows `guide: fix` when one loads. `guides.auto off` disables matching; the commands still work.
- `test/guides.test.mjs` holds 50 realistic messages with the guide each should load; 7 are known misses the
  test accepts.

**For jobs:** `sumo job new --guide fix` pastes the guide into the brief. Without `--guide`, a worker gets `fix` or
`feature` if its title and goal ask for one (not when `guides.auto` is off; `--guide none` for none), a reviewer
always gets `review.md`, and a scout gets none.

## Verifying a worker's DONE

A worker doesn't grade its own work. Its `DONE` rests on the project's checks, run by `sumo`.

```
sumo job new            snapshot the starting tree, uncommitted edits included, so they never count as the job's
sumo job baseline <id>  worker's first step: run the checks before any edit and record what already fails
   … the worker works …
sumo job verify <id>    run the same checks and give a verdict, without closing anything
sumo job finish <id> --status DONE
                       reuse that verdict if no files changed since, otherwise re-run;
                       refuse DONE while anything blocks
```

**The checks** are the project's `check` script or Makefile target if it has one, otherwise its `test`, `lint`
and `typecheck` commands (the ones on the project card). Each has 9 minutes; the tail of its output is kept in
the job folder.

| Verdict | Effect |
|---|---|
| A check fails that passed at baseline | **Blocks DONE** |
| A check fails and no baseline was taken | **Blocks DONE** (nothing proves it was already broken) |
| An existing test was edited, renamed or deleted | **Blocks DONE**, unless the job was created with `--tests-may-change` |
| A declared check was removed or its definition changed | **Blocks DONE** (`--tests-may-change` allows definition changes, not removals) |
| Files changed while checks ran | **Blocks DONE**; verify again once files settle |
| A secret was added (`ghp_…`, `sk-…`, `AKIA…`, PEM block, JWT) or a secret file (`.env`, `*.pem`, `id_rsa`) is in the change | **Blocks DONE** |
| A check was already failing at baseline and still is | Allowed; both outputs kept |
| `look at:` added `eslint-disable`, `@ts-ignore`, `# noqa`, `it.skip` / `test.only`, `t.Skip(` … | Allowed; printed for a human to judge |
| `look at:` a checker's settings file changed (`tsconfig*.json`, eslint, jest/vitest config, `pytest.ini`, `ruff.toml`, …) | Allowed; printed for a human to judge |
| `look at:` added `password=`, `token=`, or a long random string | Allowed; printed for a human to judge |
| `note:` not a git repo, or no check commands | Stated, never guessed |

**Escape hatches.** A refused worker is told how to proceed: fix it, finish as `FAILED`, or `sumo job ask`. When
the checks can't run on this machine, `--accept "<why>"` skips them and takes the work as `DONE (UNVERIFIED …)`.
So a worker's plain `STATUS: DONE` means every declared check agreed (a project with none says so in a `note:`).
Only worker jobs are verified; a scout's or reviewer's `DONE` is not.

- In a git project, a baseline requested after the first edit is refused (it would hide the job's own
  breakage); every failing check then counts as the job's.
- New test files are always welcome; only pre-existing tests are protected.

**The report** has two extra sections: **Concerns** (finished but unsure) and **Decisions** (each call made on
your behalf: what, why, the cost if wrong). Workers settle small questions themselves and stop to ask only for
something destructive, security-sensitive, outside the project, or too unclear to do without guessing.

## Reviews

```sh
sumo job new --project <slug> --agent reviewer --reviews <job-id> --title "review j12"   # a job's change
sumo job new --project <slug> --agent reviewer --title "review the tree"                  # uncommitted changes
```

Put what was asked for on stdin; the review is against that, not taste. The reviewer gets the full change as
one file (`changes.diff`; `sumo job changes <id>` writes it for any worker job in a git
repository), the original brief, and the
author's report marked as *claims, not facts*.

It reports: asked vs. built · findings, worst first · minor items (listed, never a reason to reopen) · what the
change alone couldn't show.

The reviewer runs in a fresh context, routed like any job, so its model is not guaranteed to be stronger than
the worker's. Treat findings as claims too; `guides/review.md` ends with how to receive them.

---

## Web search

The chat and `scout` jobs have `web_search` and `web_fetch`, the Anthropic API's server-side tools. They run
inside the request: no key, no dependency, nothing executed locally. Searches show as `Search(…)` with results,
fetches as `Fetch(…)` with size, and cited pages are listed under the reply.

- **Workers and reviewers don't get them.** A web page is someone else's words and is kept out of the
  conversations that change or judge code.
- **This is not a hard boundary.** The chat that reads a page also has a shell with your environment; only the
  model's judgment stands between them.
- **Cost:** a search is $0.01 plus tokens (logged in the ledger); a fetch is tokens only. One search plus one
  page is roughly 30k tokens of context, so research across many pages belongs in a scout.
- Pages are cut at ~20k tokens; PDFs come whole. No cap on searches per reply.
- Both tools are called directly, because the newer code-filtered variant is refused on a Claude Code token.

## MCP servers

Sumo connects to MCP servers you configure (Azure DevOps, Slack, …). None are set up by default. Config lives in
`~/.sumo-agents/mcp.json` in Claude Code's format, so an existing config can be pasted in.

```sh
sumo mcp add azure-devops -- npx -y @azure-devops/mcp <your-org>                    # stdio process
sumo mcp add slack --env 'SLACK_TOKEN=${SLACK_TOKEN}' -- npx -y <the slack server>  # pass a token by name
sumo mcp add remote --url https://host/mcp --header 'Authorization=Bearer ${TOKEN}' # streamable HTTP
sumo mcp                                       # all servers: status, tools, what may run unasked (/mcp in chat)
sumo mcp tools <name>                          # one server's tools
sumo mcp allow <name> <tool>|all               # run without asking (`revoke` undoes it)
sumo mcp remove <name>
```

**Secrets.** `${NAME}` is filled from your shell when the server starts, so the file never holds a token. An
unset name refuses that server with the reason. A stdio server inherits your environment (minus Sumo's own
credential) plus any `--env` entries, and gets Sumo's `node` first on `PATH` so `npx` is found. Use full paths:
servers start in Sumo's working directory.

**Context cost.** Tools are deferred behind Anthropic's tool search: no schema enters the context until the
model searches for it, so 40 unused tools cost nothing per turn and the cache is untouched. The system prompt
only names each server and its tool count. The chat and all jobs get the same tools.

**Permissions.** Every call is checked against an allow list. An unlisted tool asks on the chat's screen:
`y` once, `a` always (written to the file), `n` refuse, Esc stop the turn (for a background job's call, Esc refuses just that call). Jobs delegated from the chat ask on
the same screen, tagged with their id. With nobody to ask (`sumo job run` in a terminal, or piped chat) the call
is refused with the `sumo mcp allow` command that would permit it. A refusal is final for that call.

**Behavior.** Output gets the same size cap and redaction as any tool output; images and files are described,
not sent. A crashed server restarts on the next call; one that fails to connect is reported and skipped for the
session. Servers connect once per `sumo chat`, so server changes apply to the next one; allow-list changes apply at once.

**Not supported yet:** the legacy HTTP+SSE transport, OAuth sign-in to remote servers (use a header token),
images to the model, MCP resources and prompts.

---

## Safety

### Shell and editor guards

Checked in plain code before anything runs. No memory or model is consulted.

- **Destructive or secret-reading commands are refused** with the reason: `rm -rf ~` (by any path, escaped,
  behind `sudo`, `env`, `nice`, `timeout`, `xargs` or `command`, flags before or after the target),
  `git reset --hard`, `git clean -f`, `DROP TABLE`, `cat .env`, … Ordinary deletes like `rm -rf node_modules`
  still pass. Force-push is deliberately allowed. To run a refused command yourself, use `! <command>`.
- **The editor is jailed to the project** (symlinks followed) and can't touch secret files.
- **Shell commands** start in the project directory but can reach other paths. They run with your full
  environment (so probes and smoke tests can use your tokens) *minus* Sumo's own Anthropic credential.
  Commands that only print the environment (`env`, `printenv`, bare `export` or `set`) are refused. Load a
  `.env` with `set -a; source .env; set +a`, never print it.
- **Recognized secrets in output are redacted.**

### Enforced vs. requested

Things that are cheap to check by running something are checked by running something. Everything else is a
request in a prompt.

| Enforced by code | Only asked in a prompt |
|---|---|
| A worker's `DONE` against the project's checks and a baseline | Following the steps in `guides/fix.md`, `feature.md`, `review.md` |
| Existing tests untouched by a worker | The `AGENTS.md` rules for work done in the chat itself |
| Reviewers and scouts get no editor | Reviewers and scouts using their shell only to read |
| A taught workflow's steps before a gated shell command | A worker running `sumo job baseline` first (skipping it only hurts the worker) |
| A turn that edited files without running a declared check is held once | The nudge to start a new session; following a loaded guide |
| No route, no job | Shell commands staying inside the project |
| Matched destructive and secret-reading commands refused; editor jailed | |
| Sumo's credential withheld from every command; env dumps refused; secrets redacted | |
| A key or token in a worker's change blocks `DONE` | |
| A job's model and effort set on the request from its route | |
| An MCP tool not on the allow list waits for you, or is refused with nobody to ask | |

## Context and sessions

Model quality drops with the absolute size of the context, not the fraction of the window used. It is
measurable from tens of thousands of tokens: in one coding-agent study, 8 of 10 runs passed clean, but only 3
of 10 with ~75k tokens of extra context, relevant or not. **A new task deserves a new session.**

- **Gauge.** The exact context size is shown in the status line (or the plain prompt, `sumo 92k>`). At 80k
  the agent is told once to finish the current piece and suggest `/new`; at 150k, to stop and note where it is.
- **Boundary nudge.** `sumo job finish` and `sumo job abandon` suggest `/new` when the session is already heavy.
- **Nothing is lost.** Each turn records where you left off, and the next session's memory block brings it
  back. Open jobs resume from their briefs. `/resume` restores a session whole for 30 days, for the price of
  one uncached turn.
- **Old tool output is cleared first.** Past 60k tokens the API drops the oldest tool results, keeping the
  last five; the conversation itself is untouched.
- **Jobs are compacted, not stopped.** At 150k tokens (at the end of a tool round), a job's conversation is
  summarized server-side, keeping the task, decisions, attempts, progress, next step and exact names and
  errors. The job continues from the summary, pointed at `sumo job brief <id>` for anything left out. Not
  repeated within three turns. The chat isn't compacted; it keeps its nudges.
- **Resumed sessions carry no thinking.** A thinking block is bound to the exact history it was made in, and a
  saved session has secrets redacted and images removed. `/resume` sends the words and calls only.

Sessions are saved after every turn, with secrets redacted and images removed. A session open in another
terminal can't be resumed.

## How a turn runs

Each session runs in Sumo's own loop: one Anthropic Messages API request per turn, with

- **three tools:** a shell and a file editor (Anthropic-defined, so no schema is sent) and `delegate`, plus
  any MCP tools, deferred behind tool search;
- **a frozen system prompt** that caches across turns;
- **server-side clearing** of old tool results past 60k tokens. History is never rewritten on the client.

**Reliability**

- Overloads, rate limits and broken streams are retried up to six times, backing off from 1s to 30s (or the
  API's `retry-after`). Each retry is shown on screen and logged. Requests the API rejects as invalid are not retried.
- A turn the API pauses on its own continues.
- The same call with the same result three times in a row is flagged to the model; five times stops the turn.
- The second-to-last turn of a run carries a warning, so a job that hits the turn limit still closes properly.

**What happens when**

| When | What runs | Context cost |
|---|---|---|
| Session starts | The memory block: global preferences, workflows, projects, where you left off, open jobs, things to confirm. Overflow is reachable by search. | ≤ 800 tokens (`prime.budget`), once |
| You send a message | Stored word for word, secrets redacted. The first mention of a project adds its card after the cached prefix. | 0, or ≤ 200 once per project |
| Your message asks for a fix, feature or review | The matching [guide](#coding-guides) is added, once per session. | 0, or ≤ 450 once per guide |
| A command matches a guard | Refused before it runs, with the reason. | 0 |
| A command prints more than 16k characters | Both ends are shown. The first and last 64 KB (redacted) are saved to the job folder or `~/.sumo-agents/logs/output/`, and the cut names the file so the model can read a range instead of re-running. Kept a week. | 0 |
| An edit's `old_str` doesn't match exactly | Retried with the file's line endings, then ignoring trailing spaces, then ignoring indentation (replacement re-indented). Still refused unless the match is unique. The result says how it matched. | 0 |
| A shell command is gated by a taught workflow (e.g. `--gate 'gh(-axi)? pr create'`) | Held back once; the agent gets the workflow's steps, follows them, then runs it. | 0 until it fires |
| The agent ends a turn after editing files, but no declared check ran since | It is told which files and which check, and continued once. Screen: `held: 2 files edited, npm test not run`. `git status` doesn't count; a project with no declared check is cleared by any command. | ≤ 60 tokens + 1 request |
| The agent ends a turn on a question | Memory is searched with the question's words. A close match is handed back once and the agent continues; otherwise the question reaches you. | 0 unless memory answers |
| A turn ends | The scribe is scheduled if a pending turn has a standing instruction, three turns are waiting, or it last ran 5+ minutes ago. Session start and end also sweep pending turns. | 0 |
| Three sessions finish | The dream pass runs. | 0 |
| Every model response | One ledger row: tokens in, cached, written, out, cost, and the job or session. `sumo scribe stats` sums them. | 0 |

---

## The local model

One local model handles the bookkeeping: routing every job and every `auto` chat turn, and writing memory
(scribe and dream). It is **Qwen3-4B at Q4_K_M** (2.5 GB), served by llama.cpp's `llama-server`.

- **Router calls** use no thinking and answer in about a second.
- **Memory passes** use thinking capped at 1,024 tokens and take 8–15 s.
- Every answer is held to a JSON schema by the server's grammar, then checked by code: a route against the
  models that are on, a memory against what you actually typed.

**The server** starts on first use and stays running, detached, over `~/.sumo-agents/models/` with a 32k context.
It sleeps after 10 idle minutes (< 0.5 GB resident), wakes in under a second, takes up to ~15 s on first load,
and uses ~7 GB while answering. When the scribe is on the local model,
`sumo scribe status` shows the server's pid, port and the model's load state. `sumo setup` stops it
so a new model file or binary takes effect. Logs go to `~/.sumo-agents/logs/llama-server.log`.

```sh
sumo config model.repo <org>/<repo>   # another GGUF repository
sumo config model.file <name>.gguf    # file within it, then run: sumo setup
sumo config scribe.model haiku        # write memory with an API model that is on (or `off`); same for dream.model
```

**Fallback.** If a local call fails (server down, input past 32k, answer cut off or unreadable) and a credential
is set, the pass retries once on the cheapest API model that is on (Haiku unless you turned it off). Both calls
are logged, the failed one noting the retry, in `~/.sumo-agents/logs/scribe.log`; `sumo scribe stats` totals
runs per kind.

### How it was chosen

Measured on an M5 Pro (48 GB) on 2026-10-04 with the repo's scope probe: 30 labelled turns over six
conversations, 16 worth remembering and 14 throwaway. It checks whether the writer keeps the right things,
scopes each to the right project, quotes what was typed as proof, and files no noise.

| Writer | Remembered | Right scope | Quoted | Noise filed | Per call | Resident |
|---|---|---|---|---|---|---|
| **Qwen3-4B, thinking capped at 1,024 (default)** | 16/16 | 16/16 | 16/16 | 0 | 8–15 s | ~7 GB awake |
| Haiku 4.5, via API | 16/16 | 16/16 | 16/16 | 0 | 8–22 s, $0.088 for six | — |
| Qwen3.5-4B, thinking capped | 16/16 | 15/16 | 16/16 | 0 | 8–13 s | 3.7 GB |
| Qwen3.5-9B, thinking capped | 15/16 | 14/15 | 15/15 | 0 | 26–29 s | 6.4 GB |
| Qwen3.5-9B, thinking uncapped | hit the token limit on every call | | | | 137 s | |
| Qwen3-4B, no thinking | 14/16 | 12/14 | 14/14 | 4 | 1–5 s | |
| Qwen3.5-4B, no thinking | 14/16 | 11/14 | 14/14 | 2 | 1–4 s | |
| Qwen3.5-9B, no thinking | 14/16 | 10/14 | 14/14 | 0 | 2–7 s | |
| Gemma 4 E4B, no thinking | 14/16 | 13/14 | 14/14 | 0 | 2–5 s | 5.3 GB |

- **Thinking closes the gap to Haiku; the cap makes it safe.** Uncapped, the 9B thought until the token limit
  every time, and the 4B did once on a trivial prompt.
- **Qwen3-4B also routes best.** On the router's grading set at the time (12 tasks, three histories) it got
  11/12 on each; Qwen3.5-4B got 9, 9 and 11.
- **Bigger models don't fit.** Qwen3.6-35B-A3B and Nemotron 3 Nano 30B are 22–25 GB, too much to keep
  resident on a working laptop.

**Caveats:** probe bundles are ~750 tokens, while real scribe bundles are 4,800 (median) to 9,400 (p90) tokens
and include assistant replies and related memories, so real accuracy may be lower. Every number is a single run
on a set written by the author; the local models ran at temperature 0, Haiku at the API default.

## Costs

| Item | Cost |
|---|---|
| Scribe or dream pass | $0, 8–15 s in the background, no credential. (Before the switch, 224 Haiku scribe calls cost $1.86 and 18 dream calls $0.17.) |
| Router | $0, ~1 s per job once loaded |
| Local server | ~7 GB RAM while answering, < 0.5 GB asleep |
| Web search | $0.01 + tokens; a page fetch is tokens only |
| Always-loaded prompt (`AGENTS.md`) | ~650 tokens, held there by a test |

---

## Development

```sh
npm test                                                           # offline suite, recorded answers, no real model calls
node probes/scope-accuracy.mjs                                     # live: local memory writer on 30 turns, $0, ~90 s
node probes/scope-accuracy.mjs haiku                               # same turns on Haiku, ~9 cents
node --disable-warning=ExperimentalWarning test/router-probes.mjs  # live: the router's grading set
node --disable-warning=ExperimentalWarning probes/coding-eval.mjs  # live: eight small jobs, scored on what they never saw
```

### The coding eval

The offline suite can't tell whether a change to the loop, prompts, tools or router makes jobs come out right
more often or cheaper. `probes/coding-eval.mjs` runs eight small real jobs (six worker, two scout). Each is a
one-page project written fresh, handed over as a brief, and scored on what the job never saw: hidden tests, files
it was told not to touch, a test it was asked to add, and for scouts the answer lines the report must give.

Each task has a tempting wrong answer that looks done: `quantity || 1` passes the given test but treats 0 as 1;
a bug whose tests already pass can be left under a `DONE`; the test can be edited to match the code.

```sh
node --disable-warning=ExperimentalWarning probes/coding-eval.mjs --list
node --disable-warning=ExperimentalWarning probes/coding-eval.mjs                         # routed by the router
node --disable-warning=ExperimentalWarning probes/coding-eval.mjs --route sonnet/medium   # pin the route: only the harness varies
node --disable-warning=ExperimentalWarning probes/coding-eval.mjs --task cart-quantity --runs 3 --json before.json
```

Each job prints `PASS`, `FAIL` or `FALSE DONE` (said DONE but was wrong, counted separately since nobody
re-checks a DONE), with route, requests, time and cost, plus a total line. It needs a credential and the router
model, runs in its own home, and reads the real one only for the router model, the llama-server path and which
models are on. Run it before and after a
change, on a pinned route, more than once: eight tasks is a small sample.

The eval is itself tested (`test/coding-eval.test.mjs`): stand-in agents run the tasks through the real job
machinery, and the score must tell a correct agent (passes all eight) from a sloppy one (the lazy fix, the idle
DONE, the edited test, the report with an extra name).

## Repository layout

```
AGENTS.md              the chat's system prompt (its Coding section also goes to every job)
prompts/               agent.md (job system prompt) · scribe.md, dream.md (memory passes)
guides/                fix, feature, review (auto-loaded) · memory, projects, workflows, delegation (read on demand)
bin/sumo.mjs           the `sumo` CLI entry point
spinner.txt, logo.txt  the working-line phrases and the empty-chat lion

src/
  cli.mjs              command parsing and dispatch
  setup.mjs            setup, doctor, config defaults, the model download
  catalog.mjs          the API models and their on/off switches
  auth.mjs             credentials and the API client

  chat.mjs             the chat · hooks.mjs session policy as events
  ui.mjs               the chat screen (Ink, loaded only by `sumo chat`) · editor.mjs the input box · tty.mjs markdown on the terminal
  loop.mjs             the agent loop every conversation runs in
  tools.mjs            the shell and editor, with their policy · guard.mjs the refused commands
  web.mjs              web search and fetch · mcp.mjs MCP servers, transports, allow list
  sessions.mjs         sessions, turns, context thresholds, saved state · transcript.mjs · images.mjs

  memory.mjs           the memory store · db.mjs SQLite schema and full-text search
  scribe.mjs           the writer pass · dream.mjs the consolidation pass · apply.mjs the only way a suggestion becomes a memory
  prime.mjs            the block a session starts with · recall.mjs searching memory before asking
  workflows.mjs        taught workflows and their gates · guides.mjs auto-loaded guides
  redact.mjs           secret scrubbing · page.mjs, page.html the `sumo memory` page · export.mjs

  projects.mjs         the project registry · scan.mjs, card.mjs what a project declares, as a card
  jobs.mjs             jobs · jobtools.mjs the tools a job gets · verify.mjs the checks behind DONE
  route.mjs            routing for jobs and `auto` chat turns, and per-route stats
  local-server.mjs     the llama-server behind the router and memory passes · model.mjs calls to it and the API
  herdr.mjs            a Herdr tab per job, to watch it work

test/                  offline suite (`*.test.mjs`), plus router-probes.mjs, the live router grading set
probes/                live measurements: memory scope, the coding eval (tasks in coding-eval-tasks.mjs)
docs/                  ADR-runtime.md (why Sumo owns its runtime) · PLAN.md (original design) · skills-plan.md
BRIEFING.md            the 2026-10-07 hardening briefing
```

Stack: Node, the Anthropic SDK, Ink, and SQLite full-text search (`node:sqlite`, FTS5).
