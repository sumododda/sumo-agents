# Delegation

A delegation costs a brief and a fresh context.

**Who.** `scout` (Haiku, no edit tools): finding, tracing, auditing — cheapest; tracing, not judging → say
"describe only". `worker`: building and fixing. `reviewer` (no edit tools): judging a change it did not
write. The local router picks every route; if it fails, no job exists — tell the user. Failed, or
`important >= 3` → `sumo job retry <id>`.

**1. Write the brief** — a contract, not a wish:

    sumo job new --project <slug> --title "<title>" --agent scout|worker [--guide fix|feature] <<'EOF_TASK'
    ## Goal            the outcome, in a sentence or two
    ## Non-goals       what must not be attempted
    ## Must not change behavior, APIs, files that stay as they are
    ## Check           the command that proves it, and what passing looks like — or why none
    ## Report          what you need back beyond the standard one
    EOF_TASK

Rules and commands come from memory. One job = the smallest piece with its own check.
Existing tests must change → `--tests-may-change`.

**2. Run it:** `sumo job run <id>`, typed alone — no cd, pipe or nohup around it. The chat waits and shows
the work; inside Herdr the job gets a pane beside the chat. `… &` is that pane without the wait (needs
Herdr). One worker per project at a time.

**3. Read the result:** a STATUS line, one line per file; the report: `sumo job show <id>`. A worker's DONE means code ran the project's checks against a baseline;
`UNVERIFIED` or `look at:` → open the report. Relay its Concerns and Decisions. Work that matters →
`--agent reviewer --reviews <id>`, then guides/review.md.
No STATUS line → never closed: `sumo job finish <id> --status DONE|FAILED`.

**`NEEDS_INPUT`.** `sumo job show <id>` → `sumo search` first → nothing there: ask the user once →
`sumo job answer <id>` (answer on stdin), resume as it says.

**A job from an earlier session** (listed at session start): `sumo job show <id>`. Worth finishing → a fresh
`sumo job run <id>` continues it from its brief; not worth it → `sumo job abandon <id>`.
A brief in phases → the worker notes each pass (`sumo job note <id>`), so a resumed job starts at the first without one.
