# ADR: a Sumo-owned runtime on the Anthropic API, replacing the Claude Code harness

Status: accepted 2026-09-30 · phases 0–4 implemented 2026-10-01; the benchmark in §7 is the open item.

## 1. Recommendation

**Plain `@anthropic-ai/sdk` (TypeScript/Node) with a Sumo-owned loop.** One dependency, direct
`ANTHROPIC_API_KEY`, no hidden prompt, and every token-saving feature Anthropic ships lands in Sumo the
day it ships, not when a middle layer adopts it. Not Pi, not OpenCode, not the Claude Agent SDK.

Why this and not the others, in one line each (evidence in §9):

| Option | Verdict | The deciding fact |
|---|---|---|
| `@anthropic-ai/sdk` + own loop (~150 lines) | **choose** | 2 direct / 7 transitive deps, MIT, stable core; the loop Sumo needs is a fixed policy pipeline per tool call, which is exactly what the docs say the manual loop is for ("use the manual loop for approval, logging, conditional execution") |
| SDK `toolRunner` helper | acceptable fallback | same package, beta; gives `compactBeforeNextTurn()` and inline tool changes for free, but no first-class pre-execution veto and a churning beta surface |
| Pi (`pi-agent-core` + `pi-ai`) as libraries | reject | embeddable and hook-rich, but `pi-ai` pins `@anthropic-ai/sdk` 0.124 **plus** `openai`, `@google/genai` and the AWS Bedrock SDK; no server-side compaction, no context editing, no tool search (zero hits in source); fixed cache breakpoints; pre-1.0 with breaking changes in 8 of the last ~25 minors; one dominant author |
| OpenCode embedded | reject | a 144–186 MB Bun binary driven over HTTP; ~2k-token built-in prompt plus 14 tools (16 KB of descriptions); compaction and pruning are client-side (prune off by default, thresholds are constants); plugin hooks are `experimental.*`; releases every 1–2 days. It is a second large harness, which is the problem being removed |
| Claude Agent SDK | excluded by constraint | its docs: "A library that runs the Claude Code binary" |
| Vercel AI SDK | fallback only if portability ever matters | 9 transitive deps including a hard `@ai-sdk/gateway`; `prepareStep` is a decent pruning hook, but it is an abstraction over the Messages API |
| Aider | ideas only | the search/replace edit format (already what Anthropic's text editor tool does); the token-budgeted repo map is **not** adopted (see §4) |

The strongest single piece of evidence is Sumo's own measurement (`.lavish/token-efficient-reading.html`,
118 headless runs): in Claude Code about **31,000 cached tokens are re-read every turn, roughly 96% of
input; tool results were 1–5%.** The fixed prefix is the harness's, not Sumo's. Owning the prefix is
the lever; everything else is second order. No percentage saving is claimed here: it is the first
number the benchmark in §7 must produce.

## 2. What requires Claude Code today, and what does not

Traced from `.claude/`, `src/hooks.mjs`, `model.mjs`, `claude.mjs`, `scribe.mjs`, `route.mjs`,
`sessions.mjs`, `transcript.mjs`, `prime.mjs`, `jobs.mjs`, `verify.mjs`, `guard.mjs`, `setup.mjs`.

