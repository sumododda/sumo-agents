# Changelog

What each release changed for you. The commit of each version has the full detail.

## Unreleased

- **The scorecard is written by a model, not by code that knows each vendor's spelling.** `/scorecard` has the
  strongest Claude model you have on, at its highest effort, search the web — CursorBench via Epoch AI, LMArena's
  agent board and the Artificial Analysis Intelligence Index first — and write each source's numbers for your models
  to `~/.sumo-agents/scorecard.json`. It decides which of a vendor's names is which of your models, so a model the
  old name matching missed (`claude-opus-4-6`, `cursor/glm-5p3`) is scored where a source lists it. Sumo checks every
  entry and refuses what it can't use, places the numbers on the same six-model ruler, and keeps the file saved before
  when a writing is stopped or fails. One writing may spend $5; Discover and `sumo setup` no longer touch the
  scorecard (Discover still fetches list prices). Run `/scorecard` once after upgrading: until then routing goes by
  its rule.
- **Cursor's models on a network that drops HTTP/2.** Cursor's agents now stream over HTTP/1.1 with server-sent events,
  not HTTP/2: on a VPN or proxy that refuses HTTP/2 in the TLS handshake, every Cursor chat, job and Discover try ended
  on a session error. The model list and the key exchange were HTTP/1.1 already.

## 0.8.1 — 2026-11-18

