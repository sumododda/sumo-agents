# Projects

A project is a directory somewhere on this machine, registered once.

**First mention of something you don't know**
1. `mem project list` — maybe it has another name.
2. Find it on disk (the user's home, one or two levels deep). Several candidates → ask which.
3. Confirm the path with the user once, then
   `mem project add <path> --alias <what the user calls it>` (repeat `--alias` for each name).
   It scans the repo — stack, commands, its own instruction files, index — and prints the project card.
4. Do what the last line says (`/add-dir <path>`) so this session may edit there.

**Working in one**
- The card arrives by itself the first time the user names the project. Otherwise `mem project show <slug>`.
- The card's first lines are instructions: if it says the repo has its own CLAUDE.md or AGENTS.md, read
  that before editing; if it says the repo is indexed, locate code through the index first.
- Use the commands on the card. Don't guess a test command the card already gives you.
- The repo changed shape (new package manager, new test runner) → `mem project rescan <slug>`.

`mem project alias <slug> <name>` adds a name · `mem project archive <slug>` retires one (memories kept).
