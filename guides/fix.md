# Fix

1. What changed recently? `git log -5`, `git diff` — most bugs arrive with a change.
2. Make it fail on demand, as small as it will go. It will not fail → say so and stop; a fix for a bug nobody can see proves nothing.
3. Find *where* it breaks before saying *why*. Several parts involved → print what goes in and what comes out at each boundary, run once, read where it goes wrong. A bad value deep in a stack → follow it back to where it was made.
4. Find similar code that works, and list every difference.
5. One cause at a time, each with its evidence: a file:line or a line of output. The evidence supports none → say that; never guess. Not obvious → rank the candidates, name what would confirm each, test the top one.
6. Fix where it starts, not where it shows. Tests already here are evidence: add one, never edit one.
7. The reproduction from step 2 passes now; then the project's own checks. A test written after the fix proves nothing until it has been seen failing — undo the fix once and watch.
8. An attempt failed → undo it before the next, so failures never pile up on each other.
9. The same mistake elsewhere? List the places. Do not fix them here.
