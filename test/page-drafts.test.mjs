import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Execute the page's actual script with a small DOM, so redraws and failed requests exercise its handlers.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.handlers = {};
    this.value = '';
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.document.activeElement = this; }
  setSelectionRange() {}
}

test('memory edit drafts survive filtering, scope changes and a refused save, and clear on cancel', async () => {
  const document = {
    activeElement: { tagName: 'BODY' },
    addEventListener() {},
    createElement(tag) { return new Element(tag, this); },
  };
  const nodes = new Map(['main', 'summary', 'scopes', 'filter', 'toast'].map((id) => [id, new Element('div', document)]));
  document.getElementById = (id) => nodes.get(id);
  const visit = (node, tag) => node.tagName === tag ? node : node.children?.map((child) => visit(child, tag)).find(Boolean);
  document.querySelector = () => visit(nodes.get('main'), 'TEXTAREA') ?? null;
  const context = createContext({ document, location: { pathname: '/token/' }, window: { addEventListener() {} }, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {} });
  const script = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8').match(/<script nonce="__NONCE__">([\s\S]*)<\/script>/)[1];
  runInContext(script, context);
  runInContext(`ui.data = { projects: [], sections: [['fact', 'Facts']], memories: [{ id: 1, type: 'fact', state: 'active', scope: 'global', provenance: 'stated', valid_from: '2026-10-04', body: 'Original body' }] }; ui.editing = 1; render();`, context);
  const draft = 'Unsaved detailed draft';
  const area = document.querySelector();
  area.value = draft;
  area.handlers.input?.({ target: area });
  nodes.get('filter').handlers.input({ target: { value: '' } });
  assert.equal(document.querySelector().value, draft);
  nodes.get('scopes').children[1].handlers.click();
  assert.equal(document.querySelector().value, draft);
  context.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'not editable' }) });
  await runInContext(`run(1, 'edit', { body: ${JSON.stringify(draft)} }, () => 'Saved')`, context);
  assert.equal(document.querySelector().value, draft);
  const actions = nodes.get('main').children[0].children[2].children[0].children[1];
  actions.children[1].handlers.click();
  runInContext('ui.editing = 1; render()', context);
  assert.equal(document.querySelector().value, 'Original body');
});
