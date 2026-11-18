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

/** Han, Hiragana, Katakana and Hangul: scripts whose words run on into the next, or into what is joined to them. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The same words as an expression that wants every one of them (AND): what a search tries first, `ftsQuery` being what
 * it falls back on. Words in Chinese, Japanese or Korean are left out — the index keeps a run of them as one word, so
 * the caller looks for those in the text itself (`cjkTerms`). Empty when no other word is left.
 */
export function ftsAllQuery(text) {
  const unique = [...new Set(words(text))].filter((w) => !CJK.test(w));
  return unique.map((w) => `"${w.replaceAll('"', '""')}"`).join(' AND ');
}

/**
 * The words of a search in Chinese, Japanese or Korean. The index keeps a run of such characters as one word —
 * "日本語のテスト" is a single token — so a word inside it is never matched there; these are looked for in the text
 * itself. Read alike from what was typed or from `ftsQuery`'s expression, which quotes the same words.
 */
export const cjkTerms = (text) => [...new Set(words(text))].filter((w) => CJK.test(w));

/** A LIKE pattern for `term` anywhere in a text, LIKE's own characters taken as themselves (with ESCAPE '\'). */
export const containing = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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

/**
 * Share of `text`'s own stems also found in `source`: 0..1. Not `overlap`, which takes the smaller text's share: a
 * long sentence is not about a three-word one because those three words are in it.
 */
export function coverage(text, source) {
  const its = new Set(words(text).map(stem));
  const theirs = new Set(words(source).map(stem));
  if (its.size === 0) return 0;
  let shared = 0;
  for (const s of its) if (theirs.has(s)) shared++;
  return shared / its.size;
}

/** How much of what a memory says must be in the user's own words for it to be theirs. */
const SAID_SHARE = 0.8;
/**
 * The words that turn a rule round: "never" is not "always", "don't" is not "do". Only a negation counts: an "always"
 * a model adds to what was said changes how firmly, never which way.
 */
const NEGATION = /\b(?:never|not|no|none|avoid|without|cannot|dont|doesnt|didnt|wont|cant|isnt|arent|shouldnt|mustnt)\b|\b\w+n['’]t\b/i;
/** A trailing "…, not B" or "…, never B", B a word or three: the alternative a statement is chosen over. */
const ALTERNATIVE = /[,;]\s*(?:but\s+)?(?:not|never)\s+([\w.@/+-]+(?:\s+[\w.@/+-]+){0,2})\s*\.?\s*$/i;
/** Whether a text sets `alt` aside itself: moved "from" it, chose "instead of", "rather than" or "over" it, or said "not" it. */
const setsAside = (text, alt) => {
  const said = alt.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`\\b(?:from|instead of|rather than|over|not|never|no)\\s+(?:the\\s+)?${said}\\b`, 'i').test(text);
};
/** The text without its trailing alternative, when the other text sets that alternative aside too. */
const withoutAlternative = (text, other) => {
  const m = ALTERNATIVE.exec(text);
  return m && setsAside(other, m[1].replace(/\.+$/, '')) ? text.slice(0, m.index) : text;
};
/** "on" or "off" as a switch's state — turned on, kept off, "is off" ending its clause — never the "on" of "on fridays". */
const switched = (state) =>
  new RegExp(`\\b(?:turn(?:ed|s|ing)?|switch(?:ed|es|ing)?)\\s+(?:[\\w-]+\\s+){0,3}?${state}\\b|\\b(?:is|are|be|stays?|left|leave|keeps?|kept)\\s+(?:[\\w-]+\\s+){0,3}?${state}\\b(?=\\s+(?:in|by|for|at|when|while|during|everywhere)\\b|\\s*[,.;!?]|\\s*$)`, 'i');
/**
 * Words that turn a rule round with no negation between them: "disabled" filed from "enabled" is as much the opposite
 * as "never" from "always" (an independent review, Nov 18 2026, filed each of these from the user's own quote).
 */
const OPPOSITES = [
  [/\benabl(?:e|es|ed|ing)\b/i, /\bdisabl(?:e|es|ed|ing)\b/i],
  [/\b(?:allow(?:s|ed|ing)?|permit(?:s|ted|ting)?)\b/i, /\b(?:forbid(?:s|den|ding)?|prohibit(?:s|ed|ing)?|disallow(?:s|ed|ing)?|block(?:s|ed|ing)?)\b/i],
  [/\bbefore\b/i, /\bafter\b/i],
  [/\badd(?:s|ed|ing)?\b/i, /\bremov(?:e|es|ed|ing)\b/i],
  [switched('on'), switched('off')],
];
/** Whether one text holds one side of a pair and the other text only the other side: both sides in one text is no turn. */
const opposite = (a, b) =>
  OPPOSITES.some(([one, other]) => {
    const [a1, a2, b1, b2] = [one.test(a), other.test(a), one.test(b), other.test(b)];
    return (a1 && !a2 && b2 && !b1) || (a2 && !a1 && b1 && !b2);
  });

