# sumo-agents

A coding agent you talk to from one place. It works across every project on your machine, remembers what
you tell it, and hands big work to background jobs that are checked before they can say they are done.

- **One chat for everything.** Mention a project by name; Sumo finds it on disk and works there.
- **Memory that lasts.** Your preferences, project rules and where you left off are kept locally and
  loaded into every new session. You never explain the same thing twice.
- **Background jobs.** Big, parallel or reading-heavy work goes to scout, worker and reviewer jobs. A
  local model picks the model and effort for each one, so the dearest model is never the default.
- **Checked results.** A worker cannot report done until the project's own tests and linters agree.
- **Its own loop.** Sumo talks to the Anthropic API directly and owns its prompt, tools, context and cost.

Everything it learns lives in `~/.sumo-agents/` on each machine, never in a repository, so a work laptop
and a personal one learn separately.

## Install

You need Node 22.19+ or 24.6+, [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`)
for the local model, and `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in
your environment.

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
  loaded next time. What Sumo only guessed you meant is asked in sessions about that project, for two weeks;
  after that it waits on the memory page (`/memory`).
- Memory looks after itself, in one background pass on the local model. After a turn it files what you said;
  once three conversations have finished, or a week has passed, it also reads them side by side and raises two
  memories that say one thing, or cannot both be true, for you to settle. A project's facts are read again when
  its files change. A trap an agent filed that nobody was shown in 45 days is let go, history kept. What a job
  learned while reading the web or an MCP server waits for you to confirm. `sumo memory status` says how it is
  doing; `sumo memory run --tidy` tidies now.
- `/fix`, `/feature` and `/review` load a short written procedure for that kind of work. They also load on
  their own when your message asks for one.
- Big work is delegated without being asked. A row for the job appears under the box, you keep talking,
  and its report comes back into the conversation.
- `/new` starts a fresh session, and a new task deserves one. `/handoff` has the model write a hand-off of
  the piece in hand first, and the fresh session starts from it. `/resume` picks an old one up. `/help` lists
  the rest, and `?` on an empty box shows the keys you reach for most.
- Ctrl-R searches what you sent before. `/context` shows how full the context is and what the session has cost.
  `/export` writes the conversation to a Markdown file.

## Good to know

- Destructive commands (`rm -rf ~`, `git reset --hard`, dropping a table) and commands that print secrets
  are refused in code before they run. `! <command>` runs one yourself.
- On macOS the agent's shell runs in a sandbox: it writes only in the project, the temporary folders, Sumo's
  home and the tool caches — never in git's hooks or config, nor Sumo's own memory, settings or MCP servers. A
  plain `sumo …` command it runs is run as Sumo itself, where what only you may change is refused. A write the
  sandbox blocks is put to you once to run outside it. `sumo config shell.network off` keeps it off the network.
- An MCP server that takes only a registered app's login, as Slack's official one does, is reached through
  Claude Code's: `claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp`, `claude mcp login slack`,
  then `sumo mcp add slack --url https://mcp.slack.com/mcp --from-claude`. Sumo borrows the token and never refreshes it.
  On macOS the token is read from the keychain: when macOS asks, choose Always Allow.
- The editor reads any file but changes only the project's. A change to one outside it — a config file in
  your home, say — is put to you with the change: once, or that file or its directory for the rest of the
  session, where the shell may then write too. The home itself is never opened that way. A file something
  else reads later — your shell's rc files, `.envrc`, `.npmrc`, `.vscode`, `.mcp.json`, Sumo's own MCP file —
  is changed only when you say so, each time, under any spelling of its name.
- Any of these questions can be refused with your reason: `r`, type why, Enter. The model reads it as what to
  do instead. Questions from several jobs queue, and the one shown says how many wait behind it.
- The agent's shell gets your whole environment except the Anthropic credential. It never waits on a prompt,
  stops a command silent for 2 minutes (`timeout 600 <cmd>` asks for longer), and runs a command ending in
  `&` in the background with its own log.
- A worker's first DONE is answered with its task as a numbered checklist beside its change, one answer per
  item; the second runs your checks.
  A failed first attempt is retried once on the next model up, and risky work is reviewed, without asking.
  A second worker on a git project works in a worktree of its own.
- A job's run stops at $10 or 60 minutes (`jobs.budget`, `jobs.minutes`). `sumo cost` shows where the money went,
  and why the cache was written again when it was.
- `/undo` puts back the files the last chat turn changed with the editor.
- Only your words become memory. Web pages, files and tool output are never filed as yours.
- The local model, Qwen3-4B through llama.cpp, routes jobs and writes memory for $0 and sleeps when idle.
- A crash is written, redacted, to `~/.sumo-agents/logs/crash-*.log`. `sumo doctor --report` prints everything a
  bug report needs, redacted, and sends nothing; the logs that hold what you said are counted there, not quoted.
  `sumo doctor --fix` makes the home's files private again.
- The database is copied beside itself before an upgrade migrates it (`memory.db.pre-v<N>.bak`, the last three),
  and weekly into `~/.sumo-agents/backups`. A database that will not open is said with the newest copy:
  `sumo backup restore` puts it back (or `sumo backup restore <file>`), keeping the damaged one aside. Over a
  database that is fine, it says what would be lost and asks first (`--yes` in a script).
- `sumo forget <id> --purge` erases a memory for good, from every backup and set-aside copy too; it shows the memory
  and asks you to type its id (`--yes` in a script).
- `NO_COLOR=1` turns colour off everywhere, the chat screen included; the cursor in the box and the changed part of an
  edit stay in reverse video, which is not colour. `sumo --version` says which sumo this is.

## Configuration

`sumo config <key> <value>` sets one; `sumo config` lists all fifteen, in this order:

| Key | Default | What it does |
|---|---|---|
| `chat.budget` | `5` | Dollars a chat session costs before the screen says so; `0` never. |
| `chat.effort` | `medium` | Effort when the chat model is fixed. |
| `chat.model` | `opus` | What the chat runs on. `auto` lets the local router pick per turn. |
| `chat.notify` | `on` | `off` stops the bell and the notification when a long turn ends behind another window. |
| `chat.screen` | `full` | `still` keeps the working line still. `plain` draws the chat for a screen reader: words, not pictures (no logo, no name in blocks), ASCII marks (`*` a call, `x` a failure), no frame around the box or a question, and nothing that moves or ticks. |
| `jobs.advisor` | `off` | `on` lets a job ask the next model up for advice. |
| `jobs.budget` | `10` | Dollars one job may spend before it is stopped; `0` for no cap. |
| `jobs.floor` | `haiku` | The smallest model a job may run on: `sonnet` keeps every job off Haiku, `opus` puts them all on Opus or Fable. |
| `jobs.minutes` | `60` | Minutes one job may run before it is stopped; `0` for no limit. |
| `jobs.review` | `risky` | Which verified work gets a reviewer without asking: `risky`, `all` or `off`. |
| `memory.model` | `local` | What the memory pass runs on: `local`, a model name, or `off` (the chat then saves what lasts itself). |
| `model.url` | `https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf` | The local model's download address, a `.gguf` file. Run `sumo setup` after changing it; `sumo setup --model-source <base>` puts a mirror in front of the same file. |
| `projects.home` | `~` | Where new projects are created. |
| `shell.network` | `on` | `off` keeps the sandboxed shell to this machine. |
| `shell.sandbox` | `on` | The agent's shell in the macOS sandbox. Read when a chat or job starts. |

The API model switches and the environment variables are in
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

A release is a commit on `main` that raises the version in `package.json`. The workflow runs the suite on
macOS and Linux, Node 22 and 24; when all four pass, the publish waits in the `release` environment for the
maintainer's approval, then goes to npm with provenance and no stored token. How CI is locked down is in
[SECURITY.md](SECURITY.md#releases-and-the-supply-chain). Probes, the coding eval and the repository layout are in
[Development](https://github.com/sumododda/sumo-agents/wiki/Development).

MIT licensed.
