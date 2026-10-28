# Security

Sumo runs a model that reads web pages, files, MCP results and sub-agent reports, and acts on your machine. Any of
those can carry instructions meant to hijack it. Sumo's answer is to enforce in code what must not happen, rather
than ask the model to behave.

## What code enforces

| Threat | Enforced by |
|---|---|
| A command destroys work (`rm -rf ~`, `git reset --hard`, dropping a table) or prints a secret | `src/guard.mjs` refuses it before it runs |
| The shell writes outside the project | On macOS, a Seatbelt sandbox (`src/sandbox.mjs`): writes only in the project, temp, sumo's scratch and job folders, and tool caches |
| The shell changes what runs later, outside the sandbox | Read-only inside those places: git's hooks and config, shell rc files, `.envrc`, `.npmrc`, editor settings, credentials, `~/.gitconfig`, login items, every PATH folder |
| The shell rewrites sumo itself — switching the sandbox off, planting a memory, registering an MCP server | sumo's memory database, `mcp.json`, `bin`, `models` and `eval.env` are read-only to the sandbox; a plain `sumo …` command runs as sumo, where settings, MCP servers and models are refused from the model |
| The editor writes somewhere it shouldn't | Every write is judged where it lands (links resolved, any case); outside the project or to a guarded file it asks you first; a hard link is asked about each time |
| A project is made too wide to be a boundary | `sumo project add` refuses `/`, your home and above it, and sumo's home |
| The model's own tests escape when a job verifies them | A job's checks run in the job's sandbox, handed down by sumo, which records the verdict from outside it |
| Instructions from a page become "your" memory | Only your own words, quoted and checked against what you typed, become memory; a trap learned while reading the web or an MCP server is held, and only you confirm it |
| An MCP server or a redirect carries a token elsewhere | MCP calls not on your allow list are asked; plain `http` only to localhost; redirects refused |
| A secret reaches the model, a log or a report | Sumo's own credential is never in the shell's environment; every result, log, crash file and `sumo doctor --report` is redacted |

## Releases and the supply chain

| Risk | How it is closed |
|---|---|
| A tag of a third-party action is moved to malicious code | Every action is pinned to a full commit SHA, checked to belong to the action and version it names (zizmor's online audit); Dependabot proposes updates, each only once a week old |
| A workflow token is stolen or misused | No permissions by default; each job holds only what it uses, each one explained; the checkout keeps no credentials; nothing from an event is put into a script |
| A compromised dependency runs code during CI | `npm ci --ignore-scripts` installs exactly the lockfile and runs no package's install script; `npm audit signatures` checks every package as the registry signed it |
| A release is published without you | Publishing runs only on a push to `main`, after the whole test matrix passes, and waits in the `release` environment, which accepts only `main`, for your approval; npm trusts that environment by its identity (OIDC), so no token exists to steal |
| History on `main` is rewritten or the branch deleted | A repository ruleset refuses force-pushes to `main` and its deletion |
| A credential is pushed | Secret scanning with push protection refuses a push that carries a known kind of credential |
| A vulnerability goes unseen | CodeQL scans the code and the workflows on every push, pull request, and weekly, with the extended security queries; a dependency with a published advisory gets a Dependabot pull request at once |

The workflows are checked with [zizmor](https://docs.zizmor.sh) at its strictest (`--persona=auditor`), online and off: no findings.

## Known limits

- **macOS only, for the sandbox.** Elsewhere the shell writes wherever you can, and the first command says so.
- **A folder swapped for a link mid-edit.** The editor opens a file's last name without following a link, and writes
  only if the file opened is the one it checked. A parent folder swapped between the check and the open is not
  caught: Node has no `openat`.
- **Reads are open.** The shell and the editor can read any file you can (secret files excepted for the editor);
  the network is open unless `sumo config shell.network off`.
- **Secret files are known by name.** A command naming `.env`, a key or a credentials file is refused unless it
  only loads, lists, writes or passes it on — but a secret kept under another name is not recognised as one, nor
  is a program that reads it without naming it. Redaction of everything shown is the backstop, and it removes only
  values in a known shape (API keys, tokens, private keys, passwords in assignments).
- **What you allow is allowed.** An outside folder opened for the session, a command run outside the sandbox, an
  MCP tool allowed always: the model can use each as far as you allowed it.

## Reporting a vulnerability

Please report privately: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**.
If that is not available, open an issue asking for a private contact, without the details. Include the version
(`sumo --version`), what an attacker controls, and the steps. You'll get an answer within a week.