| Module / file | Coupling | Target |
|---|---|---|
| `.claude/settings.json` | hook registration (SessionStart, UserPromptSubmit, PreToolUse on Bash/Read/Agent/AskUserQuestion, Stop, SessionEnd); `sumo *` permission | **delete** after Phase 3; the six hook handlers become in-process middleware of the loop |
| `.claude/agents/*.md` (13 files) | exist only because Claude Code cannot set effort on an Agent call, so `<role>-<effort>` files carry it in frontmatter and a hook rewrites `subagent_type` | **delete**; route becomes two request fields (`model`, `output_config.effort`) |
| `.claude/commands/*.md` | thin pointers to `guides/` | **delete**; `/fix` `/feature` `/review` `/dream` become REPL commands that load the same guides |
| `src/hooks.mjs` | `READERS.claude` (session_id, transcript_path, tool_input.file_path…), `hookSpecificOutput` JSON envelopes, `routeAgent` rewriting the Agent call | **replace** the envelope with direct calls; **keep** every handler body (guard, workflow gate, recall-before-asking, card injection, size nudge, scribe trigger) |
| `src/model.mjs callModel` | spawns `claude -p --tools '' --system-prompt --json-schema --output-format json --max-budget-usd` for scribe/dream | **replace** with `client.messages.create` + structured outputs (`output_config.format`), Haiku 4.5, no thinking. `callLocalModel` (router via llama-server) is already neutral: keep |
| `src/claude.mjs` | edits `settings.local.json additionalDirectories` | **delete**; replaced by the loop's path jail (§5) |
| `src/transcript.mjs` | parses Claude Code JSONL for assistant text | **delete**; the loop has the assistant text in hand and passes it to the scribe bundle |
| `src/sessions.mjs contextUse/contextNudge` | reads the JSONL transcript for `usage`; nudges say `/clear`, `/compact` | **replace**: exact `usage` from every response; nudge text names REPL commands |
| `src/setup.mjs`, `doctor` | pins `claude.path`, fails without the CLI | **replace** with an `ANTHROPIC_API_KEY` presence check and a one-call `count_tokens` smoke test |
| `src/jobs.mjs` briefs | mention SendMessage/ToolSearch, Read/Grep/Glob, "STATUS line" | **edit** three strings; lifecycle, briefs, `finish` verdict, findings count are neutral |
| `AGENTS.md` | the always-loaded prompt (~650 tokens) | **keep** as the literal system prompt, split per role (main / worker / scout / reviewer) |
| `db.mjs`, `memory.mjs`, `apply.mjs`, `prime.mjs`, `card.mjs`, `projects.mjs`, `scan.mjs`, `recall.mjs`, `workflows.mjs`, `guard.mjs`, `verify.mjs`, `route.mjs`, `redact.mjs`, `dream.mjs`, `export.mjs`, `cli.mjs` | none | **keep** unchanged |

Roughly: of 4,600 lines, about 500 are harness-specific (hooks envelope, model spawn, claude.mjs,
transcript, transcript-based gauge, 13 agent files). The rest is already the runtime's policy layer.

## 3. Target architecture

```
 terminal (TTY)                          headless
 ┌──────────────┐   `sumo job run <id>`   ┌──────────────────────────┐
 │ sumo chat     │ ─────────────────────► │ job process (worker /    │
 │ (main REPL)  │ ◄── report.md, STATUS  │ scout / reviewer)        │
 └──────┬───────┘                        └────────────┬─────────────┘
        │              both are the same loop         │
        ▼                                             ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ src/loop.mjs  — one turn = request → policy → tools → ledger     │
 │   prefix:  tools (bash, text editor, ask_user[, delegate])       │
 │            system = AGENTS.md role text, frozen, cache breakpoint│
 │   messages: brief or prime as the first user turn; cards,       │
 │            workflow steps, nudges as role:"system" messages      │
 │   per tool call: guard → workflow gate → path jail → run → cap  │
 │            → redact → tool_result (+ ledger row)                 │
 │   context: server-side clear_tool_uses; on-demand compaction;   │
 │            exact usage gauge → "finish the piece, then restart" │
 └───────┬──────────────────────────────┬───────────────────────────┘
         │ @anthropic-ai/sdk            │ node:sqlite (existing)
         ▼                              ▼
   Anthropic Messages API        ~/.sumo-agents/memory.db + jobs/<id>/
   (prompt cache, context        memories · cards · jobs · route stats ·
    editing, compaction)          model_runs ledger · briefs · verify.json
```

