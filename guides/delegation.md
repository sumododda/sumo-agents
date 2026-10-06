# Delegation

A delegation costs a brief and a fresh context: one `delegate` call. The sub-agent runs on its own route,
and its report is the result.

**Who.** `scout` (no edit tools): finding, tracing, auditing — cheapest; tracing, not judging → say
"describe only". `worker`: building and fixing. `reviewer` (no edit tools): judging a change it did not
write (`reviews`: the worker job; without it, the uncommitted change). The local router picks every route; if it fails, no job exists — tell the user.

**1. The brief** — `task`, a contract, not a wish:

    ## Goal            the outcome, in a sentence or two
    ## Non-goals       what must not be attempted
    ## Must not change behavior, APIs, files that stay as they are
    ## Check           the command that proves it, and what passing looks like — or why none
    ## Report          what you need back beyond the standard one

Rules and commands come from memory. One job = the smallest piece with its own check. `guide`: fix or
feature carries that guide in. Existing tests must change → `tests_may_change`.

**2. Several at once.** Independent pieces → several `delegate` calls in one reply; they run side by side
and each result arrives when its job ends. One worker per project at a time: two in one tree overwrite each other.

**3. The result:** a STATUS line, the cost, then the report. A worker's DONE means code ran the project's
checks against a baseline; `UNVERIFIED` or `look at:` → read the report closely. Relay its Concerns and
Decisions. Work that matters → a reviewer with `reviews`, then guides/review.md.
No STATUS (`never closed`) → `sumo job finish <id> --status DONE|FAILED` from its report.
Failed, or `important >= 3` → `sumo job retry <id>`, then `delegate` with that `job`.

**A job from an earlier session** (listed at session start): `sumo job show <id>`. Worth finishing →
`delegate` with only `job`: it continues from its brief and notes. Not worth it → `sumo job abandon <id>`.
Stopped on a question (rare): `sumo search` first, else ask the user once → `sumo job answer <id>`, then `delegate` with `job`.