- **Every model your login and key can run, not two of Cursor's and four of Claude's.** Discover asks Anthropic for
  every model it lists (all pages) and Cursor for every model it has for `CURSOR_API_KEY`, and tries each once with a
  one-word question — eight at a time, a few seconds, a few cents — since neither list says what you may run: a Claude
  Code login is refused models that need a newer Claude Code, and a Cursor plan leaves most of its models out. A model
  that answers is switched on; one refused stays off with the reason the API gave. Claude's four keep their names; any
  other is its id (`claude-opus-4-8`), and Cursor's beyond `composer` and `grok` are `cursor/` and Cursor's id
  (`cursor/grok-4.6`). Each Cursor model is asked at its standard variant — never Fast or Max mode — with your effort in
  the setting it names; a Claude model that lacks an effort is asked at the nearest below. Models Sumo cannot drive
  (Claude's before Opus 4.6, a Cursor model only Max mode runs) are listed and off, saying why.
- **Sorted cheapest first, everywhere.** `sumo models`, the settings page, `/model` and the job ladder list models by
  their price per token: Sumo's own list, else the list price modelgrep publishes, now kept when the scorecard is
  fetched. A model with no price known runs only when picked by name — routing cannot weigh it, nor a budget hold it.
  `jobs.floor` takes any model on the ladder.
- **A model switched off leaves the scorecard and the router's rule.** `sumo models` and `/scorecard` show only the
  models that are on, routing weighs only them, and one switched on again is back from what was fetched. The local
  router is told a rule naming only models it may pick — with Fable off, "opus for hard and novel" — where it named all
  four whatever was off, and a backend without grammar support could answer one and fail the job.
- **Routing over the larger pool.** Places are read on one ruler, the six models Sumo names: any other model is placed
  where its score falls between theirs, so the dozens Discover adds — older and weaker ones among them — move no place
  and the bars stay where they were set. A benchmark source now scores a model under every name Sumo runs it by (Claude
  Opus 5.5 is `opus` and `cursor/claude-opus-5-5`). An effort the benchmarks give no cost for costs at most what the
  same model's next effort up does, and a route still without a price ranks after the priced ones — before, one
  unpriced route among the candidates switched every price off, and with more models that sent routine work to the
  lowest rung instead of the cheapest route. With every model one login ran on switched on, each kind and size of work
  gets the same route as with the six alone. The server-side fallback is asked only on Sonnet, Opus and Fable.

## 0.8.0 — 2026-11-18

- **Cursor's models, for chats and jobs.** With `CURSOR_API_KEY` exported, Discover asks Cursor too and switches on
  Composer 2.5 and Grok 4.7 when it lists them. They sit beside Claude's in `/model`, Chat › Model, the jobs' smallest
  model and auto, and run through the Cursor SDK (`@cursor/sdk`, a new dependency) at their standard variants, never
  Fast. Cursor runs the loop; Sumo's own tools — the shell, the editor, the job's tools, the MCP servers — answer it
  through the same approvals, guard and sandbox as on Claude, with `/undo` keeping what the editor changed. Of Cursor's
  own tools it keeps only web search and fetch, and only where Claude has them — the chat and scouts; its file and shell
  tools are given no disk, and its agents live in a folder of Sumo's own, so nothing of the SDK runs git or a program
  from your PATH in your project. A Cursor job gets the same warnings near its budget and time, and the same stops for
  a repeated call, a loop or declined calls, as one on Claude; what you tell a running job reaches it; and nothing a
  run started outlives it. Its web search is unseen, so a conversation or scout that has it is taken to have read the
  web. Each request is priced at Cursor's list rates in the ledger. The key is kept from the model's shell and
  redacted wherever it would be written, and `.cursor` joins the guarded files.
- **Claude and Cursor in one conversation.** `/model` and auto move a chat between the two at any turn. What a turn on
  Cursor did joins the conversation as it would on Claude — each call and what came back, then the reply — so Claude
  knows what was done and read; a turn back on Cursor is told what was said since, in words, by the same Cursor agent,
  also after the chat moves into a project; an agent Cursor no longer has is replaced by a new one told the whole
  conversation. Pictures you paste go to Cursor too. A `/handoff` from Cursor is written by
  Sonnet. In a shell without `CURSOR_API_KEY` Cursor's models are not offered or routed to, and asking for one says why.
- **Routing reads published benchmarks, not a rule.** Discover, and the first `sumo setup`, fetch three benchmarks
  once and save them: CursorBench as Epoch AI collects it, LMArena's agent board and Artificial Analysis's
  Intelligence Index via modelgrep. No key is needed and no model reads them. Each is turned into a place among
  Sumo's models before anything is averaged. The local router now only sorts the work; code picks the cheapest model
  and effort whose score clears the bar for it, at the effort the work's size asks for, over Claude's and Cursor's
  models alike. Harder, larger or risky work never gets a lower-scoring route than easier work of the same kind, and a
  retry climbs to a route that scores above the one that failed. `sumo models` shows the scores, and every route says
  why it was picked. `/scorecard` in the chat fetches them again and shows each step: every request with its status,
  size and time, the rows kept and left out, and where each source placed the models. Without a scorecard the router
  chooses Claude's models by the old rule.
- **A route is priced by what your jobs cost.** Neither API gives a cost back here, so routing reads the ledger: a
  route's own average over its finished jobs of the same kind, else the benchmarks' cost of a task scaled to the size
  of your jobs, else your typical job at the model's list prices. A job that failed before anything was billed is not
  a price, and prices of different kinds are never compared. On today's benchmarks Claude's models win every kind of
  work on score and price; Cursor's are picked once your own jobs show them cheaper.
- **The editor cannot be raced into writing elsewhere.** A file swapped for a link while the editor worked on it could
  have its change written through the link — into `.git/config`, say, which git then runs outside the sandbox — and the
  record `/undo` keeps could be pointed there the same way. Where a change lands is now decided once, at the checks,
  the file is read and written through that one descriptor, and `/undo` keeps the file that was written. A hard link
  reached through a link is asked about as the hard link is, and a FIFO or device is refused at once instead of
  freezing the chat.
- **Sumo's home is no longer the sandboxed shell's to write.** The shell could plant what Sumo later trusts there: an
  `/undo` record that your next `/undo` would write into `.git/config`, a saved session `/resume` would load as your
  words, a memory-pass lock that stopped filing without a word, a backup, the record that a job read the web. Now the
  shell writes the project (or scratch) and the temporary folders, never Sumo's home, and its logs, backups and
  history are kept from it even where the home sits in a writable place. A saved session is picked up only when the
  journal knows it, and a job's outside reads are kept in the database.
- **What the sandboxed shell may not write, it may not create either.** A guarded file that did not exist yet —
  `.envrc`, `.claude/settings.json`, `.npmrc` and the rest — could be created by the shell, also through a link inside
  the project. Now each is guarded by its path whether it exists or not, and by where it lands. A repository's config
  and hooks are git's to run later outside the sandbox — your prompt's `git status`, an editor — so the shell makes
  none: not a nested repository, not one in a project that has none (`git init`, which a template can fill); it is a
  question for you, or a refusal where nobody can be asked. Sumo's own git never runs an fsmonitor, a hook or a submodule's
  config, wherever they came from. The log of a command left in the background is made new in the temporary folder,
  never through a link planted at its name, which would have had Sumo append the command's output wherever it led.
- **Sumo's own credentials stay out of everything written.** Each is redacted by its value, whatever its shape, and an
  MCP server's `${NAME}` can no longer name one.
- **A new failure in an already-red suite is found, whatever the runner.** Failures are now named with their file or
  package, pytest's `ERROR` lines and go's build failures are read, and the runner's own counts must be accounted for
  by the names, or the worker stays open for you. `cargo test --no-fail-fast` runs every target, and vitest's timings
  no longer make a test look new. A DONE that cannot be checked here is asked about, not finished FAILED and retried.
  A broken link or an editable install pointing outside the project no longer makes a worktree look shared.
- **`/undo` never gets stuck.** A file rewritten in place by `sed -i`, a formatter or an editor's safe save blocked
  every undo for good. Files are now compared by what they hold; a turn whose file you changed since is refused once,
  and the next `/undo` lets it go and keeps your file, so earlier turns can still be undone.
- **Memory keeps what it should and says when it stops.** A statement a rebuild let go can be filed again; only your
  letting go keeps it out. Rewording memories on the page no longer pauses filing, and a pause is said in the block.
  A lock left by a pass that ended is taken over, `sumo memory run` exits 1 when another pass holds it, and the check
  fails on one held over half an hour. Every call to a hosted model is in the ledger, and a rebuild from the model's
  shell reads only the newest few conversations, never on a hosted model. A line a hook sets aside while the spool is
  read is never lost. In a turn of three lines or more only the first and last line are quoted as yours. A database
  that cannot be copied aside first is not migrated.
- **The settings page.** A new local model is downloaded before the setting changes, so the old one keeps working
  meanwhile and a failed download changes nothing; `sumo config` waits for a download and says how it went. A change
  of effort or model moves only that part of the chat's route. A server's tools changed elsewhere are said, never a
  crash. A plain variable such as `LOG_LEVEL=info` is taken as it is. The cursor shows under `NO_COLOR`. `sumo doctor`
  stops failing on an `mcp.json` you have removed.
- **A release is published by you, not by a merge.** Changes reach `main` only through a pull request, and merging one
  only runs the suite. A version reaches
  npm when you publish a GitHub Release tagged `v` and the version in package.json, on a commit on main: the suite runs
  again on that commit, and the publish waits for your approval in the `release` environment. A prerelease goes to
  npm's `next` tag, and carries a version like 0.9.0-rc.1.
- **Smaller.** A session started inside a project is told, in its first block, that it works there: told only the list
  and where work with no project goes, a model once put a file for the project in scratch. `/context` counts turns and calls on every model, piped too. The editor's answer to a call without a
  command names the commands it has. Output a check prints in a shape made to make a pattern backtrack is read at once.
  The suite waits by the clock, not by a count of naps, so it no longer fails on a loaded machine, CI's or across
  midnight UTC.

## 0.7.2 — 2026-11-18

- **A new failure can no longer hide in a suite that was already red.** A check failing when a worker began, and
  still failing at the end, was let through whatever else had started failing. Now the failing tests are named
  from the output at baseline and at the end. A test that fails now but did not then refuses DONE. When the
  names can't be read from the output, the worker stays open with both logs kept, for you to look at and
  accept with `sumo job finish <id> --status DONE --accept "<why>"`.
- **No check run is no longer a pass.** A worker in a project with no check, test, lint or typecheck command
  could say DONE with nothing run. Now it stays open until you accept it with `--accept`. That includes a
  chore in scratch. An accepted attempt is never the one picked from several.
- **`/undo` never throws away an edit you made after it.** It deleted a file the editor had created even after
  you had written to it. Now every file of the turn is checked against what the editor last wrote before any
  file is touched. A file changed since keeps the whole turn and names the file. An undo cut off halfway picks
  up where it stopped.
- **Secrets the model repeats stay out of files.** A key the model echoed in its reply was written raw to the
  session's transcript. Replies are now redacted there. A saved session is redacted all the way down, web
  results and tool results inside other blocks included, and keeps no thinking.
- **A worker's change is kept whole before its worktree goes.** If `changes.diff` could not be written, the tree
  was removed anyway, and a binary file came through as "files differ". Now `change.patch` is written beside it,
  applicable with `git apply`, binary files included. If either can't be written, the worktree stays.
- **A worker in a worktree is tested on its own code.** A workspace package or editable install linked in from the
  project loads the project's copy, so a check could pass on code the worker never changed. Such links are now
  found (npm, pnpm and Python editable installs). Baseline and verify say which to install in the worktree.
- **Chat's "edited, nothing checked" is cleared only by a check that ran and passed.** Typing the check's name
  into any command cleared it, before it ran, and in a project with no checks any command did. Now it takes
  the project's own check, run whole without error. In a project with none, it takes a test runner run on
  its own. Files changed by the shell in a git project count too.
- **A job stops at its time limit, even mid-request.** The limit was checked only between requests, so a slow
  request, retry or tool could run on past it. The request in flight is now cut off at the deadline, and no tool
  starts after it.
- **The test suite is green whatever your terminal says.** Two screen tests failed under `NO_COLOR=1`.
- **`probes/paired-eval.mjs` runs the coding eval through other harnesses.** It runs native sumo, Claude Code and
  sumo-harness on the same commit with the same brief and the same hidden tests. The route is pinned and the
  budget split per run. It reports verified DONE, false DONE, time and cost per verified task. Tested offline
  with stand-in CLIs; no paid run has been made.

## 0.7.1 — 2026-11-18

- **A job's Herdr tab closes when the job is over, however it ended.** Before, only a job that ended done closed
  its tab: one that failed, was stopped or had its chat closed left a tab with an empty prompt, and a tab whose
  watcher never started was never closed at all. The chat that opened the tab now closes it at the end of every
  run; if the chat crashes, the tab's watcher notices within seconds and closes it itself.
- **The watcher is typed into its tab once, and checked through Herdr.** It counts as started once Herdr shows its
  report on the pane. It is typed again only when the shell is back at a bare prompt, never into a watcher that
  is still starting, where the line would reach the job as a message. A run over before the shell is ready has
  its tab closed with nothing typed.
- **Code copies clean.** A code block was drawn six columns in, inside a `┌─`/`└─` frame, and a long line was
  broken in two to fit the window, so a copied command came with spaces before every line and could paste as two
  commands. Code is now drawn from the first column with no frame, and a long line is left whole for the terminal
  to wrap: select it, copy it, and it is the code as written. The model puts commands to run and drafts to send
  in code blocks. `/copy` still takes a whole reply as written.
- **The test suite no longer opens tabs in your Herdr.** Run inside Herdr, it opened a real tab for each job it
  delegated, watching a home deleted a moment later.

## 0.7.0 — 2026-11-18

- **A new effort after a turn that failed no longer breaks the chat.** When a turn ended before the model answered
  (an error, or Esc), and the effort then changed (`/model opus high`, or auto picking a new one), every later
  message was refused: `400 … role 'system' must precede an 'assistant' message`, until `/new`. The note sumo had
  left for the model is now turned into plain text first, and a session saved in that state is mended when you
  pick it up again.

### Memory, rebuilt in layers
- **Everything said is kept, and found.** Each thing you say and each final answer goes whole into a journal on
  this machine (up to 64,000 characters, secrets redacted). `sumo search` is one search: memories first (`m12`),
  then the conversations (`t481` you said, `r3` sumo said), each line with its date; every word is looked for
  first, any word only when nothing holds them all, and a match on one stray word is called loose. `sumo show
  t481` opens a turn or a reply whole. `--turns` takes `--since` and `--before` now.
- **No guesses.** The memory pass reads a conversation once, when it is over, and files only what it finds in
  your exact words in the turn it names; anything else is dropped and counted. The guesses still waiting were
  rejected once, history kept. Two things are still held for you to confirm: what a conversation learned from
  the web or an MCP server, and what the model saved from its shell that you never typed — both asked in the
  session's block, each in words that say why.
- **A failure is loud.** A hook that cannot write keeps the event in a spool and replays it. A pass is written
  down before it runs: three failed passes, or most of what was filed thrown out, pause filing and say so; a
  turn that fails three times alone is set aside and the rest are filed. `sumo memory check` tests the search
  indexes, the backup, the spool and that the newest turn is found; `sumo doctor` carries those checks.
- **Not heard is said — silence is not.** When sumo commands are run from Claude Code and no turn arrives from
  it (its hook lines are gone), `sumo memory status`, `sumo memory check` and `sumo doctor` fail, the block
  says so in one line, and the command itself says it once a day. Being away, however long, is never a
  failure. `sumo help hooks` prints the lines to add. A session cleared with `/clear` gets its project cards
  again.
- **Derived memory can be rebuilt and measured.** What the pass drew from the journal is marked with the
  extractor that drew it; `sumo memory rebuild --dry-run` shows what today's extractor would add and no longer
  file, and never touches what you said to remember, confirmed or pinned. `sumo memory eval` runs the searches
  that once found nothing again and replays the extractor on your own history. Every change to a memory is
  logged with who made it and in which pass.
- **Changed for scripts:** `sumo search --json` gives `{memories, conversations, more, moreConversations,
  elsewhere, loose}`; a turn the user stops no longer starts a memory pass; the tidy runs weekly, no longer
  after three conversations; `sumo memory status` exits 1 when Claude Code is in use and not heard.
- Every setting is on one page: `/config` in the chat, or `sumo config` at a terminal. The arrows change a setting and
  it is saved as it changes; Esc closes the page and says what changed. Turning the sandbox off, and removing an MCP
  server, ask first.
- No config file: MCP servers and their allow lists live in the database. An old `mcp.json` is moved in once and renamed
  `mcp.json.imported`; one that would not read is left where it is, and `sumo doctor` says so.
- On the page you add an MCP server by pasting its command or address, or bring one in from Claude Code's list. A token
  typed in is refused: a header or variable names it as `${NAME}`.
- Retired, each pointing at the page (exit 2): `sumo config <key> <value>`, `sumo models enable|disable|discover`,
  `sumo mcp add|remove|allow|revoke`, `sumo setup --model-source`. Setup no longer asks where to get the local model;
  a new address set on the page is downloaded as it is set. `sumo config` piped, with a key, or with `--json` still prints.
- A file is judged and read through one descriptor — the editor, the project scan, a job's checks and its review, the
  spool, the crash note — so a file swapped between the look and the read is never the one read. A named pipe among a
  job's new files no longer stalls its review, and a comment closed HTML's other way (`--!>`) is seen as one. The
  Anthropic SDK is 1.8.0.
- **Node 24.6 or newer is needed.** Node 22 is no longer supported or tested; `sumo doctor` says so on it.

## 0.6.1 — 2026-11-11

0.6.0 was never published: its build typed `[I` and `[O` into the box when you switched tabs. 0.6.1 is it, fixed.

### The chat screen from 0.4.0, back and tidied (Nov 11)
- **The look you had before the ledger.** The name in sunset block letters, each step as `⏺ Bash(npm test)` with
  what came back under `⎿`, your messages behind an orange bar, a rounded box to type in, a question to approve in
  a yellow frame, the sunset flowing through the working line. The ledger of 0.5.0 is gone.
- **A failed run shows why it failed:** the lines that say what failed (a test's `✖`, an assertion, an error — never
  a passing test whose name says "error") come first, then its last two lines (the exit code, why it was stopped,
  what you said declining it), the rest counted. Before, its banner and its counts were shown and the failing test
  folded away. Six lines or fewer still show whole.
- **A test run that passed is one row:** `✓ 14 passed` (node, TAP, jest/vitest, pytest, cargo, mocha), not seven
  rows of `ℹ tests / pass / fail` — only for a command that runs tests, and never when its count has a failure in
  it (a run piped to `tail` exits 0 all the same). A grep's output still shows whole.
- **The header's second row names the project and its branch** — `shop-api (main) · ~/code/shop-api` — before the
  folder.
- **No stray rows:** a blank line at the end of a reply is the row before what follows, never two blank rows; `+3`
  not `+3 −0`; which guide rode in with your message is in the pager, not under your words; the empty box says
  `Ask anything` and the keys stay in the row under it.
- **The question box is laid out:** why it asks, faint, under the question; what would run set in; each key bold.
  In a short window it gives up the blank rows around what would run before anything else, and a menu half-typed in
  the box steps aside while it waits.
- **Switching tabs no longer types `[I` and `[O` into the box.** The terminal's word that its window came to the front
  or went behind is taken out before the keys are read, even when it arrives in two pieces — which made it the Esc key
  (stopping a turn) and the rest text in the box. On a terminal with the kitty keyboard protocol (Ghostty, kitty,
  WezTerm) a bare ESC waits for the rest; elsewhere Esc acts at once, as before.
- Kept from 0.5.0: a question never wipes the screen or your scrollback, Ink 8, the pager folding long lines, a
  failed call marked `✗` in a job's record.
  The flowing sunset writes more than the ledger's spinner did (34.5 KB against 9.2 KB over 5 s of work at 100×34);
  `chat.screen still` keeps it still (2.0 KB).

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