The router (Qwen3 via llama-server) is unchanged and still decides `model`/`effort` before a job exists.
Model aliases map once: `haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-5-5`, `opus → claude-opus-5-5`,
`fable → claude-fable-5-1`.

## 4. Token-budget design

Sequence the loop is built around: localize → selectively retrieve → compact evidence → reuse validated
prior work → structured patch → validate → feed back only the new failure delta.

**Cached (the frozen prefix).** `tools` then `system`, byte-stable per role, one explicit
`cache_control` breakpoint on the last system block, plus top-level automatic caching for the growing
tail. Nothing volatile before the breakpoint: no timestamps, no session ids, sorted JSON. Verified facts
that shape this: minimum cacheable prefix is 512 tokens on Opus 5.5 / Sonnet 5.5 / Fable 5.1 but
**4,096 on Haiku 4.5**, so a scout's prefix will not cache until its conversation is that long; cache
reads are 0.1× (0.05× on Opus 5.5, 0.025× on Fable 5.1), writes 1.25× (5 min) or 2× (1 h); any tool
or system change invalidates everything after it, so tool lists are fixed per role and `effort` is
pinned per job (an effort change invalidates the messages cache).

**Retrieved, not dumped.** Project card ≤ 200 tokens once per project (existing); memory by
`sumo search`; code by grep first, then a windowed `view` with `view_range`, then callers. Sumo's own
measurement showed structural tools did not beat grep for symbol lookups on Sonnet and CodeGraph
returned 4–14k tokens per call; so **no repo map is built** (Aider's PageRank map has no published
ablation either). CodeGraph stays available through `bash` where the user has indexed a project, per
memory m55, with its output capped like any other tool result. Tool search is not used: Anthropic's
own threshold is 10+ tools or >10k tokens of definitions; Sumo has three or four.

**Small, explicit tool set.** `bash_20250124` and `text_editor_20250728` are Anthropic-defined and
schema-less on the wire (the published cost is 325 tokens for bash on Opus 5/4.8/4.7 and 700 for the
20250429 text editor; the 5.5-generation rows are not published, so measure with `count_tokens`),
`ask_user` (dedicated so recall-before-asking can intercept it, as the AskUserQuestion hook does today),
and `delegate` in the main session only. Editing is search/replace by construction, which is the
Aider lesson worth keeping (its whole-file format is the "slow and costly" one).

**Capped and structured tool results.** Every result passes one capper: bash output head+tail with a
byte ceiling and an explicit `[cut: N lines — use tail/grep]` marker; `view` defaults to a window;
grep results as `file:line: text` with a hit ceiling. Secrets are redacted from results with the
existing `redact.mjs` before they reach the model.

**Discarded server-side, never rewritten client-side.** `clear_tool_uses_20250919` with an explicit
`trigger`, `keep`, and `clear_at_least` large enough that the cache write it causes pays for itself
(the docs say clearing invalidates the prefix at that point). This must be server-side: on Opus 5.5 /
Sonnet 5.5 / Fable 5.1, client-side edits to earlier turns invalidate every later thinking block, and
accounts created on or after 2026-08-31 get a 400 for replaying them. Sumo's history is append-only.

**Summarized only at a boundary.** Durable state already lives outside the context (briefs, `sumo job
note`, checkpoints, `sumo prime`), so the first choice at the "watch" band (80k) stays "finish the piece,
then start fresh from `sumo prime`". When a job must continue past the "act" band (150k), one
**on-demand compaction** request (`compact-2026-09-04`, the form Anthropic says to prefer) with Sumo's
own instructions (open job ids, decisions, last failing command) and `cache_control` on the returned
block. Threshold compaction (`compact-2026-01-12`) is not used: it runs inside an ordinary request and
cannot be combined with context editing.

