# Changelog

What each release changed for you. The commit of each version has the full detail.

## 0.5.0 — 2026-10-28

Newest first:

### The chat screen in its own look (Oct 28)
- **A ledger, not a copy.** Every row of the conversation is named on its left edge in a word — `you`, `sumo`,
  `read`, `edit`, `write`, `run`, `search`, `mcp`, `job`, `report`, `ask`, `error` — and its words start in one
  column. A column beside the name holds the row's state: `✗` failed, `•` at work, `?` waiting on you, `›` picked.
  The marks borrowed from other tools (`⏺`, `⎿`, `✻`, `Bash(…)`, `Update(…)`, a rounded box) are gone.
- **One colour of its own:** the terminal's cyan, so your theme decides the shade, light or dark. Yellow still asks,
  red fails; everything secondary is faint. Jobs no longer cycle through five colours: their id says who they are.
- **Lighter.** The header is one row (no block letters); the box you type in is your own row under a faint rule,
  where the message will stand once sent; a question to approve is a yellow `ask` row with a bar beside all it
  covers, not a box. The working line turns a one-cell spinner instead of running a gradient through its words.
- **Cheaper to draw**, measured in a real terminal at 100x34 over the same 50 steps: 48% fewer bytes written in
  all (473 KB to 250 KB) — a running command 17 KB instead of 49 KB, a streamed reply 12 KB instead of 22 KB, an
  edit 4.5 KB instead of 7.7 KB, the empty window 4.0 KB instead of 5.4 KB. A keystroke is still about 200 bytes.
- **A question never wipes your scrollback.** A question to approve that is taller than the window — a long command,
  a narrow window — used to make the screen and the terminal's scrollback be wiped and the whole conversation drawn
  again. It now takes the rows the window has left: what would run is shown as far as they go and the rest is
  counted (`… N more characters not shown — n, and ask the model for less`), with its keys always on the screen. The
  call waiting under it is one row while it waits, since the question shows it whole. Checked at 40, 60 and 80
  columns over 282 steps in a real terminal: nothing but Ctrl-L clears the screen.
- 24 more phrases for the working line in `spinner.txt`, a few from the ring and the savanna (111 in all).
- The pager (Ctrl-O), `sumo job watch` and a job's open record use the same ledger; the pager folds a long line
  under its own words at the window's width instead of leaving it to come back at the edge. An error no longer says
  "error" twice; the keys in a question are bold; the cap on a long question reads whole at 80 columns.

### What the audits left, finished (Oct 28)
- **`sumo uninstall`**: shows what it will remove and asks you to type `uninstall` (`--yes` in a script). It copies
  your memory out beside the home first (`--discard-memory` skips it), stops the local model's server, removes the
  `sumo` links that run this home and what setup made there — anything of yours is left and named — and refuses a
  home that is your home folder or above it.
