export const STOPWORDS = new Set(
  `a an and are as at be but by do does for from has have how i if in into is it its me my no not of
   on or our so that the their them then there these this to us was we what when where which who why
   will with you your`.split(/\s+/),
);

/** Lowercased content words of a text, in order, duplicates kept. */
export function words(text) {
  const all = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const kept = all.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  // A query made only of stopwords still has to search for something.
  return kept.length > 0 ? kept : all;
}

/**
 * An FTS5 MATCH expression: every word quoted (so nothing the user types is
 * read as query syntax) and OR-ed, leaving the ordering to BM25. AND is too
 * strict for a question phrased in different words than the memory was.
 */
export function ftsQuery(text) {
  const unique = [...new Set(words(text))];
  return unique.map((w) => `"${w.replaceAll('"', '""')}"`).join(' OR ');
}

/**
 * Crude suffix stripping, for judging whether two short texts are about the
 * same thing. The index itself uses SQLite's porter stemmer.
 * The final "e" goes last, so "create", "creates", "created" and "creating" all meet at "creat".
 */
export function stem(word) {
  let out = word;
  if (out.length > 5 && out.endsWith('ing')) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith('ed')) out = out.slice(0, -2);
  else if (/(ss|x|z|ch|sh)es$/.test(out)) out = out.slice(0, -2); // classes, fixes, pushes — but not uses, cases
  else if (out.length >= 3 && out.endsWith('s') && !out.endsWith('ss')) out = out.slice(0, -1); // PRs → pr
  return out.length > 3 && out.endsWith('e') ? out.slice(0, -1) : out;
}

/** Share of the smaller text's stems also found in the other: 0..1. */
export function overlap(a, b) {
  const sa = new Set(words(a).map(stem));
  const sb = new Set(words(b).map(stem));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / Math.min(sa.size, sb.size);
}

/** How many distinct stems two texts have in common. */
export function sharedStems(a, b) {
  const sb = new Set(words(b).map(stem));
  return [...new Set(words(a).map(stem))].filter((s) => sb.has(s)).length;
}

/**
 * Deliberately a heuristic: an exact count needs a tokenizer, and these numbers
 * only have to keep a generated block under its budget.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/** The first `max` units of a text, less half a character: a cut inside an emoji leaves a lone surrogate, which no API takes. */
/** How long something took or has run, for a line of the screen or of numbers: `42s`, `3m 05s`. */
export function elapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function head(text, max) {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${head(flat, max - 1)}…`;
}

/** Words that mark a sentence as a standing instruction, which is worth filing right away rather than in the next batch. */
const DURABLE = /\b(always|never|from now on|going forward|remember|don'?t ever|i (prefer|like|want(?! to\b)|hate|use)|we (use|moved|switched|decided)|make sure|by default|every time|stop (doing|using))\b/i;

export const looksDurable = (text) => DURABLE.test(text);

/**
 * A clause that asks for work or an answer — describe this, fix that, delegate, a question — rather than stating
 * something. Only verbs that are almost never a standing rule: "write tests first" or "keep answers short" are rules.
 * The words people open an order with (ok, lets, so) do not hide it, and "I want to …" is the next piece of work.
 */
const OPENERS = /(?:(?:please|pls|now|then|also|and|so+|ok|okay|yes|yeah|yep|na+h|just|lets|let's|let\s+us)[\s,]+)*/.source;
const VERBS = /describe|explain|delegate|fix|find|investigate|look\s+(?:at|into|for)|show\s+me|tell\s+me|give\s+me|summari[sz]e|debug|continue|research|install|spawn|implement|proceed|resume|redeploy|restart|rerun|retry|go\s+ahead|carry\s+on|try\s+again|(?:can|could|would|will)\s+you|i\s+(?:want|need|would\s+like|'d\s+like)\s+to/.source;
/** What marks an order as one for now, whatever its verb: "not … yet" holds something for the moment, "let me know" asks for an answer. */
const FOR_NOW = /\b(?:not|n't|dont|don't)\b[^.!?\n]*\byet\b|\b(?:lmk|let\s+me\s+know)\b/.source;
const REQUEST = new RegExp(`(?:^|[.,:;!?)]\\s+|\\n\\s*)${OPENERS}(?:${VERBS})\\b|\\?\\s*$|${FOR_NOW}`, 'im');

/** Words that ask for work or an answer and state nothing that lasts: nothing in them is a memory. */
export const asksForWork = (text) => REQUEST.test(String(text ?? '')) && !looksDurable(String(text ?? ''));