**Cache-preserving injection.** Cards, workflow steps and size nudges go in as `role: "system"`
messages inside `messages` (Opus 5.5, Sonnet 5.5, Fable 5.1; no beta) so the prefix is untouched and
they carry operator authority; on Haiku 4.5 they fall back to a text block after the tool results.
Per-turn reminders use `clear_at: "next_user_message"` and are never deleted afterwards.

**Reuse validated prior work.** Unchanged: `finish` reuses the last verdict when the tree fingerprint
matches; `retry` carries notes and report; gotchas are filed by code. Exact prompt-prefix caching is
the only cache; no semantic cache is built (no evidence it helps coding, and it adds a dependency).

**Feed back only the new failure delta.** `verify.mjs` already stores baseline and verify outputs per
check; the loop returns to the model the lines present in the failing run and absent from the baseline,
not the whole log.

**Measured.** Every response writes one `model_runs` row (table exists): add `cache_read`,
`cache_creation`, `job_id`, `session_id`, `turn`, `tool_calls`, `effort`, and `verdict`. Roll up per job
and per model/effort so `sumo job stats` shows cost beside Important findings, and the router's history
gains a cost column. The first ledger number to publish is the fixed prefix in tokens (tools + system,
zero messages) via `count_tokens`, which is free and rate-limited separately.

## 5. Security model

All of it runs in the Sumo process, before a tool executes. No hook to misconfigure, no `!` bypass
inside the model's reach; the human override is the human's own terminal.

| Protection | Where it runs | Change from today |
|---|---|---|
| Destructive command refusal (`rm -rf ~`, `git reset --hard`, `DROP TABLE` …) | `guardCommand` on every `bash` call | same code, in-process |
| Secret-file read refusal (`.env`, keys, `~/.aws/credentials`) | `guardPath` on `view`, on `bash` prints, and on `create`/`str_replace` targets | extended to writes |
| Path jail | `realpath` of every path and the bash `cwd` must sit under the job's project path or `~/.sumo-agents/jobs/<id>` | replaces `additionalDirectories` |
| Key never enters the sandbox | child processes get a filtered env: `ANTHROPIC_API_KEY` and anything matching the secret shape are dropped. *2026-10-06: narrowed to Sumo's own credential — the user's tokens are theirs to use for probes and smoke tests; `env` and its kin are refused instead* | new; without it `env` in bash prints the key |
| Tool-result redaction | `redact.mjs` on every tool result | new; today only user turns are redacted |
| Workflow gate | `claim` before a gated command, once per session per agent | same |
| Recall before asking | on `ask_user` and on a closing question | same |
| Worker/reviewer separation | reviewer and scout get no text editor tool; bash stays (as today) | same boundary, enforced by tool list rather than agent file |
| DONE is code-verified | baseline / verify / finish, secret and test-tampering scans | unchanged |
| Approvals | a single `approve(kind, detail)` seam: in the TTY it prompts; headless jobs deny and record `NEEDS_INPUT` | new seam; today Sumo runs under bypass permissions and relies on guard + verify |
| Prompt injection from tool output | tool results never reach the scribe (already policy); system messages carry operator authority so a card cannot be spoofed by file content | strengthened |

Refusals on Fable 5.1 / Opus 5.5 (`stop_reason: "refusal"`) are handled explicitly; the server-side
`fallbacks: "default"` option is available and should be a per-route setting, not a default.

## 6. Migration plan

Each phase is shippable alone and leaves the Claude Code path working until the last one.

0. **Measure first (no runtime change).** Extend `model_runs` with the cache columns; build the
   benchmark harness in §7 and record the Claude Code baseline. Nothing else starts without this.
1. **Cheap passes to the API.** `callModel` → `@anthropic-ai/sdk` with `output_config.format` for the
   ops schema, Haiku 4.5, thinking off. Same envelope, same tests (the `SUMO_AGENTS_MODEL_CMD` stand-in
   stays). Removes `claude.path` from scribe/dream. Compare input tokens per scribe call against the
   measured ~4,300 today.
