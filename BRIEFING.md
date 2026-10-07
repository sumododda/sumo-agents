# Briefing — hardening the harness

Status, 2026-10-07: audit done, the changes below implemented and tested, nothing committed. The full suite is
run after every change; the last run is reported at the end of this file. Every change is on the working tree:
`git diff` shows it whole, `git stash` takes it away.

How to read this: **Importance** says what breaks or costs without the change. **High** means a job or a session
is lost, or money is spent for nothing. **Medium** means a worse run, a slower user, or a wrong number in the
ledger. **Low** means tidiness that still pays.

## Changes made

| # | Change | Where | Importance |
|---|---|---|---|
| 1 | **Requests the API or the connection let down are sent again.** The SDK retries only before the first byte; an overload or a dropped connection half-way through a stream ended the turn with `stop: 'error'`, and a nine-minute job died of one 529 and was left "never closed". Now `converse` retries `APIConnectionError`, 408/409/429/5xx, and mid-stream `overloaded_error` / `api_error` / `rate_limit_error`: up to 6 tries, 1s doubling to 30s with jitter, or what `retry-after` asks; Esc stops the wait; each try is one ledger row and one `onRetry` call, said on the screen, in the job printer and in the piped chat. A 4xx the request itself caused is not retried. | `src/loop.mjs` `retryable` `retryDelay` `describeFailure`, `converse`; `src/chat.mjs` `retryLine`; `src/ui.mjs` | High |
| 2 | **Compaction for jobs that outgrow the context.** The ADR planned it; it was never built: a job at the 150k "act" band just carried on degrading until the window was exceeded. Now, at the end of a tool round past 150k tokens, one request with `compaction: {type:'summarize', instructions}` under `compact-2026-09-04` — the context edits left off, since the API takes one or the other — summarizes the conversation; the summary block goes first in every later request, followed by a line that says to carry on and names `sumo job brief <id>` for what the summary left out. Not again within three turns; a failed summary costs only its request and is noted in the ledger. The request shape is the one the SDK's own tool runner sends. The chat keeps its `/new` nudges by design. | `src/loop.mjs` `compactionParams` `COMPACT_AT` `COMPACT_INSTRUCTIONS`, `converse`, `runJob`; `src/chat.mjs` `compactLine` | High |
| 3 | **A resumed session no longer replays thinking blocks.** A thinking block's signature is bound to the exact history it was made in — system prompt, tools, every message before it. A saved session had its secrets redacted and its pictures replaced, and AGENTS.md or the MCP servers may have changed since; on Opus 5.5 / Sonnet 5.5 / Fable 5.1, accounts created on or after 2026-08-31 get a 400 on the first resumed turn. `/resume` now sends the words and the calls without the thinking (the documented no-beta recovery). | `src/sessions.mjs` `withoutThinking`; `src/chat.mjs` `start` | High on new accounts |
| 4 | **Thinking is shown.** No `thinking` param was sent, so on the 5.x models `display` defaulted to `omitted` and a long turn looked silent for minutes. Every model but Haiku 4.5 (which rejects `adaptive`) now gets `thinking: {type:'adaptive', display:'summarized'}`; the stream's `thinking` events reach the chat and the UI, which shows the last line under the working line, and on a delegated job's line in place of "thinking…". Billing is unchanged: display is visibility only. `/model` to Haiku drops the param. | `src/loop.mjs` `thinkingFor` `sendToApi`; `src/chat.mjs` `apply`; `src/ui.mjs` `Working` `JobAtWork` | Medium |
| 5 | **A loop brake.** Gemini CLI and Codex stop or nudge on repeated identical tool calls; Sumo ran them to the 150-turn limit. The same call with the same input and the same answer three times in a row now gets a note appended to its result; five times, the turn ends with `stop: 'loop'` and the screen says so. | `src/loop.mjs` `converse` `stopReason` | Medium |
| 6 | **The turn before the last carries a warning.** A run that hit `MAX_TURNS` left the job open with no report. The request before the last now says so and asks for `finish` or a summary. | `src/loop.mjs` `LAST_TURN` | Medium |
| 7 | **Long command output is kept where the model can read it.** The head and tail (16k) were shown and the middle was gone, so the model re-ran expensive commands. Now the first and last 64 KB (what the runner held), redacted, are written to the job's folder (`jobs/<id>/output/`) or `~/.sumo-agents/logs/output/` for the chat, and the cut names the file; files older than a week are removed on the next write. | `src/tools.mjs` `spill` `capRedacted`; `src/loop.mjs` `contextFor` | Medium |
| 8 | **Tolerant edit matching behind the same uniqueness rule.** `str_replace` demanded one exact match; an `old_str` off by a trailing space, a CRLF file, or the wrong indentation cost a turn on "not found". Now: exact → the file's line endings → line by line without trailing spaces → without indentation (the replacement re-indented to the file's depth); still refused unless it is the only match; the result says how it matched; `old_str === new_str` is refused. | `src/tools.mjs` `locate` | Medium |
| 9 | **The `rm` guard closes the gaps the Codex comparison found.** `/bin/rm -rf /`, `\rm`, `rm / -rf` (flags after the target), `rm -rf -- .`, and `rm` behind `env`, `nice`, `timeout`, `xargs` or `command` all went through. They are refused now; `rm -rf node_modules` is still Tuesday. | `src/guard.mjs` `RM` `RECURSIVE` | Medium |
| 10 | **`pause_turn` is handled.** The API pausing a long turn ended the conversation; now the reply is kept and the turn goes on. | `src/loop.mjs` `converse` | Medium |
| 11 | **The ledger names the model that answered.** `response.model`, not the one asked for, and the cost is priced by it — the truth survives any fallback or server-side routing. | `src/loop.mjs` `converse` | Low |
| 12 | **One SDK client per credential** instead of `new Anthropic()` on every request: the SDK keeps its connection pool and retry state on the client. Keyed by credential, timeout, retries and `ANTHROPIC_BASE_URL`. | `src/auth.mjs` `anthropicClient`; `loop.mjs`, `model.mjs`, `catalog.mjs` | Low |
| 13 | **Two tail cache breakpoints.** The breakpoint lookup walks back at most ~20 blocks; a turn of many calls could put the new tail out of reach of the last entry. The previous tail keeps its mark (system + 2 of the API's 4), so what the last turn wrote is read for certain. | `src/loop.mjs` `markTail` | Low |
| 14 | **A binary is not viewed as text.** A NUL byte in the first 8 KB → "is a binary file (N bytes) — not shown". | `src/tools.mjs` `view` | Low |
| 15 | **Two prompt lines Anthropic now recommends for Fable 5.1 harnesses**, within the standing-prompt budget: the screen folds tool output, so say what the user needs; edit the lines that change, never a whole file. | `AGENTS.md`, `prompts/agent.md` | Low |
| 16 | **README** documents 1–9. | `README.md` | — |

Tests added or changed: `test/loop.test.mjs` (retry, pause_turn, served model, loop brake, last-turn warning, two
breakpoints, tolerant edits, compaction, spill, binary view), `test/guard.test.mjs` (the new `rm` spellings, and
that ordinary deletes still pass), `test/chat.test.mjs` (resume strips thinking), `test/ui.test.mjs` (thinking under
the working line, the retry note).

## Decided against, and why

- **Server-side refusal fallbacks (`fallbacks: "default"`).** The ADR §5 says a per-route setting, not a default; a
  fallback silently changes the model a job was routed to, and the Claude-Code-OAuth path cannot be verified to accept
  the beta. Left off. With change 11 the ledger would record a fallback truthfully if it is ever turned on.
- **`drop_block` under `thinking-binding-controls-2026-08-01` on resume.** OpenCode's approach; it keeps reasoning
  when nothing changed. Stripping the thinking on resume covers every case (redaction, pictures, AGENTS.md edits, a
  down MCP server) without a beta. Reasoning lost once, at a boundary, has little effect.
- **Per-message effort** (`mid-conversation-output-config-2026-07-01`) for `/model` effort changes without a cache
  miss. Rare in practice; a beta on every request for it. Noted, not built.
- **`eager_input_streaming`, `strict: true` on the custom tools.** Sumo consumes no partial tool input, and eager
  streaming moves validation to the client; strict schemas would need every `delegate` property made required or
  nullable. Neither pays yet.
- **Compaction in the chat.** The ADR chose "finish the piece, then `/new`": the memory block brings the thread
  back for less than a summary costs. A `/compact` command is a one-line addition on top of change 2 if wanted.
- **Non-blocking delegation** (Anthropic's Fable 5.1 guidance: the sub-agent tool returns at once, the report arrives
  as a later user message, a separate `wait` tool). A real gain for parallel work, and a design change: the inbox
  mechanism could carry reports. Worth a design note; too large to slip in here.

## Risk to flag, not changed

`src/auth.mjs` sends a Claude Code OAuth token with Claude Code's identity (system prefix, user-agent `claude-cli`,
the `claude-code-20250219` beta). This is fragile and may sit outside what the token is meant for. The SDK resolves
`ant auth login` profiles itself when constructed with no key — that is the supported path for a non-API-key
credential.

