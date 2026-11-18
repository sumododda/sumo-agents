import { LOOSE_BELOW, markHits, recordMiss, resolveProject, search } from './memory.mjs';
import { searchJournal } from './sessions.mjs';
import { words } from './text.mjs';

/** How many lines of the conversations follow memories that answered: the memories are the answer, these are where it was said. */
const SAID_AFTER_MEMORIES = 3;
const NONE = { results: [], hits: [], elsewhere: {}, more: 0, best: 0 };

/**
 * The one search: memories first, then the conversations themselves — what the user typed and what sumo answered.
 * Only extracted facts used to be searched, and a topic talked through at length and never made a memory of was a
 * miss. All the words are tried first, across both; only when neither holds them all in scope is any word tried.
 *
 * When memories answer, a few lines of the conversations follow them; when none does, the conversations are the
 * answer and the search is not a miss. A miss is kept when nothing is shown, or when what is shown is `loose`: the
 * search had several words, fell back to any of them, and no line holds two. Memories shown count as used; rows of
 * the conversations carry no such count.
 *
 * `turns` leaves memories out (and keeps no miss: nothing was asked of memory); `type` leaves the conversations out,
 * a type being a kind of memory. `record: false` is a search nobody asked — a replay, a check: nothing shown counts
 * as used and no miss is kept. The rest — `project`, `everywhere`, `all`, `since`, `before`, `limit` — is as
 * `memory.search` has it, and holds for both. Returns `{ memories, conversations, more, moreSaid, elsewhere, loose }`:
 * `more` and `moreSaid` count what matched in scope and was not shown, `elsewhere` what other projects hold, by scope.
 */
export function searchAll(db, query, opts = {}) {
  const slug = opts.project ? resolveProject(db, opts.project) : null;
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 8;
  const { everywhere, since, before } = opts;
  let memories = NONE;
  let said = NONE;
  let fellBack = false;
  for (const terms of new Set(words(query)).size > 1 ? ['all', 'any'] : ['all']) {
    memories = opts.turns ? NONE : search(db, query, { project: opts.project, type: opts.type, all: opts.all, everywhere, since, before, limit, now, terms, record: false });
    said = opts.type ? NONE : searchJournal(db, query, { terms, project: slug, everywhere, since, before, limit: memories.results.length > 0 ? Math.min(limit, SAID_AFTER_MEMORIES) : limit });
    fellBack = terms === 'any';
    if (memories.results.length + said.hits.length > 0) break;
  }
  const shown = memories.results.length + said.hits.length;
  const loose = fellBack && shown > 0 && Math.max(memories.best, said.best) < LOOSE_BELOW;
  if (!opts.turns && opts.record !== false) {
    markHits(db, memories.results.map((m) => m.id), now);
    if (shown === 0 || loose) recordMiss(db, query, everywhere ? 'everywhere' : slug ? `project:${slug}` : 'global', now);
  }
  const elsewhere = { ...memories.elsewhere };
  for (const [scope, n] of Object.entries(said.elsewhere)) elsewhere[scope] = (elsewhere[scope] ?? 0) + n;
  return { memories: memories.results, conversations: said.hits, more: memories.more, moreSaid: said.more, elsewhere, loose };
}