2. **Headless jobs.** `sumo job run <id>`: the owned loop runs a worker/scout/reviewer from its brief on
   the routed model and effort, with the §5 policy pipeline and the §4 ledger, and closes the job through
   the existing `finish`. **Bridge:** the main Claude Code session delegates by running
   `sumo job run <id>` in Bash instead of the Agent tool; hooks, briefs and reports are unchanged, so both
   delegation paths coexist. Run the §7 comparison here; go/no-go before Phase 3.
3. **Main session.** `sumo chat`: a small TTY REPL over the same loop with `ask_user` and `delegate`
   tools, `sumo prime` as the first user turn, cards as system messages, the exact usage gauge, the
   guides as commands. The hook handlers become middleware; `AGENTS.md` role texts become the system
   prompts. Keep `.claude/` working until the REPL has done a week of real work.
4. **Delete.** `.claude/agents/*`, `.claude/commands/*`, `settings.json` hooks, `src/claude.mjs`,
   `src/transcript.mjs`, the transcript gauge, `claude.path` in setup and doctor. README and PLAN say
   the harness is gone.

Compaction, context editing and mid-conversation system messages are betas: pin the header strings in
one module (`src/api.mjs`) behind feature flags, so a header change is a one-line edit and a
`--no-beta` run still works.

## 7. Benchmark plan

**Tasks.** Fixed, real, not invented: the 28 job folders in `~/.sumo-agents/jobs/` already hold a
brief, a recorded start commit (`verify.json.snap.base`), the check outputs and a report. Pick 8 worker
briefs across the two stacks on this machine (Go in proj-simba, JS in sumo-agents), plus 2 scout and
2 reviewer briefs. Each run replays a brief in a `git worktree` at its start commit. New tasks are
added only by doing real work; nothing runtime-side may reference a task.

**Metrics per run**, all from the ledger: input tokens split into uncached / cache read / cache write;
output tokens; cost; API calls; tool calls; wall time; verify verdict (pass, blocked, unverified);
Important findings from one fixed reviewer configuration (opus/high, same review brief) grading both
runtimes' diffs blind.

**Baselines.** Claude Code headless (`claude -p "JOB: run sumo job brief N" --output-format json`) on
the same model and effort, 3 runs per task; the Sumo runtime, 3 runs per task. Variance is reported,
not averaged away.

**Stop/go between phases.** Go when, over the set: verify pass rate is not lower by more than one
task; mean Important is within 0.5 of the baseline; cost per DONE job is lower. Otherwise stop,
read the ledger to see where tokens went (prefix, results, output, retries), change **one** lever
(cap size, `keep`, breakpoint placement, a prompt line), rerun. That loop is the product's improvement
loop, and it is generic by construction because the only knobs are global.

## 8. Risks and open questions

- **Beta surface churn.** Compaction has already moved from `compact-2026-01-12` to `compact-2026-09-04`;
  context editing, inline tools and `clear_at` are betas. Mitigated by the one-module pin and the
  `--no-beta` path, not eliminated.
- **Haiku 4.5 is the odd model.** 4,096-token cache minimum, no `effort`, no mid-conversation system
  messages, `budget_tokens` thinking. Scouts on Haiku get the fallbacks in §4; whether a scout on
  Sonnet 5.5 at low effort is cheaper per answer is a benchmark question, not a guess.
- **Preserved thinking makes history immutable.** Any future "prune the transcript" idea is a 400 on new
  accounts. The design is append-only; tests must assert it.
- **Forced tool choice is gone** on 5.5-generation models, so "you must call finish" is a prompt
  instruction plus `sumo job finish` on bash; a run that ends without closing is caught by the existing
  "no STATUS line → never closed" rule.
- **Billing changes shape.** Today's cheap passes run on subscription login; the API bills per token.
  Phase 1 shows the real per-call cost before anything else moves.
