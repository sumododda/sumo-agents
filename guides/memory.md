# Memory

Everything said in any session on this machine, behind `sumo`: a journal of the user's turns and sumo's
replies, kept whole, and the memories made from it. One background pass (a cheap model, checked by code)
reads a finished conversation and files only what it finds in the user's exact words.

**Reading**
- `sumo search "<words>" [--project <slug>]` — one search: memories first (`m12`), then the conversations
  (`t481` you said, `r3` sumo said). All the words first, then any. Scope is global plus the named project;
  others show only a count. "nothing in memory" is an answer: say you don't know. A "loose match" is not one.
- `--turns` — only the conversations, when the wording matters.
- `sumo show <id>` any of those whole · `sumo history <id>` what a memory replaced and what replaced it.

**Writing — only when the user asks you to remember something**
- `sumo add preference|fact|decision|gotcha "<one sentence>" [--project <slug>] [--topic <word>]`
- It lists similar memories. If the new one replaces one: `sumo supersede <old-id> <new-id>`.
  Never leave two memories that disagree.
- `sumo forget <id>` stops it being true (history kept). `--purge` (the user's alone) erases it and
  every turn and reply that says it whole.

**Held for the user.** The pass keeps no guess. Two things wait as a question in the session-start block:
what a conversation read from the web or an MCP server (only the user confirms: `/memory`, or `sumo
confirm <id>` in their terminal), and a `sumo add` of yours they never typed (ask in one line; on
their yes, `sumo confirm <id>`). `sumo reject <id>` drops either.

**Upkeep**
- `sumo memory status` — if the block warns that memory is failing or not hearing, tell the user and run it.
- `sumo memory check` — tests the indexes, the backup, and that the newest turn is findable.
- `sumo memory rebuild --dry-run` — re-reads the journal with the current extractor and shows what would change.
- `sumo memory eval` — scores search and the extractor on the user's own history.
- `sumo memory run --tidy` when asked to tidy; say what it raised. While `memory.model` is `off`, save
  durable statements yourself with `sumo add`.
