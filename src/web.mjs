/**
 * The web, as the API's own tools: a search and a page fetch that run on Anthropic's side, inside the request. Nothing is
 * run here — the call and what came back are blocks of the reply, and go back with the conversation exactly as they came:
 * a result's encrypted content is what the API reads it from on the next turn.
 *
 * Called directly. Left to their default the current versions are run from code the model writes to filter what comes
 * back, and that code is refused (`too_many_requests`) on a Claude Code token; called directly they work on every model
 * here, haiku included, so one definition serves them all and a conversation can change models with searches in it.
 */

/** The most of one page that reaches the context: a large documentation page whole, a book's worth cut. A PDF is not counted this way and comes whole. */
const PAGE_TOKENS = 20_000;

export const WEB_SEARCH_TOOL = { type: 'web_search_20260318', name: 'web_search', allowed_callers: ['direct'] };
export const WEB_FETCH_TOOL = { type: 'web_fetch_20260318', name: 'web_fetch', allowed_callers: ['direct'], max_content_tokens: PAGE_TOKENS };
export const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

/** US dollars for one search, on top of the tokens of what it found; a fetch costs its tokens only. */
export const SEARCH_USD = 0.01;

const isWebName = (name) => name === WEB_SEARCH_TOOL.name || name === WEB_FETCH_TOOL.name;
export const isWebCall = (block) => block.type === 'server_tool_use' && isWebName(block.name);
export const isWebResult = (block) => block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result';
/** A call by its name alone, for the screen: a search or a fetch, wherever it ran. */
export const isWebTool = (call) => isWebName(call.name);

/** What a search or a fetch came back with, said as any tool's result is: the pages found, or the page read and its size; a failure by its code. */
export function webResult(block) {
  const got = block.content;
  if (block.type === 'web_search_tool_result') {
    // Found, it is a list; failed, one object with the code.
    if (!Array.isArray(got)) return { content: `search failed: ${got?.error_code ?? 'no reason given'}`, isError: true };
    return { content: got.length === 0 ? 'nothing found' : got.map((r) => `${r.title} — ${r.url}`).join('\n'), isError: false };
  }
  if (got?.type !== 'web_fetch_result') return { content: `fetch failed: ${got?.error_code ?? 'no reason given'}`, isError: true };
  const source = got.content?.source;
  const size = source?.type === 'text' ? `${source.data.length} characters` : (source?.media_type ?? 'a document');
  return { content: `${got.content?.title ?? got.url} — ${size}`, isError: false };
}

/** The pages a reply cites, each once, in the order it cites them. */
export function sourcesOf(content) {
  const pages = new Map();
  for (const block of content) {
    if (block.type !== 'text') continue;
    for (const cite of block.citations ?? []) if (cite.url && !pages.has(cite.url)) pages.set(cite.url, { title: cite.title ?? cite.url, url: cite.url });
  }
  return [...pages.values()];
}
