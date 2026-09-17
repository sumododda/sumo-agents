# Memory

Everything the user has told any session on this machine, behind `mem`. You read it; a background
writer (a cheap model, checked by code) files what the user says after each turn.

**Reading**
- `mem search "<words>" [--project <slug>]` — ranked one-line results. Scope is global plus the named
  project; other projects show only a count. "nothing in memory" is an answer: say you don't know.
- `mem search "<words>" --turns` — what the user literally typed, when the wording matters.
- `mem show <id>` full text · `mem history <id>` what it replaced and what replaced it.

**Writing — only when the user asks you to remember something**
- `mem add preference|fact|decision|gotcha "<one sentence>" [--project <slug>] [--topic <word>]`
- It lists similar memories. If the new one replaces one: `mem supersede <old-id> <new-id>`.
  Never leave two memories that disagree.
- `mem forget <id>` stops it being true (history kept). `--purge` erases it and the sentence it came from.

**Guesses.** Anything the writer could not tie to the user's exact words waits as a question in the
session-start block. Ask the user in one line, then `mem confirm <id>` or `mem reject <id>`.

**If the block warns that the writer is failing:** tell the user, run `mem scribe status`. While
`mem config scribe.model` is `off`, save durable statements yourself with `mem add` as they are made.
