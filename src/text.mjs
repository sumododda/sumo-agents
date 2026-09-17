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

/** Shared stems over all stems (Jaccard): 1 only when two texts use the same words. */
export function sameWords(a, b) {
  const sa = new Set(words(a).map(stem));
  const sb = new Set(words(b).map(stem));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
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

export function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
