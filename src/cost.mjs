import { MODEL_IDS, MODELS, modelId } from './catalog.mjs';
import { CACHE_WRITE, PRICES } from './model.mjs';
import { getProject } from './projects.mjs';

/**
 * Where the money goes, read from the ledger: every request `model_runs` holds, by the kind of conversation that made it
 * and the model that answered, in dollars and in the four ways a request is paid for — input read fresh, input read from
 * the cache, input written to it, and output. Then the cache rewrites: requests that paid to write their context again
 * while the cache should still have held it. A conversation here is a job, or outside one a chat session, on one model:
 * the advisor answers in the same session on a model of its own, and a cache is never shared between models.
 */

/** A request that read less than this from the cache found next to nothing of its context there. */
const REWRITE_READ_UNDER = 10_000;
/** …and wrote more than this share of its input to the cache again. */
const REWRITE_SHARE = 0.5;
/** How long what is written to the cache lives unread: a request this soon after the one before should have found it. */
const CACHE_LIVES_MS = 5 * 60_000;

const PARTS = ['uncached', 'read', 'write', 'output'];

/** What one request paid for each part, from its tokens and the price list; a model the list does not know splits into nothing. */
function partsOf(row) {
  const price = PRICES[modelId(row.model)];
  if (!price) return { uncached: 0, read: 0, write: 0, output: 0 };
  // The ledger keeps the whole input; what was read fresh is what the cache neither gave nor took.
  const read = row.cache_read_tokens ?? 0;
  const written = row.cache_creation_tokens ?? 0;
  const plain = Math.max(0, (row.input_tokens ?? 0) - read - written);
  return {
    uncached: (plain * price.input) / 1_000_000,
    read: (read * price.input * price.cacheRead) / 1_000_000,
    write: (written * price.input * CACHE_WRITE) / 1_000_000,
    output: ((row.output_tokens ?? 0) * price.output) / 1_000_000,
  };
}

const empty = () => ({ requests: 0, usd: 0, uncached: 0, read: 0, write: 0, output: 0, search: 0 });

function add(into, row, parts) {
  into.requests++;
  into.usd += row.cost_usd ?? 0;
  for (const part of PARTS) into[part] += parts[part];
  // What the tokens do not explain is what a search cost on top of them.
  into.search += Math.max(0, (row.cost_usd ?? 0) - PARTS.reduce((sum, part) => sum + parts[part], 0));
}

/**
 * The ledger's rows, summed: the whole, each kind and model (dearest first), and the cache rewrites — requests that read
 * under 10k from the cache and wrote over half their input to it, under five minutes after the request before in the same
 * conversation. Only a request that answered counts as the one before: a failed one warmed nothing. Pure, so it is tested
 * on rows alone.
 */
export function breakdown(rows) {
  const total = empty();
  const groups = new Map();
  const rewrites = { requests: 0, usd: 0 };
  const last = new Map();
  const ordered = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const row of ordered) {
    const parts = partsOf(row);
    add(total, row, parts);
    const key = `${row.kind}\n${row.model}`;
    if (!groups.has(key)) groups.set(key, { kind: row.kind, model: row.model, ...empty() });
    add(groups.get(key), row, parts);

    const conversation = row.job_id !== null && row.job_id !== undefined ? `j${row.job_id}` : row.session_id ? `s${row.session_id}` : null;
    if (conversation === null || !(row.input_tokens > 0)) continue;
    const thread = `${conversation}\n${row.model}`;
    const at = Date.parse(row.ts);
    const before = last.get(thread);
    last.set(thread, at);
    const read = row.cache_read_tokens ?? 0;
    const written = row.cache_creation_tokens ?? 0;
    if (before !== undefined && at - before < CACHE_LIVES_MS && read < REWRITE_READ_UNDER && written > row.input_tokens * REWRITE_SHARE) {
      rewrites.requests++;
      rewrites.usd += parts.write;
    }
  }
  return { total, groups: [...groups.values()].sort((a, b) => b.usd - a.usd), rewrites };
}

const dollars = (usd) => `$${usd.toFixed(2)}`;
const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const percent = (part, whole) => (whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : '');
/** A model by the name Sumo calls it; a local model or one the list does not know, as the ledger has it. */
const nameOf = (model) => MODELS.find((name) => MODEL_IDS[name] === model) ?? model;

/** The four parts of a sum, and a search when one was paid for; with `of`, each part's share of it. */
function split(sum, of = null) {
  const share = (part) => (of === null ? '' : percent(part, of));
  const parts = [`uncached ${dollars(sum.uncached)}${share(sum.uncached)}`, `cache read ${dollars(sum.read)}${share(sum.read)}`, `cache write ${dollars(sum.write)}${share(sum.write)}`, `output ${dollars(sum.output)}${share(sum.output)}`];
  if (sum.search >= 0.005) parts.push(`search ${dollars(sum.search)}`);
  return parts.join(' · ');
}

/**
 * `sumo cost [--days N] [--project S]`: what the ledger says was spent, the whole first, then each kind and model, then
 * the cache rewrites. A project's spend is its jobs and the chat sessions its card came up in — a session that worked
 * on two projects is counted under each.
 */
export function costLines(db, { days, project } = {}) {
  const slug = project === undefined ? null : getProject(db, project).slug;
  const since = days === undefined ? null : new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT ts, kind, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, job_id, session_id
       FROM model_runs
       WHERE (? IS NULL OR ts >= ?)
         AND (? IS NULL
              OR job_id IN (SELECT id FROM jobs WHERE project = ?)
              OR (job_id IS NULL AND session_id IN (SELECT session_id FROM session_injections WHERE slug = ?)))
       ORDER BY ts, id`,
    )
    .all(since, since, slug, slug, slug);
  const window = days === undefined ? null : `the last ${count(days, 'day')}`;
  if (rows.length === 0) return [`nothing was spent ${window ? `in ${window}` : 'yet'}${slug ? ` on ${slug}` : ''}`];

  const { total, groups, rewrites } = breakdown(rows);
  const share = total.usd > 0 ? `, ${Math.round((rewrites.usd / total.usd) * 100)}% of the total` : '';
  const scope = `${window ?? `since ${rows[0].ts.slice(0, 10)}`}${slug ? ` · ${slug}` : ''}`;
  return [
    `${scope}: ${count(total.requests, 'request')}, ${dollars(total.usd)} — ${split(total, total.usd)}`,
    // A group that cost nothing — the local model's — has nothing to split.
    ...groups.map((g) => `  ${g.kind} · ${nameOf(g.model)}: ${count(g.requests, 'request')}, ${dollars(g.usd)}${g.usd >= 0.005 ? ` — ${split(g)}` : ''}`),
    `cache rewrites: ${count(rewrites.requests, 'request')} read under ${REWRITE_READ_UNDER / 1000}k from the cache and wrote most of their context again, under ${CACHE_LIVES_MS / 60_000} minutes after the request before — ${dollars(rewrites.usd)} of cache writes${share}`,
  ];
}