## Comparison notes

**OpenCode (v1.18.35).** Confirmed findings 1, 3, 5, 7 with its own code (`session/retry.ts`, `provider/transform.ts`,
`session/processor.ts`, `tool/shell.ts`, `tool/truncate.ts`); its compaction template shaped the instructions in
change 2; its edit replacers shaped change 8 (the Levenshtein block-anchor and multi-occurrence strategies were not
adopted: looser than the uniqueness rule allows); its second tail breakpoint is change 13. Not adopted: nested
AGENTS.md on read, a side-git-dir snapshot with revert, session fork, TodoWrite.

**Codex (5a31401).** Its shell runs in a sandbox (seatbelt / bubblewrap) and relies on it rather than on command
patterns: its only dangerous-command detector is forced `rm`, unwrapped through `sudo`, `env`, `trap` and nested
shells. The gaps it exposed in Sumo's guard are change 9. Its tool-output policy (10k tokens, head/tail, full output
kept in the rollout) is change 7. Its compaction (90% of the window, a hand-off summary, the last 20k tokens of user
messages kept, auto-continue) agrees with change 2's shape. Not adopted without a sandbox: `*KEY*`/`*TOKEN*` env
excludes are off by default even there; `git reset` and friends are not detected there at all — Sumo's guard is
stricter on git and SQL.

**Gemini CLI, pi-mono, the SDK/Agent SDK comparison.** Those agents were cut off by the usage limit before reporting;
what is known of them (Gemini's loop detection, Pi's steering and cache breakpoints, the Agent SDK's hooks and
permission modes) came from the earlier reading and is reflected in changes 5 and 13 and in the list above.

## What Sumo already did well (unchanged)

Append-only history with server-side pruning; a frozen system prompt with a cache breakpoint; Anthropic-defined,
schema-less bash and editor tools; MCP tools deferred behind tool search; structured outputs for the cheap passes;
a per-response ledger with the cache split; process-group cleanup; redaction before the model sees any output; the
realpath jail; code-verified DONE; a ~650-token standing prompt.

## Test run

`npm test` after the last change: 454 tests, 454 passed, 0 failed (the suite had 448 before this work; six were added,
and the ones asserting the old single-breakpoint and plain-error behaviour were updated to the new behaviour).
