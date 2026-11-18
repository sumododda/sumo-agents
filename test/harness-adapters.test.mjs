import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runExternal } from '../probes/harness-adapters.mjs';
import { scoreWork, seed } from '../probes/coding-eval.mjs';
import { TASKS } from '../probes/coding-eval-tasks.mjs';

function fixture(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-adapter-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const task = TASKS.find((fixture) => fixture.id === 'who-calls');
  seed(task, dir);
  const bin = join(dir, 'test-cli.cjs');
  writeFileSync(bin, '#!' + process.execPath + '\n' + "if(process.argv.includes('--help')){console.log('--print --safe-mode --strict-mcp-config --no-session-persistence --model --effort --max-budget-usd --permission-mode --allowedTools --tools --output-format --provider --no-cache --mode --json --yes');process.exit(0)}\n" + script, { mode: 0o700 });
  return { dir, task, route: { model: 'sonnet', effort: 'medium' }, budgetUsd: 0.25, claudeBin: bin, siblingBin: bin, timeoutMs: 5000 };
}

test('Claude Code gets the pinned model, effort, and spend cap; a false DONE is detectable by the shared scorer', async (t) => {
  const input = fixture(t, `require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ type:'result', subtype:'success', is_error:false, result:'STATUS: DONE\\nCALLERS: wrong', total_cost_usd:0.03, num_turns:2, modelUsage:{'claude-sonnet-5-5':{}} }));`);
  const result = await runExternal('claude-code', input);
  assert.equal(result.status, 'done');
  assert.equal(result.costUsd, 0.03);
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.equal(result.effort, 'medium');
  assert.equal(result.requests, null);
  assert.ok(scoreWork(input.task, input.dir, result.report).some((check) => !check.ok));
  const args = JSON.parse(readFileSync(join(input.dir, 'args.json'), 'utf8'));
  for (const [key, value] of Object.entries({ '--max-budget-usd':'0.25', '--model':'claude-sonnet-5-5', '--effort':'medium' })) assert.equal(args[args.indexOf(key)+1],value);
});

test('sibling requires an independent cap and reports actual stage models and unknown effort', async (t) => {
  const oldEndpoint = process.env.SUMO_ENDPOINT_URL;
  delete process.env.SUMO_ENDPOINT_URL;
  t.after(() => { if (oldEndpoint === undefined) delete process.env.SUMO_ENDPOINT_URL; else process.env.SUMO_ENDPOINT_URL = oldEndpoint; });
  const input = fixture(t, `console.log(JSON.stringify({event:'stage_start',stage:'read'}));
    console.log(JSON.stringify({event:'result',status:'done',output:'CALLERS: signIn, renew, restore',stages:[{model:'observed-model'}],cost:[{unit:'usd',amount:0.02}]}));`);
  await assert.rejects(runExternal('sumo-harness', input), /independent/);
  const result = await runExternal('sumo-harness', { ...input, externalCap: true });
  assert.equal(result.status, 'done');
  assert.equal(result.model, 'observed-model');
  assert.equal(result.effort, null);
  assert.equal(result.costUsd, 0.02);
  assert.ok(scoreWork(input.task, input.dir, result.report).every((check) => check.ok));
  process.env.SUMO_ENDPOINT_URL = 'http://127.0.0.1:1';
  const endpoint = await runExternal('sumo-harness', { ...input, externalCap: true });
  assert.equal(endpoint.costUsd, null, 'generic endpoint stage prices are unavailable');
  assert.match(endpoint.routeNote, /model pinned/i);
});

test('CLI failures, missing completion, malformed data, and timeout never count as success', async (t) => {
  for (const [script, status] of [
    ['process.exit(42)', 'failed'],
    ["console.log('unparseable')", 'failed'],
    ["console.log(JSON.stringify({type:'result',subtype:'success',result:'I have a question'}))", 'unknown'],
    ["console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',total_cost_usd:0.25}));process.exitCode=1", 'failed'],
    ["setTimeout(()=>{},30000)", 'failed'],
  ]) {
    const input = fixture(t, script);
    const result = await runExternal('claude-code', { ...input, timeoutMs: script.startsWith('setTimeout') ? 80 : 5000 });
    assert.equal(result.status, status);
    if (script.startsWith('setTimeout')) assert.match(result.stopped, /time/);
    if (script.includes('error_max_budget_usd')) assert.equal(result.costUsd, 0.25);
  }
});