- **Losing Claude Code's surface.** MCP servers, browser tools, plugins and its TUI are not replaced.
  The REPL is deliberately last, and `.claude/` stays until it has carried a week of real work.
  *2026-10-06: MCP servers are back, as an in-process client (`src/mcp.mjs`, stdio and streamable HTTP, no
  dependency), their tools deferred behind Anthropic's tool search so the prefix stays small; see the README.*
- **Rate limits and long turns.** Fable 5.1 turns can run minutes; stream everything, keep `max_tokens`
  high, let the SDK's retries handle 429/5xx, and keep the 1-hour TTL off unless the ledger shows
  5–60 minute gaps between requests that share a prefix.
- **Unverified numbers.** Per-tool token overhead of the schema-less tools on the 5.5 generation; the
  real prefix size of the Sumo runtime; every saving. All are first outputs of §7.

## 9. Evidence

- Repo trace: files named in §2, read in full on 2026-09-30.
- Sumo's own measurement: `.lavish/token-efficient-reading.html` (118 runs, $8.28).
- Anthropic docs (fetched 2026-09-30): prompt caching (minimums, 1.25×/2×/0.1×, 4 breakpoints,
  tools→system→messages hierarchy); compaction overview, on-demand and threshold pages ("Use on-demand
  compaction wherever it is available"; threshold trigger ≥ 50k, default 150k; cannot combine with
  `context_management`); context editing (`trigger` default 100k, `keep` default 3, clearing invalidates
  the prefix at that point, all models); token counting (free, separate RPM limits); tool search (10+
  tools / >10k tokens); mid-conversation system messages and `clear_at` (Opus 5.5, Sonnet 5.5, Fable 5.1;
  not Sonnet 5, not Haiku); task budgets; tool runner ("use the manual loop" for approval); Claude Agent
  SDK overview ("runs the Claude Code binary"); bash and text editor tool pages (schema-less; 325 / 700
  tokens where published). Anthropic's published context-editing result, 84% fewer tokens on a 100-turn
  web-search eval, is their eval, not a coding one, and is not relied on.
- `@anthropic-ai/sdk` 0.131.0: MIT, deps `standardwebhooks`, `json-schema-to-ts`, optional `zod` peer;
  `helpers.md` for `toolRunner`, `compactBeforeNextTurn`, `addTools`/`removeTools`.
- Pi (`earendil-works/pi`, 0.99.2, 2026-09-30): `packages/agent/README.md`, `packages/ai/src/api/anthropic-messages.ts`
  (breakpoints at lines 1170–1191, 1490–1511, 1615; betas at 192–197), root README ("Pi does not include
  a built-in permission system"), agent-core CHANGELOG (breaking changes 0.75–0.87), `npm view`.
- OpenCode (`anomalyco/opencode` v1.18.34): `session/system.ts`, `session/prompt/anthropic.txt`
  (8,212 bytes), `tool/registry.ts`, `session/compaction.ts`, `session/overflow.ts`, `permission/index.ts`,
  `packages/plugin/src/index.ts`, `script/build.ts` (Bun compile), npm unpacked sizes.
- Aider: `aider/repomap.py`, repo-map docs and blog (no ablation published), edit-format docs, unified
  diff post (20% → 61% on GPT-4 Turbo refactors).
- Alternatives: Vercel AI SDK provider docs; Mastra (~230 transitive deps); LangGraph.js; Codex SDK
  (OpenAI-compatible providers only); mini-swe-agent (bash-only, ~100 lines); smolagents (Python).

## Verdict

Use the plain Anthropic SDK with a Sumo-owned loop. Pi is the best of the libraries but adds three
provider SDKs and lags the Anthropic features that save the most tokens; OpenCode is a second harness.
Sumo already owns memory, briefs, routing, verification and guardrails; what it lacks is about 500
lines: a loop, a policy pipeline, a ledger, and a REPL. Measure first, move the cheap passes, then jobs,
then the main session, and delete `.claude/` last.