- **Exit codes a script can act on**: 0 done, 1 not done (not there, not in a state for it, not the asker's to do) or
  failed, 2 the command line was wrong, 4 an Anthropic credential is needed. `sumo help` says so.
- At a terminal `sumo prime` and `sumo project show` read as text, without the tags written for the model; piped,
  they are unchanged. An open job is said as it is: `not started`, `running`, or `stopped`. A forgotten memory is
  `forgotten`, not `invalid`; adding a registered project with another `--slug` says the name is kept.
- **The chat screen, finished.** A question says it waits once, in its panel, with its keys at full weight and one
  wording for Esc. An error is marked `✗`, wraps under its own words with the API's reason faint beneath, and an
  unknown 400 is said in words; a "prompt is too long" or `max_tokens` refusal is no longer called a credential
  problem. What is merely not there yet is a note, not red. Files are named from the project, one spelling each.
  `/help` is one line a command (31 rows at 80x24, from 90); commands say what they do for you, `/model` reads like
  the status line and Tab marks the current model; the line still arriving shows no half-made markdown; the empty
  window never clips the logo and suggests what to try; the box stays at the foot after a command answered with a note.
- `sumo export | head` no longer ends in a stack trace when macOS reports the closed pipe as ENOTCONN.
- **Memory asks you only what is real.** The local model names a pair of memories by number and sometimes names the
  wrong one — a turn read as a memory, a memory it was never shown. A pair it names is now judged on its own before
  anything is put to you; one judged unrelated is dropped and never asked again. The memory probe: 6 of 6 scenarios
  every run, and no notice that ties an unrelated pair (from up to 3 a run).
- Search finds Japanese, Chinese and Korean words inside a longer run of text, in memories and in what you typed;
  other languages search exactly as before.

### Two independent audits, fixed (Oct 28)
- **The chat screen, checked in a real terminal.** A reply whose stream broke and was asked again is drawn once, not
  glued to every failed try; a live area that grows past the foot of the window no longer leaves a stale copy behind;
  the API's own retries are counted on the working line instead of waited on silently, and said once in the scroll.
- Saying no to a command or a change shows one line — what was declined, and your words — not the paths and the
  instructions the model is given; a run outside the sandbox is asked with what the sandbox refused; one very long
  line of output is cut to a few rows.
- Plain mode (`chat.screen plain`) is for a screen reader: no logo, no ticking clock, tables read as records and code
  blocks named in words. With `NO_COLOR` the cursor in the box is still drawn, in reverse video.
- A wrong key on a question explains every key inside its panel; the model's question is asked once; an edit is headed
  in words, not `str_replace`; a declined reply leaves no half sentence; at 80 columns the working line keeps "esc to
  interrupt"; `/new` starts on a clean window; a folder that is not a project says the tools work in scratch, and how
  to make it one; `/` and `@` menus come back once a recalled message is changed.
- **Nothing lost unasked.** `sumo forget <id> --purge` shows the memory and asks you to type its id; `sumo backup
  restore` over a database that is fine says what each side holds and asks first. With no terminal, both need `--yes`.
- A purge now reaches every copy on the machine: the weekly backups, the copies made before an upgrade, and a database
  a restore set aside. A restore over a working database keeps it as `memory.db.replaced-<time>`, not "damaged".
- `sumo setup` under a second home never takes over the `sumo` command of a home that is still there.
- Your own rule quoted whole ("slate uses pnpm, never npm") is filed as yours, not held as if you had said it the
  other way round; a correction written as "uses bun, not pnpm" is too. A clash pairing the wrong memory, and a
  one-off request guessed as a workflow, are dropped instead of put to you. The memory probe judges a sixth scenario —
  your words are never held as a guess — and holds all six, every run of three.
- **The command line reads like one tool.** `sumo help` fits 100 columns and ends with the docs and how to report a
  bug; `sumo help <command>` gives that command's every option, explained. `--days=7` and `-n5` work, a misspelt flag
  is answered with the one it meant, and words a command would not use are refused instead of dropped
  (`forget m1 m2` no longer forgets m1 alone). Search says how many more matched than it shows.
- `--json` on `search`, `show`, `project list` and `job list`: one object, its lists named.
- `job watch` on a job nobody started says how to start it instead of waiting for ever; the memory page with no
  terminal says it needs one; `sumo mcp` refuses a token given in the clear and a non-web address, says it is
  connecting, and exits 1 when every server failed. Job ids read `j1` everywhere, empty lists say what is true, and a
  memory you type at a terminal is written by you.
- Ctrl-C during `sumo mcp` takes the server it started down with it. `FORCE_COLOR` turns colour on for sumo's own
  lines too, piped included. A home that is a file, or one sumo may not write, is said as that with the next step —
  doctor reports it as one line instead of crashing — and doctor names `sumo doctor --fix` where that is the fix.
  Turning `shell.sandbox` off says plainly what it means.

### Releases and CI locked down (Oct 28)
- A publish waits for the maintainer's approval in a `release` environment open only to `main`, and goes to npm by
  trusted publishing with provenance: no npm token exists to steal.
- Every action is pinned to a commit, no job holds a permission it does not use, no dependency's install script
  runs in CI, and the registry's signatures are checked. CodeQL scans the code and the workflows; Dependabot
  proposes updates a week after they appear. [SECURITY.md](SECURITY.md#releases-and-the-supply-chain) has the table.

### The screen, memory and neat code (Oct 28)
- The chat redraws only the line that changed: a keystroke writes about 200 bytes instead of the whole window, a
  question waiting holds still, and full-width boxes keep their right edge in every terminal.
- A rule you say again in other words ("short answers" / "brief replies") is always raised for you to settle.
- The suite fails on an unused import or an export nothing uses, and on a fast command loading the heavy modules.
- `sumo config` has 15 settings, down from 22. `chat.screen` (`full`, `still`, `plain`) replaces `chat.motion` and
  `chat.plain`; `model.url`, the model file's whole address, replaces `model.source`, `model.repo` and `model.file`;
  `prime.budget`, `scratch.days`, `jobs.escalate` and `guides.auto` are fixed now. What you had set carries over,
  and an old name says what it became.

### Claude Code login and CI (Oct 28)
- On a Claude Code login, refusals fall back to another model and `/model` effort changes keep the cache, as on an
  API key (checked live with `probes/oauth-features.mjs`).
- CI runs the suite on macOS, the platform sumo runs on, with Node 22 and 24, before a version is published.

### Security, speed and polish (Oct 28)
- **Security:** sumo's own memory, settings and MCP servers are out of the shell's reach. Before, one injected
  command could switch the sandbox off, plant a memory in your name or register an MCP server allowed to run
  anything. A plain `sumo …` command from the model runs as sumo, where what only you control is refused.
- A project is one folder of work: never `/`, your home or above it. More guarded files: git's own config, login
  items, editor and shell setup, every folder on your PATH; hard links are asked about each time.
- MCP refuses redirects; a trap learned from a web page or MCP server waits for you, and only you confirm it.
- Every command starts about 45% faster (`sumo hook prompt` 115 → 62 ms).
- The screen and the commands read as one product: reads by file name, hints that fit, plain wording in
  `sumo cost`, `sumo memory status` and `sumo doctor`, `sumo config` sorted with did-you-mean.

### One memory pass (Oct 28)
- **One memory pass** instead of a writer and a tidier: `sumo memory run | status | show`, one `memory.model`
  setting. It files what you say and tidies itself when conversations finish or a week passes.
- Tidying raises memories that say one thing or disagree, fills in search terms, and keeps project facts fresh.
  Guesses are asked only where they belong; unused traps an agent filed are let go after 45 days.
- One-off requests ("make the button blue") are not filed as rules; a rule with a condition still is.
- `probes/memory-quality.mjs` measures it: 3 of 5 scenarios held before these changes, all five after.

### Edits outside the project, the SDK, jobs and doctor (Oct 27)
- The editor asks before changing a file outside the project — once, the file or its folder for the session, or
  no with your reason — instead of refusing. Files read later (shell rc files, `.envrc`, credentials) are guarded.
- `@anthropic-ai/sdk` 1.3; Haiku is Haiku 5.5, about ten times cheaper; Sonnet 5.5 cache reads priced right.
- `/handoff`; jobs compact and go on when a prompt grows too long; a worker's first DONE is answered with a
  numbered checklist; the model is told which files a command changed.
- `sumo --version`, crash files, `sumo doctor --fix | --report`, a database copy before each migration.
- Slack and other app-login MCP servers through Claude Code's login (`--from-claude`).

## 0.4.0 — 2026-10-26
- The chat screen, tested by driving a real terminal: every row inside the window at any width, nothing drawn
  raw, a job told in place under the call that started it, `/context`, `/export`, `/thinking`, `/copy`, `/clear`.
- `jobs.floor`: the smallest model a job may run on.

## 0.3.0 — 2026-10-26
- The model's shell runs in a macOS sandbox; worktrees for a second worker; cheaper context (tool output cleared
  later, in larger pieces); budgets for jobs and the chat; `sumo cost` with cache rewrites; checked work (the
  first DONE answered, flaky checks run again); the coding eval with `--hard`.

## 0.2.0 — 2026-10-13
- The chat asks before it builds, and memory keeps less that was never said.
