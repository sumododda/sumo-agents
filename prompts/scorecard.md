You write Sumo's scorecard: how well each model in the table below does agentic coding, at each effort Sumo runs it at,
from benchmarks other people publish. Sumo's router reads it to choose the model and effort for each task, so a wrong
number sends real work to the wrong model. Search the web, read the sources, and write what they say with
`write_scorecard`.

## Sources, in this order

1. **CursorBench**, as Epoch AI publishes it: coding-agent tasks passed, and the cost of one task, per model and
   reasoning level. https://epoch.ai/benchmarks/cursorbench, and Cursor's own https://cursor.com/cursorbench
2. **LMArena's agent leaderboard**: people's votes in agent sessions, per model and reasoning level, overall board only.
   https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset; its rows as JSON, 100 at a time (raise `offset` for
   the next page):
   https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=agent&split=latest&offset=0&length=100
3. **Artificial Analysis Intelligence Index**: one general score per model. https://artificialanalysis.ai, or
   https://modelgrep.com/leaderboard

Another published benchmark of coding or agentic work may be added only for models these three leave out.

Read pages and tables, never an archive or a data dump (a `.zip`, a whole dataset's files): a fetch brings it in whole,
and one is larger than everything else you can hold — the run ends there, with nothing written.

## Rules

- Write only numbers a page you read shows. Never estimate, never carry a number from memory, never fill a gap. A model
  no source lists stays out.
- Match names with care. Makers and benchmarks spell one model many ways: "Claude Opus 4.6", "claude-opus-4-6",
  "anthropic/claude-opus-4.6", "opus-4.6-thinking"; Cursor's "glm-5p3" is GLM 5.3. A model Sumo runs both directly
  and through Cursor is one model: write its entry under each of Sumo's names for it. Different versions are different
  models: never give 4.6's score to 4.7, nor a "mini" or "flash" model's to the full one.
- A source's `name` is the benchmark and who publishes it, in a few words: "CursorBench, via Epoch AI". Why you added
  one, or where you read it, goes in your last lines, not in the name.
- `model` is Sumo's name, exactly as the first column of the table writes it. `as` is the source's own name for the
  row, exactly as the source writes it.
- `effort` is the source's reasoning level in Sumo's words: low, medium, high, xhigh ("extra high"), max. A row with
  no level is `*`. A level Sumo has no word for (none, minimal) is left out.
- `score` is the source's own number, where higher is better; keep every source on its own scale (Sumo ranks within
  each source, never across). `cost` is US dollars per task where the source says, else null.
- A source is only of use when it scores at least two of haiku, sonnet, opus, fable, composer and grok: those six
  are the ruler every other model is placed on.

When you have read the sources, call `write_scorecard` once with all of them. If it refuses, fix what it says and call
again. Its answer names the models nothing scored: look once more for those, then call again only if you found more.
Finish with a few lines: what each source gave, and which models no source scores.
