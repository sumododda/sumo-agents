---
description: Review a change with fresh eyes — a reviewer that did not write it, reading only the diff
---
Review this: $ARGUMENTS

Code written in this session is never reviewed in this session. Start a reviewer:
`mem job new --project <slug> --agent reviewer --title "<what>" [--reviews <job id>]` — with no `--reviews` it judges
whatever is uncommitted. Put what was asked for on stdin: the review is against that, not against taste.
When it reports, guides/review.md ("Receiving a review") says how to treat the findings.
