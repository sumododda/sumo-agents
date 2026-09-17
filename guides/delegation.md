# Delegation

Delegate when the work is big, parallel, or would flood this conversation with file contents.
Small, sequential things you do yourself: every delegation costs a brief and a whole fresh context.

**Who.** `scout` (Haiku, no edit tools) for finding, tracing, auditing, summarizing — the cheapest, use it
for anything reading-heavy. `worker` (Sonnet) for building and fixing. A stronger model only when the user
asks or a cheaper attempt failed its check twice. The user's routing preferences live in memory:
`mem search "which model sub-agent"`.

**1. Write the brief** — a contract, not a wish:

    mem job new --project <slug> --title "<short title>" --agent scout|worker <<'EOF_TASK'
    ## Goal            the outcome, in a sentence or two
    ## Non-goals       what must not be attempted
    ## Must not change behavior, APIs and files that have to stay as they are
    ## Check           the command that proves it worked, and what passing looks like — or why there is none
    ## Report          what you need back beyond the standard report
    EOF_TASK

The project's rules, gotchas and commands are added from memory for you.

**2. Start it** with the sub-agent the command names and exactly the `JOB:` line it prints. Independent jobs
go in the same turn so they run in parallel.

**3. Read the result:** a STATUS line and one line per file changed. The full report is on disk
(`mem job show <id>`) — open it only if you need more. Run the Check yourself before calling it done.
No STATUS line → the job was never closed: close it with what the sub-agent told you,
`mem job finish <id> --status DONE|FAILED`.

**`NEEDS_INPUT`.** `mem job show <id>` for the question → `mem search`, the user may have answered it
before → only if memory has nothing, ask the user once → `mem job answer <id>` (answer on stdin) and
resume the sub-agent as that command tells you.

**A job from an earlier session** (listed at session start): `mem job show <id>`. Worth finishing → a fresh
sub-agent with the same `JOB:` line continues from the notes and answers in its brief. Not worth it →
`mem job abandon <id>`.