/** A text's words with what a name or a version is written with kept in them: `3.12`, `feature/login`, `node-22`. */
const named = (text) => (text.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_./+-]*/gu) ?? []).map((w) => w.replace(/[./+-]+$/, ''));
const DETERMINERS = new Set(['the', 'a', 'an', 'our', 'my', 'your', 'their']);
/**
 * The values a text names where one can be told from prose: the word before "branch", a word with a digit (with the
 * word before it — "node 22"), and what is used ("uses pnpm"). Narrow on purpose: a synonym elsewhere is a paraphrase.
 */
function valuesNamed(text) {
  const all = named(text);
  const out = { branch: [], version: [], tool: [] };
  all.forEach((w, i) => {
    if (w === 'branch' && i > 0 && !STOPWORDS.has(all[i - 1])) out.branch.push({ value: all[i - 1], after: '' });
    if (/\d/.test(w) && i > 0) out.version.push({ value: w, after: stem(all[i - 1]) });
    if (/^us(?:e|es|ed|ing)$/.test(w)) {
      let next = i + 1;
      while (DETERMINERS.has(all[next])) next++;
      if (all[next] && !STOPWORDS.has(all[next])) out.tool.push({ value: all[next], after: '' });
    }
  });
  return { all: new Set(all.map(stem)), ...out };
}
/**
 * Whether `a` names a branch, a version or a tool that `b` nowhere holds, where `b` names another: "the release
 * branch" from "the main branch", "node 20" from "node 22", "uses npm" from "uses pnpm". A value `b` holds anywhere is
 * the user's own — "uses bun" from "we moved from pnpm to bun".
 */
function namesAnother(a, b) {
  const [its, theirs] = [valuesNamed(a), valuesNamed(b)];
  return ['branch', 'version', 'tool'].some((kind) => its[kind].some((v) => !theirs.all.has(stem(v.value)) && theirs[kind].some((t) => t.after === v.after)));
}

/**
 * Whether two texts say a thing the same way round: both negate it, or neither does. "slate uses bun, not pnpm" from "we
 * moved from pnpm to bun" is not a turn — the "not" sets aside what they moved from; "never force-push" is, from "force-push
 * freely", which set nothing aside. Nor is it the same way round when one says the opposite in a word (`OPPOSITES`) or
 * names another value (`namesAnother`). `aside` is the whole of what was said, when `b` is only part of it: where
 * `a`'s alternative and the values it names are looked for.
 */
export const sameWayRound = (a, b, aside = b) => {
  const [said, typed] = [withoutAlternative(a, aside), withoutAlternative(b, a)];
  return NEGATION.test(said) === NEGATION.test(typed) && !opposite(said, typed) && !namesAnother(a, aside);
};

/**
 * Whether what the user typed says what a memory says: nearly all of the memory's own words are in theirs — not a
 * few of theirs inside much they never said — and it says it the same way round, never for always, don't for do.
 */
export function saysAs(memory, typed, share = SAID_SHARE) {
  const theirs = new Set(words(typed).map(stem));
  const its = [...new Set(words(memory).map(stem))];
  if (its.length === 0) return false;
  const covered = its.filter((w) => theirs.has(w)).length / its.length;
  return covered >= share && sameWayRound(memory, typed);
}

/** How many distinct stems two texts have in common. */
export function sharedStems(a, b) {
  const sb = new Set(words(b).map(stem));
  return [...new Set(words(a).map(stem))].filter((s) => sb.has(s)).length;
}

/**
 * How many of a search's distinct words a text holds: by stem, and for a Chinese, Japanese or Korean word by its
 * characters anywhere in the text, as it is searched.
 */
