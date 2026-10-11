# Skills for Sumo — plan

Status: **built 2026-10-10, with the changes in section 15.** Written 2026-10-10 for review; sections 1–14 are
the plan as reviewed, section 15 what was decided and built.

## 1. What this is

Sumo ships a small set of skills: short written ways of doing a kind of work. Code notices when one applies
and hands it to the model, in the chat and in delegated jobs. Nothing about skills is in the context until one
fires.

It is our own design. No superpowers code or text is used.

## 2. Why

**The guides exist and are almost never used.** From your own Sumo session logs:

| | Count |
|---|---|
| Stored user turns | 398 |
| Turns that read like a fix / feature / review / plan | about 58 / 74 / 31 / 35 |
| Slash commands typed (`/fix`, `/feature`, `/review`) | 0 |
| Times the model read `fix.md` / `feature.md` / `review.md` | 0 / 2 / 0 |
| Times the model read `delegation.md` | 8, a tool call each |

The work the guides describe happens daily; the guides reach the model about never. `AGENTS.md` tells the
model to go and read them, and it does not.

**What superpowers costs for the same idea** (sizes are characters / 4, from the cloned repo):

| | superpowers | this plan |
|---|---|---|
| Every session, before any work | about 800 tokens | 0 |
| One skill, when used | about 750 to 8,100 tokens, plus a tool call to load it | at most 550 tokens, no tool call |
| Who decides a skill applies | the model, each turn | code |

**Evidence for short skills:** in SkillsBench, compact skills gained 19.0 points and comprehensive ones 0.7;
one to three skills together beat four or more; skills a model wrote for itself scored below none.

## 3. What a skill is

- One markdown file in `skills/`, with a three-line header and numbered steps:

  ```
  ---
  name: fix
  when: fix, bug, broken, failing, crash, error, regression, "doesn't work"
  ---
  1. Reproduce it: …
  ```

- At most 550 tokens, checked by `test/standing.test.mjs`, the same test that holds the guides today.
- No rule is said twice: the same test already refuses a guide that repeats `AGENTS.md`, and it will cover
  `skills/` too.

## 4. The five skills

| Skill | Text comes from | Fires when |
|---|---|---|
| `fix` | `guides/fix.md` as it is (about 300 tokens) | your message asks to fix something broken |
| `feature` | `guides/feature.md` as it is (about 355 tokens) | your message asks to build or add something |
| `review` | `guides/review.md` as it is (about 455 tokens) | your message asks to review or audit |
| `plan` | new, written from scratch | a large or vague ask: design, rewrite, "how should we" |
| `verify` | new, written from scratch | not by words — see section 6 |

`plan` and `verify` are short on purpose. `AGENTS.md` already says "plan first" and "no passing check → not
done"; these two say *how*, not *that*.

## 5. Detection

**Recommended: plain code, measured by a probe set.**

- The prompt hook (`src/hooks.mjs`, called each turn from `src/chat.mjs`) already matches your taught
  workflows against your message by word stems (`claim` in `src/workflows.mjs`). Skills are matched in the
  same place.
- One difference: a taught workflow fires when *all* its cue words are present; a skill fires when *any one*
  of its `when` cues is. So skills need their own small matcher beside `cueMatches`, not a reuse of it.
- A question about code ("how does the router pick a model?") fires nothing.
- No model call, no added delay, no tokens.

The other two options, for comparison:

| Option | Delay per turn | Likely accuracy | Cost |
|---|---|---|---|
| Plain code, measured (recommended) | none | good on `fix` / `feature` / `review`, weakest on `plan` | none |
| Local 4B model on every turn | about 1 s | better on vague asks | none in money; a second every turn |
| Code first, local model only when unsure | about 1 s on some turns | between the two | more code to keep right |

I have not measured any of these yet. The probe set in section 9 is what turns "likely" into numbers, and the
third option is the fallback if `plan` cannot be matched by words.

## 6. `verify`: fired by what happened

Saying "done" before checking matters at the end of work, whatever the request was, so words in your message
are the wrong trigger. Two ways to fire it:

| Option | When | Cost |
|---|---|---|
| End of turn (recommended) | the turn edited files, no command ran after the last edit, and the model is about to stop | one more request in that turn, at most once per turn |
| With the first edit | the first time a file is edited in a session | about 150 tokens once, no extra request, but it arrives long before "done" |

"A command ran after the last edit" does not prove the work was checked; it is the cheap signal. Jobs already
have a stronger completion check in `src/loop.mjs`; this brings a lighter one to the chat.

## 7. Invocation rules

- A matched skill is added once per session, recorded in `session_injections` like workflows are.
- It goes in as an operator message after your turn, so the cached part of the conversation is untouched.
- At most two skills on one turn.
- Your taught workflows win: when a workflow and a skill match the same message, only the workflow goes in.
- `/fix`, `/feature` and `/review` stay, for when you want to name one yourself.
- A message you send mid-turn is matched too.
- `AGENTS.md` loses the line "Fix, feature or review → read guides/<that>.md first", since code now does it.

## 8. Delegation

- `newJob` (`src/jobs.mjs`) already carries a guide into the brief under "How this kind of work is done
  here", but only when the model passes `guide`, or for reviewers.
- New: when a **worker** job is created with no `guide`, code matches the task text against `fix` and
  `feature` and attaches the one that fits.
- Scouts get none: they read, they do not change anything. Reviewers keep `review`, as now.
- Workers do not get `plan` (the brief is the plan) or `verify` (the job loop already checks completion).
- The `guide` parameter on `delegate` stays as the override, and gains `none`.

## 9. Measurement

