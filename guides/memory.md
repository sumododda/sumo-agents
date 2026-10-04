# Memory

Everything the user has told any session on this machine, behind `sumo`. You read it; a background
writer (a cheap model, checked by code) files what the user says after each turn.

**Reading**
- `sumo search "<words>" [--project <slug>]` — ranked one-line results. Scope is global plus the named
  project; other projects show only a count. "nothing in memory" is an answer: say you don't know.
- `sumo search "<words>" --turns` — what the user literally typed, when the wording matters.
- `sumo show <id>` full text · `sumo history <id>` what it replaced and what replaced it.

**Writing — only when the user asks you to remember something**
- `sumo add preference|fact|decision|gotcha "<one sentence>" [--project <slug>] [--topic <word>]`
- It lists similar memories. If the new one replaces one: `sumo supersede <old-id> <new-id>`.
  Never leave two memories that disagree.
- `sumo forget <id>` stops it being true (history kept). `--purge` erases it and the sentence it came from.

**Guesses.** Anything the writer could not tie to the user's exact words waits as a question in the
session-start block. Ask the user in one line, then `sumo confirm <id>` or `sumo reject <id>`.
The user can do the same, and edit or forget, on a page: `/memory` in the chat, or `sumo memory`.

**If the block warns that the writer is failing:** tell the user, run `sumo scribe status`. While
`sumo config scribe.model` is `off`, save durable statements yourself with `sumo add` as they are made.
