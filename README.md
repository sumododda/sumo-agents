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
sumo setup      # creates ~/.sumo-agents and downloads the 2.5 GB router model
sumo doctor     # every line should say ok
sumo chat
```

`npm update -g sumo-agents` moves to the newest release. Setup flags, corporate proxies and certificates
are covered in [Install](https://github.com/sumododda/sumo-agents/wiki/Install).

## Your first session

- Just talk. Name the project you mean; the first time, Sumo confirms its path and registers it. Started inside a
  registered project, the chat works there from the start.
- Say how you like things done. "Always run the linter before you commit" is remembered in your words and
  loaded next time.
- `/fix`, `/feature` and `/review` load a short written procedure for that kind of work. They also load on
  their own when your message asks for one.
- Big work is delegated without being asked. A row for the job appears under the box, you keep talking,
  and its report comes back into the conversation.
- `/new` starts a fresh session, and a new task deserves one. `/resume` picks an old one up. `/help` lists
  the rest, and `?` on an empty box shows the keys you reach for most.
- Ctrl-R searches what you sent before. `/context` shows how full the context is and what the session has cost.
  `/export` writes the conversation to a Markdown file.

## Good to know

- Destructive commands (`rm -rf ~`, `git reset --hard`, dropping a table) and commands that print secrets
  are refused in code before they run. `! <command>` runs one yourself.
- On macOS the agent's shell runs in a sandbox: it writes only in the project, the temporary folders, Sumo's
  home and the tool caches, never in git's hooks or config. A write it blocks is put to you once to run
  outside it. `sumo config shell.network off` also keeps it off the network.
- The agent's shell gets your whole environment except the Anthropic credential. It never waits on a prompt,
  stops a command silent for 2 minutes (`timeout 600 <cmd>` asks for longer), and runs a command ending in
  `&` in the background with its own log.
- A worker's first DONE is answered with its task beside its change to check; the second runs your checks.
  A failed first attempt is retried once on the next model up, and risky work is reviewed, without asking.
  A second worker on a git project works in a worktree of its own.
- A job's run stops at $10 or 60 minutes (`jobs.budget`, `jobs.minutes`). `sumo cost` shows where the money went.
- `/undo` puts back the files the last chat turn changed with the editor.
- Only your words become memory. Web pages, files and tool output are never filed as yours.
- The local model, Qwen3-4B through llama.cpp, routes jobs and writes memory for $0 and sleeps when idle.

## Configuration

`sumo config <key> <value>` sets one; `sumo config` lists them. The ones most people touch:

| Key | Default | What it does |
|---|---|---|
| `chat.model` | `opus` | What the chat runs on. `auto` lets the local router pick per turn. |
| `chat.effort` | `medium` | Effort when the chat model is fixed. |
| `chat.budget` | `5` | Dollars a chat session costs before the screen says so; `0` never. |
| `chat.motion` | `on` | `off` keeps the working line still: no colours flowing through it. |
| `projects.home` | `~` | Where new projects are created. |
| `jobs.budget` | `10` | Dollars one job may spend before it is stopped; `0` for no cap. |
| `jobs.floor` | `haiku` | The smallest model a job may run on: `sonnet` keeps every job off Haiku, `opus` puts them all on Opus or Fable. |
| `jobs.minutes` | `60` | Minutes one job may run before it is stopped; `0` for no limit. |
| `jobs.escalate` | `on` | A worker's failed first attempt is retried once on the next model up. |
| `jobs.review` | `risky` | Which verified work gets a reviewer without asking: `risky`, `all` or `off`. |
| `jobs.advisor` | `off` | `on` lets a job ask the next model up for advice. |
| `shell.sandbox` | `on` | The agent's shell in the macOS sandbox. Read when a chat or job starts. |
| `shell.network` | `on` | `off` keeps the sandboxed shell to this machine. |

The full list, the API model switches and the environment variables are in
[Install](https://github.com/sumododda/sumo-agents/wiki/Install#configuration).

## Learn more

The [wiki](https://github.com/sumododda/sumo-agents/wiki) has the detail:

- [The chat](https://github.com/sumododda/sumo-agents/wiki/The-chat): commands, keys, the screen, sessions
- [Projects and memory](https://github.com/sumododda/sumo-agents/wiki/Projects-and-memory): cards, scratch, how memory is written and managed
- [Jobs](https://github.com/sumododda/sumo-agents/wiki/Jobs): delegation, routing, coding guides, verifying DONE, reviews
- [Web search and MCP](https://github.com/sumododda/sumo-agents/wiki/Web-search-and-MCP)
- [Safety](https://github.com/sumododda/sumo-agents/wiki/Safety): what is enforced by code and what is only asked
- [How it works](https://github.com/sumododda/sumo-agents/wiki/How-it-works): a turn, the local model, costs

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

A release is a commit on `main` that raises the version in `package.json`. The workflow runs the suite
and publishes it to npm. Probes, the coding eval and the repository layout are in
[Development](https://github.com/sumododda/sumo-agents/wiki/Development).

MIT licensed.
