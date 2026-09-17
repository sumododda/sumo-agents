# Workflows

When the user walks you through how they want something done and will want it again — how a PR gets
created, a release routine, how they start a project — save it once, as steps:

    mem learn "<short title>" --cue "<the action, in plain words>" --gate '<regex>' [--project <slug>] <<'EOF_STEPS'
    1. …
    2. …
    EOF_STEPS

- **`--cue` is how it comes back when the user asks.** Its words are matched against their message:
  `create a PR` arrives with "commit it and create the PR". Two or more plain words, no punctuation.
- **`--gate` is how it comes back when you are about to act without being asked.** A regular expression
  over the shell command; a matching command waits until these steps have been shown. Name every
  command that does the thing, and nothing else: `'gh(-axi)? pr create|glab mr create'`. Leave it
  out only when no command marks the moment — then the cue's words are matched against commands instead,
  which is a guess. Tell the user what you gated. Change it later with `mem gate <id> '<regex>'`.
- Write the steps as you would brief a colleague: commands in backticks, the order that matters, the
  check that proves each step worked. Leave out anything a project's own files already say.
- Project-specific routine → `--project`. The way they do it everywhere → no project.
- When a workflow is handed to you — with a message, or as the reason a command was held back — follow
  its steps exactly and in order, then carry on. Don't improvise from the title.
- They correct a step later → save the corrected version with `mem learn`, then
  `mem supersede <old-id> <new-id>`.