export function termsHeld(query, text) {
  const lower = text.toLowerCase();
  const stems = new Set(words(text).map(stem));
  return [...new Set(words(query))].filter((w) => (CJK.test(w) ? lower.includes(w) : stems.has(stem(w)))).length;
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

/** Words that mark a sentence as a standing instruction: whatever else it does, it is not only a request for work. */
const DURABLE = /\b(always|never|from now on|going forward|remember|don'?t ever|i (prefer|like|want(?! to\b)|hate|use)|we (use|moved|switched|decided)|make sure|by default|every time|stop (doing|using))\b/i;

const looksDurable = (text) => DURABLE.test(text);

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

/** Verbs that change something. Aimed at one thing now, they ask for work; with a condition they are a rule. */
const CHANGES = new Set(['make', 'change', 'rename', 'update', 'add', 'remove', 'delete', 'move', 'refactor', 'create', 'build', 'run', 'deploy', 'bump', 'revert', 'undo', 'turn', 'fix']);
/** Verbs that are almost always one change, now: a rule seldom renames, deletes or undoes. */
const NOW_ONLY = new Set(['rename', 'delete', 'undo', 'revert']);
const POINTING = new Set(['it', 'this', 'that', 'these', 'those']);
/** What makes a change a rule: when it happens, or to what, every time. */
const CONDITION = /\b(?:before|after|when|whenever|each|every|unless|always|never|by default)\b/i;
/** Asking for an answer, or saying what the work is now — wherever in the sentence it comes. */
const ANSWER_OR_SWITCH = /\b(?:tell|show|give)\s+me\b|\bcheck\s+(?:if|whether)\b|^(?:switching|switch|moving|going)\s+(?:to|over\s+to)\b|^(?:back|now)\s+(?:on|to)\b|^(?:work|get\s+back)\s+on\b/i;
const LEADING = /^(?:(?:please|pls|now|then|also|and|so+|ok|okay|yes|yeah|yep|just|actually|lets|let's)[\s,]+)+/i;

/**
 * A change to one thing, now — "make the button blue", "deploy it", "rename the config file" — whose result lives in
 * the code, not in memory. Read narrowly, because a rule lost is lost silently: a change verb aimed at it/this/that, a
 * change to "the X" in four words or fewer, or a rename, delete or undo; never with a condition ("run the tests before
 * pushing"), and never a longer "the" sentence, which reads the same as a rule ("make the commit messages imperative").
 */
function oneChange(sentence) {
  const words = sentence.replace(LEADING, '').replace(/[.!?,;:]+$/, '').trim().toLowerCase().split(/\s+/);
  if (!CHANGES.has(words[0]) || CONDITION.test(sentence)) return false;
  return POINTING.has(words[1]) || NOW_ONLY.has(words[0]) || (words[1] === 'the' && words.length <= 4);
}

/** Words that ask for work or an answer and state nothing that lasts: nothing in them is a memory. */
export const asksForWork = (text) => {
  const said = String(text ?? '');
  if (looksDurable(said)) return false;
  const sentences = said.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  return REQUEST.test(said) || sentences.some((x) => oneChange(x) || ANSWER_OR_SWITCH.test(x.replace(LEADING, '')));
};

/** Words that agree, thank or wave on, and nouns that only stand for something said before: none of them is what a sentence is about. */
const EMPTY_WORDS = new Set(
  `ok okay yes yeah yep yup sure please pls thanks thank good great fine nice cool perfect right agreed sounds sound looks look seems
   works go ahead just well plan idea approach option suggestion proposal thing way one same lets let`.split(/\s+/),
);
/** Words that point at something said elsewhere. */
const POINTS = /\b(?:it|this|that|these|those|them|so|same)\b/i;
/** A sentence whose whole statement is approval. */
const APPROVES = /\b(?:sounds?|looks?|seems?)\s+(?:good|great|fine|right|ok|okay|perfect|nice)\b|\bworks\s+for\s+me\b|\b(?:that|it|this)(?:'s|\s+is)\s+(?:good|great|fine|right|ok|okay|perfect)\b/i;

/**
 * Whether a sentence says something by itself, so it can be a memory when stored as typed. "ok that plan sounds
 * good", "yes do that always" and "use it" are the user's words and say nothing: what they agree to or point at was
 * said by someone else. Not so when nothing is left once the words of agreement are taken out, when what is left is
 * under three words beside a pointing word, or when the sentence only approves and gives no rule of its own. A short
 * rule stands: "no emojis", "never push to main".
 */
export function standsAlone(sentence) {
  const content = new Set(words(sentence).filter((w) => !STOPWORDS.has(w) && !EMPTY_WORDS.has(w)).map(stem));
  if (content.size === 0) return false;
  if (content.size < 3 && POINTS.test(sentence)) return false;
  return !(APPROVES.test(sentence) && !looksDurable(sentence));
}

/**
 * The known name a mistyped one was most likely meant to be: two edits away at most, nearer than any other, and with
 * at least half of what was typed kept — `m` is no guess at `mcp`, nor `xml` at `md`; `serch` is at `search`.
 */
export function closest(typed, names) {
  const distance = (a, b) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
      row = next;
    }
    return row[b.length];
  };
  const ranked = [...new Set(names)].map((name) => ({ name, d: distance(String(typed).toLowerCase(), name) })).sort((x, y) => x.d - y.d);
  return ranked[0] && ranked[0].d <= 2 && ranked[0].d <= Math.floor(String(typed).length / 2) ? ranked[0].name : null;
}
