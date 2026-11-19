# sumo-agents

A coding agent you talk to from one place. It works across every project on your machine, remembers what
you tell it, and hands big work to background jobs that are checked before they can say they are done.

- **One chat for everything.** Mention a project by name; Sumo finds it on disk and works there.
- **Memory that lasts.** Your preferences, project rules and where you left off are kept locally and
  loaded into every new session. You never explain the same thing twice.
- **Background jobs.** Big, parallel or reading-heavy work goes to scout, worker and reviewer jobs. A
  local model sorts each one and code picks the cheapest model and effort that published benchmarks score high
  enough for it, so the dearest model is never the default.
- **Checked results.** A worker cannot report done until the project's own tests and linters agree.
- **Its own loop.** Sumo talks to the Anthropic API directly and owns its prompt, tools, context and cost. With a
  Cursor key, Cursor's models run chats and jobs too, on Sumo's tools.

Everything it learns lives in `~/.sumo-agents/` on each machine, never in a repository, so a work laptop
and a personal one learn separately.

## Install

You need Node 24.6+, [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`)
for the local model, and `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in
your environment. `CURSOR_API_KEY` is optional: it adds Cursor's models.

```sh
npm install -g sumo-agents
sumo setup      # creates ~/.sumo-agents and downloads the 2.5 GB local model (routes jobs, runs the memory pass)
sumo doctor     # every line should say ok
sumo chat
```

`npm update -g sumo-agents` moves to the newest release. Setup flags, corporate proxies and certificates
are covered in [Install](https://github.com/sumododda/sumo-agents/wiki/Install).

## Your first session

- Just talk. Name the project you mean; the first time, Sumo confirms its path and registers it. Started inside a
  registered project, the chat works there from the start.
- Say how you like things done. "Always run the linter before you commit" is remembered in your words and
  loaded next time. Nothing is kept as a guess: what cannot be found in your own words is not filed. What the
  model saved without your saying it, or learned while reading the web or an MCP server, is asked in sessions
  about that project, for two weeks; after that it waits on the memory page (`/memory`).
- Everything you say and every answer is kept whole in a journal on this machine, and `sumo search` looks in
  memories first, then in those conversations. Memory looks after itself, in one background pass on the local
  model: when a conversation is over it files what you stated, in your words; once a week it also goes over
  memory and raises two memories that say one thing, or cannot both be true, for you to settle. A project's
  facts are read again when its files change. A trap an agent filed that nobody was shown in 45 days is let go,
  history kept. `sumo memory status` says how it is doing, `sumo memory check` tests it, and `sumo memory run
  --tidy` tidies now. To have Claude Code heard too, `sumo help hooks` prints the lines to add to its settings.
- `/fix`, `/feature` and `/review` load a short written procedure for that kind of work. They also load on
  their own when your message asks for one.
- Big work is delegated without being asked. A row for the job appears under the box, you keep talking,
  and its report comes back into the conversation.
- `/new` starts a fresh session, and a new task deserves one. `/handoff` has the model write a hand-off of
  the piece in hand first, and the fresh session starts from it. `/resume` picks an old one up. `/help` lists
  the rest, and `?` on an empty box shows the keys you reach for most.
- Each step shows as `⏺ Bash(npm test)` with what came back under it: a failed run by the lines that say what
  failed, a test run that passed in one row (`✓ 14 passed`). Your messages stand behind a bar, a question to
  approve in a yellow frame. `chat.screen still` stops the colours flowing through the working line.
- Ctrl-R searches what you sent before. `/context` shows how full the context is, the session's turns and calls, and what it has cost.
  `/export` writes the conversation to a Markdown file.

## Good to know

- Destructive commands (`rm -rf ~`, `git reset --hard`, dropping a table) and commands that print secrets
  are refused in code before they run. `! <command>` runs one yourself.
- On macOS the agent's shell runs in a sandbox: it writes only in the project (or scratch), the temporary folders
  and the tool caches — never in Sumo's home, nor in git's hooks or config, nor a repository it makes (`git init`,
  or a nested one). A plain `sumo …` command it runs is run as Sumo itself, where what only you may change is refused. A write the
  sandbox blocks is put to you once to run outside it. Shell › Network, on the settings page, keeps it off the network.
- An MCP server that takes only a registered app's login, as Slack's official one does, is reached through
  Claude Code's: `claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp`, `claude mcp login slack`,
  then add it on the settings page with Claude Code's login, or bring it in from Claude Code's list there. Sumo
  borrows the token and never refreshes it.
  On macOS the token is read from the keychain: when macOS asks, choose Always Allow.
- The editor reads any file but changes only the project's. A change to one outside it — a config file in
  your home, say — is put to you with the change: once, or that file or its directory for the rest of the
  session, where the shell may then write too. The home itself is never opened that way. A file something
  else reads later — your shell's rc files, `.envrc`, `.npmrc`, `.vscode`, `.mcp.json` —
  is changed only when you say so, each time, under any spelling of its name; the sandboxed shell may not write
  one, nor create one that is not there yet.
- Any of these questions can be refused with your reason: `r`, type why, Enter. The model reads it as what to
  do instead. Questions from several jobs queue, and the one shown says how many wait behind it.
- The agent's shell gets your whole environment except Sumo's own credentials, Anthropic's and `CURSOR_API_KEY`,
  which are also redacted by their value wherever they would be written. It never waits on a prompt,
  stops a command silent for 2 minutes (`timeout 600 <cmd>` asks for longer), and runs a command ending in
  `&` in the background with its own log.
- A worker's first DONE is answered with its task as a numbered checklist beside its change, one answer per
  item; the second runs your checks.
  A failed first attempt is retried once on the next model up, and risky work is reviewed, without asking.
  A second worker on a git project works in a worktree of its own. If no check runs, or a failing suite’s results cannot be compared with its baseline, the worker stays open. After inspecting the logs, you can record a manual acceptance with `sumo job finish <id> --status DONE --accept "<reason>"` and the report on stdin.
- A job's run stops at $10 or 60 minutes (`jobs.budget`, `jobs.minutes`). `sumo cost` shows where the money went,
  and why the cache was written again when it was.
- `/undo` restores the last editor turn. A file changed since it was written, by you or a formatter, is named and the
  turn kept; `/undo` again lets that turn go, keeps your file, and goes on to the turn before.
- Only your words become memory. Web pages, files and tool output are never filed as yours.
- The local model, Qwen3-4B through llama.cpp, sorts jobs for routing and writes memory for $0 and sleeps when idle.
- Routing reads a scorecard of published benchmarks, fetched once by Discover and the first `sumo setup`, and saved: [CursorBench](https://cursor.com/cursorbench)
  as [Epoch AI](https://epoch.ai/benchmarks) collects it, [LMArena](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)'s
  agent board and [Artificial Analysis](https://artificialanalysis.ai)'s Intelligence Index via [modelgrep](https://modelgrep.com/api).
  The local model sorts the work; code picks the cheapest model and effort, Claude's or Cursor's, that scores high enough, at the
  effort the work's size asks for. Harder, larger or risky work never gets a lower-scoring route than easier work of its kind, and a
  retry climbs above the route that failed. A route is priced by what your own jobs of that kind cost, from the ledger, else by the
  benchmarks. `sumo models` shows the scores and every route says why; `/scorecard` in the chat fetches them again and shows each
  step: every request, what was kept, where each source placed the models. Without a scorecard the router picks Claude's models by its old rule.
- With `CURSOR_API_KEY` exported, Discover (on the settings page) switches on Cursor's Composer 2.5 and Grok 4.7: `/model composer`,
  Chat › Model, the jobs' smallest model and auto offer them beside Claude's. They run through the Cursor SDK at their standard
  variants, never Fast, on Sumo's own shell, editor, job tools and MCP servers, behind the same approvals and sandbox. Of Cursor's
  own tools only web search and fetch are kept, and only where Claude has them, in the chat and scouts; Sumo cannot see them, so
  a conversation or scout on Cursor counts as having read the web. Its agents live in a folder of Sumo's own, so nothing of the
  SDK runs git or a program from your PATH in your project. `/model` and auto move a chat between Claude and Cursor at any turn, each told what the other did. Each request
  is priced at Cursor's list rates. Without the key they are not offered, and asking for one says why.
- A crash is written, redacted, to `~/.sumo-agents/logs/crash-*.log`. `sumo doctor --report` prints everything a
  bug report needs, redacted, and sends nothing; the logs that hold what you said are counted there, not quoted.
  `sumo doctor --fix` makes the home's files private again.
- The database is copied beside itself before an upgrade migrates it (`memory.db.pre-v<N>.bak`, the last three),
  and is not migrated when the copy cannot be made; weekly it is copied into `~/.sumo-agents/backups`. A database that will not open is said with the newest copy:
  `sumo backup restore` puts it back (or `sumo backup restore <file>`), keeping the damaged one aside. Over a
  database that is fine, it says what would be lost and asks first (`--yes` in a script).
- `sumo forget <id> --purge` erases a memory for good, with the turn it came from and every turn and reply that says
  it whole (a phrase of five words or more), from every backup and set-aside copy and the spool too; it shows the
  memory, lists each turn and reply that will go, and asks you to type its id (`--yes` in a script). A conversation
  that only mentions part of it stays: `sumo search "<words>" --turns` finds it, and `sumo forget --purge t12` erases
  that one turn or reply (`r3`) the same way.
- `NO_COLOR=1` turns colour off everywhere, the chat screen included; the cursor in the box and the changed part of an
  edit stay in reverse video, which is not colour. `sumo version` (or `--version`) says which sumo this is; in the standalone binary only `sumo version` does, since Bun answers `--version` itself.

## Configuration

Every setting is on one page: `/config` in a chat, or `sumo config` at a terminal. The arrows change a setting and
it is saved as it changes; Esc closes the page and says what changed. There is no config file to edit: the settings,
the API models' switches and the MCP servers with their allow lists all live in Sumo's database (an `mcp.json` from an
earlier Sumo is moved in once and renamed `mcp.json.imported`). Turning the sandbox off, and removing a server, ask
first. Piped, with a key (`sumo config jobs.review`) or `--json`, `sumo config` prints the settings and changes nothing.

| Setting | Default | What it does |
|---|---|---|
| Chat › Spend notice (`chat.budget`) | `5` | Dollars a chat session costs before the screen says so; `0` never. |
| Chat › Effort (`chat.effort`) | `medium` | Effort when the chat model is fixed. |
| Chat › Model (`chat.model`) | `opus` | What the chat runs on. `auto` picks per turn, over Claude's and Cursor's models. Cursor's (`composer`, `grok`) need `CURSOR_API_KEY`. |
| Chat › Notify (`chat.notify`) | `on` | `off` stops the bell and the notification when a long turn ends behind another window. |
| Chat › Screen (`chat.screen`) | `full` | `still` keeps the working line's spinner still. `plain` draws the chat for a screen reader: words, not pictures (no logo), ASCII marks (`x` a failure, `*` at work, `>` your prompt), no rule over the box or bar beside a question, and nothing that moves or ticks. |
| Jobs › Advisor (`jobs.advisor`) | `off` | `on` lets a job ask the next model up for advice. |
| Jobs › Budget (`jobs.budget`) | `10` | Dollars one job may spend before it is stopped; `0` for no cap. |
| Jobs › Smallest model (`jobs.floor`) | `haiku` | The smallest model a job may run on, up the ladder `haiku`, `composer`, `grok`, `sonnet`, `opus`, `fable`: `sonnet` keeps every job off Haiku and Cursor's models, `opus` puts them all on Opus or Fable. |
| Jobs › Time limit (`jobs.minutes`) | `60` | Minutes one job may run before it is stopped; `0` for no limit. |
| Jobs › Review (`jobs.review`) | `risky` | Which verified work gets a reviewer without asking: `risky`, `all` or `off`. |
| Memory › Filed by (`memory.model`) | `local` | What the memory pass runs on: `local`, a model name, or `off` (the chat then saves what lasts itself). |
| Memory › Local model (`model.url`) | `https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf` | The local model's download address, a `.gguf` file — a mirror's too. Downloaded first: the model in use stays until it is here, and a failed download changes nothing. |
| Projects › New ones go in (`projects.home`) | `~` | Where new projects are created. |
| Shell › Network (`shell.network`) | `on` | `off` keeps the sandboxed shell to this machine. |
| Shell › Sandbox (`shell.sandbox`) | `on` | The agent's shell in the macOS sandbox. Read when a chat or job starts. |

Under them, **API models** has a switch for each model and **Discover**, which asks the API which this login can use,
asks Cursor too when `CURSOR_API_KEY` is set, and fetches the scorecard routing reads. Cursor's models start off;
Discover turns on the ones Cursor lists for the key.
**MCP servers** lists each server: Enter shows its tools, each switched to run without asking or to ask first;
**+ add a server** takes a pasted command or address, or brings servers in from Claude Code. A token is never typed
into the page: a header or variable names it as `${NAME}`, filled from your shell. The environment variables are in
[Install](https://github.com/sumododda/sumo-agents/wiki/Install#configuration).

## Uninstall

```sh
sumo uninstall              # shows what it will remove and asks; --yes in a script
npm uninstall -g sumo-agents
```

`sumo uninstall` copies your memory out first, beside `~/.sumo-agents` (after a reinstall,
`sumo backup restore <that file> --yes` puts it back; `--discard-memory` skips the copy). Then it stops the local
model's server, removes the `sumo` links on your PATH that run this sumo, and removes what `sumo setup` made in
`~/.sumo-agents` — anything else you put there is left, and named. It refuses a home that is your home folder or above.

Sumo writes nothing else: no shell profile, no other tool's settings. If you added `sumo hook` to a harness's hook
configuration yourself, remove those lines there. llama.cpp stays installed: `brew uninstall llama.cpp` if you want.

## Learn more

The [wiki](https://github.com/sumododda/sumo-agents/wiki) has the detail:

- [The chat](https://github.com/sumododda/sumo-agents/wiki/The-chat): commands, keys, the screen, sessions
- [Projects and memory](https://github.com/sumododda/sumo-agents/wiki/Projects-and-memory): cards, scratch, how memory is written and managed
- [Jobs](https://github.com/sumododda/sumo-agents/wiki/Jobs): delegation, routing, coding guides, verifying DONE, reviews
- [Web search and MCP](https://github.com/sumododda/sumo-agents/wiki/Web-search-and-MCP)
- [Safety](https://github.com/sumododda/sumo-agents/wiki/Safety): what is enforced by code and what is only asked
- [How it works](https://github.com/sumododda/sumo-agents/wiki/How-it-works): a turn, the local model, costs

What each release changed is in [CHANGELOG.md](CHANGELOG.md); what is enforced, its limits and how to report a
vulnerability are in [SECURITY.md](SECURITY.md).

## Development

```sh
git clone https://github.com/sumododda/sumo-agents.git ~/sumo-agents && cd ~/sumo-agents
npm ci
node bin/sumo.mjs setup    # points `sumo` at this clone instead of the package
npm test                   # offline suite, no real model calls
npm run build:bin          # optional: a standalone binary in dist/sumo-agents/ (needs Bun); move the folder whole
```

`node probes/coding-eval.mjs --route sonnet/medium` runs real jobs on small tasks and scores them with hidden
tests; `--hard` runs the harder set, `--no-guides` and `--advisor` change one thing at a time. It costs money.
`node probes/paired-eval.mjs --route sonnet/medium --budget-usd 2` runs the same tasks through sumo and Claude Code
for a side-by-side, within that total.

Changes reach `main` only through a pull request. Every pull request and merge runs the suite on macOS, the platform sumo runs on, with Node 24, and publishes nothing. A
version reaches npm only when the maintainer publishes a GitHub Release tagged `v` and the version in `package.json`, on a
commit on `main`: the suite runs again on that commit, the publish waits in the `release` environment for the maintainer's
approval, then goes to npm with provenance and no stored token. A prerelease (`0.9.0-rc.1`) goes to npm's `next` tag. How CI is locked down is in
[SECURITY.md](SECURITY.md#releases-and-the-supply-chain). Probes, the coding eval and the repository layout are in
[Development](https://github.com/sumododda/sumo-agents/wiki/Development).

MIT licensed.
