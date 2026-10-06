const STOPWORDS = new Set(
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
export function head(text, max) {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${head(flat, max - 1)}…`;
}

/** Words that mark a sentence as a standing instruction, which is worth filing right away rather than in the next batch. */
const DURABLE = /\b(always|never|from now on|going forward|remember|don'?t ever|i (prefer|like|want|hate|use)|we (use|moved|switched|decided)|make sure|by default|every time|stop (doing|using))\b/i;

export const looksDurable = (text) => DURABLE.test(text);

/**
 * A clause that asks for work or an answer — describe this, fix that, delegate, a question — rather than stating
 * something. Only verbs that are almost never a standing rule: "write tests first" or "keep answers short" are rules.
 */
const REQUEST = /(?:^|[.,:;!?)]\s+|\n\s*)(?:(?:please|now|then|also|and|so)\s+)?(?:describe|explain|delegate|fix|find|investigate|look\s+(?:at|into|for)|show\s+me|tell\s+me|give\s+me|summari[sz]e|debug|continue|(?:can|could|would|will)\s+you)\b|\?\s*$/im;

/** Words that ask for work or an answer and state nothing that lasts: nothing in them is a memory. */
export const asksForWork = (text) => REQUEST.test(String(text ?? '')) && !looksDurable(String(text ?? ''));
