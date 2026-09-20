# Delegation

A delegation costs a brief and a fresh context.

**Who.** `scout` (Haiku, no edit tools): finding, tracing, auditing — cheapest; tracing, not judging → say
"describe only". `worker` (Sonnet): building and fixing. `reviewer` (Opus, no edit tools): judging a change
it did not write. A stronger model only when the user asks or a cheaper attempt failed its check twice;
a stuck job is never resent unchanged. Routing preferences: `mem search "which model sub-agent"`.

**1. Write the brief** — a contract, not a wish:

    mem job new --project <slug> --title "<title>" --agent scout|worker [--guide fix|feature] <<'EOF_TASK'
    ## Goal            the outcome, in a sentence or two
    ## Non-goals       what must not be attempted
    ## Must not change behavior, APIs, files that stay as they are
    ## Check           the command that proves it, and what passing looks like — or why none
    ## Report          what you need back beyond the standard one
    EOF_TASK

Rules, gotchas and commands come from memory. One job = the smallest piece with its own check.
Existing tests must change → `--tests-may-change`.

**2. Start it** with the named sub-agent and exactly the `JOB:` line printed. Independent scouts go in
the same turn; one worker per project at a time — they share a working tree.

**3. Read the result:** a STATUS line, one line per file; the report: `mem job show <id>`. A worker's DONE means code ran the project's checks against a baseline;
`UNVERIFIED` or `look at:` → open the report. Relay its Concerns and Decisions. Work that matters →
`--agent reviewer --reviews <id>`, then guides/review.md.
No STATUS line → never closed: `mem job finish <id> --status DONE|FAILED`.

**`NEEDS_INPUT`.** `mem job show <id>` → `mem search` first → nothing there: ask the user once →
`mem job answer <id>` (answer on stdin), resume as it says.

**A job from an earlier session** (listed at session start): `mem job show <id>`. Worth finishing → a fresh
sub-agent with the same `JOB:` line continues from its brief; not worth it → `mem job abandon <id>`.
A brief in phases → the worker notes each pass (`mem job note <id>`), so a resumed job starts at the first without one.