1. **Detection probes** — about 40 messages, each labelled with the skill it should fire or "none". Reports
   hits, misses and false alarms. The labels are my judgment; you can correct any.
2. **Coding eval, before and after**, on one pinned route: passes, false DONE, requests, cost. All eight
   tasks pass today, so this shows cost and regressions, not a quality gain. Showing a gain needs harder
   tasks, which are not part of this plan.
3. **Tokens added per session**, from the ledger.

## 10. Seeing and controlling it

- One dim line on the screen when a skill goes in: `skill: fix`.
- `sumo skill list` and `sumo skill show <name>`.
- One config key turns automatic invocation off.

## 11. Build order

Each step starts with its test, seen failing.

1. `skills/` with the header format and a loader; `fix`, `feature`, `review` moved over unchanged; the size
   and no-repeat tests cover the folder; `guideFor` and the slash commands read from it.
2. The matcher in the prompt hook, and the probe set; cues tuned against the probes.
3. `verify`, with its trigger.
4. `plan`, written and probed.
5. Attachment in `newJob`.
6. The screen line, the two CLI commands, the config key, the README.
7. Probe and eval runs, reported with the numbers.

## 12. Risks

- **False alarm:** a skill that fires wrongly costs up to 550 tokens once in that session and may push the
  model into steps the work did not need. The probes measure how often.
- **Miss:** no worse than today.
- **`plan`** is the hardest to detect by words and will need the most tuning, or the fallback in section 5.
- **`verify` at end of turn** adds a request to turns that edit and stop without running anything. If that
  proves noisy, the "first edit" option is the retreat.

## 13. Not in this plan

- A `ship` skill (commit, branch, PR): you left it out.
- Skills you write yourself: `sumo learn` already does this as taught workflows, and they keep precedence.
- `guides/delegation.md`, `memory.md`, `projects.md`, `workflows.md`: they stay guides. They are reference
  pages, not ways of doing a kind of work.
- Harder eval tasks.

## 14. Decisions for you

1. **Detection:** plain code measured by probes (recommended) · local model every turn · code first, model
   when unsure.
2. **`verify` trigger:** end of turn, one extra request (recommended) · with the first edit, no extra request.
3. **Folder:** new `skills/` for the five, `guides/` keeps the four reference pages (recommended) · keep
   everything in `guides/` and add the header to the skill files.
4. **Probe messages:** written by me in the shape of your real ones, safe to commit (recommended) · your real
   stored turns, kept out of the repo.

## 15. What was decided, and built

Reviewed against the code before building. The decisions, where they differ from sections 4–14:

| Plan | Built | Why |
|---|---|---|
| Five skills in a new `skills/` folder, "skill" as the noun | The three guides stay in `guides/`, with a `when:` header; the word stays "guide" everywhere (`--guide`, the `guide` tool parameter, the brief heading) | One noun for one thing; `guideFor`, the CLI, the tool and the README needed no second vocabulary |
| `plan` skill, detected by words or a local model | Dropped. Its cues (design, rewrite, approach, architecture) are on `feature`, whose step 1 already sizes the work and asks for a written design when it is big | It would have repeated `feature.md` and `AGENTS.md`, and it was the only skill that needed the model fallback |
| `verify` skill, fired at end of turn | A gate, not a text: the chat tracks files edited after the project's declared check last ran; at `end_turn` the stop hook states the fact and names the check, and the turn continues once — the path the memory-question gate already used | ~50 tokens that name `npm test` beat 150 that say "verify"; "any command ran after" was fooled by `git status`, "a declared check ran" is not |
| Up to two skills per turn | One, by precedence review > fix > feature | "review my fix" is a review, "fix the broken add button" is a fix; two step lists compete |
| Any one `when` word fires | Each `when` phrase is matched like a workflow cue — all its stems — and any phrase fires | Bare "error" would have fired `fix` on "add error handling" |
| Jobs: match the task text | Match the title and the `## Goal` section only | A five-heading brief nearly always contains "fail" or "add"; the title and goal are the shape of a chat message |
| `/fix` keeps pasting the guide into the message | `/fix`, `/feature`, `/review` name the guide to the prompt hook, which renders it once as an operator message | Otherwise `/fix the login bug` injected it twice: once pasted, once matched on "bug" |
| `sumo skill list` / `show` | Not built | `cat guides/fix.md` does it; the header is the whole format |

Built: `src/guides.mjs` (header, matcher, rendering, the `guides.auto` switch); `src/hooks.mjs` (`guideDue` on the
prompt, `unchecked` on stop); `src/chat.mjs` (edits tracked per turn, the hold, the slash commands, the screen
events); `src/ui.mjs` (`guide: fix`, `held: 2 files edited, npm test not run`); `src/jobs.mjs` (`defaultGuide`,
`--guide none`); `guides/*.md` headers; `AGENTS.md` loses its "read guides/<that>.md" line; README.

Measured: `test/guides.test.mjs` holds 50 probes — 43 right, 7 known wrong and held wrong (three misses with no
cue word, "I want a way to…", "the router picks haiku for everything"; three false alarms, "run the build",
"add this to memory", "review the plan"; one wrong guide, "add error handling" → fix). The coding eval before
and after, on `sonnet/medium`, is run by hand with a credential in the shell: `probes/coding-eval.mjs --route
sonnet/medium --json before.json` on a checkout without this change, the same with `after.json` on one with it,
and the two summary lines compared — passes, false DONE, requests, cost. Of the six worker tasks, the ones whose
title or goal says "fix" or "add" now carry a guide; the rest are unchanged, so the run measures cost and
regressions on those, not a quality gain, as section 9 said.
