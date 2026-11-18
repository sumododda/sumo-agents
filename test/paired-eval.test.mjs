import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compare, optionsFor, totalsFor } from '../probes/paired-eval.mjs';

test('each harness gets the same commit, independent working files and its share of the total budget', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'paired-eval-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = optionsFor(['--route', 'sonnet/medium', '--budget-usd', '1', '--task', 'who-calls', '--runs', '2']);
  const commits = [];
  const observed = [];
  async function leg(harness, task, args) {
    assert.equal(task.id, 'who-calls');
    assert.equal(args.budgetUsd, 0.25);
    assert.equal(existsSync(join(args.dir, 'from-previous-leg')), false);
    writeFileSync(join(args.dir, 'from-previous-leg'), harness);
    commits.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.dir, encoding: 'utf8' }).trim());
    observed.push(harness);
    return { status: 'done', stopped: null, passed: harness === 'native', costUsd: harness === 'native' ? 0.05 : null };
  }
  const rows = await compare(options, { root, runNative: (_, task, args) => leg('native', task, args), runOther: leg });
  assert.deepEqual(observed, ['native', 'claude-code', 'claude-code', 'native']);
  assert.deepEqual(commits, rows.map((r) => r.commit));
  assert.equal(new Set(commits).size, 1);
  const [native, claude] = totalsFor(rows);
  assert.deepEqual([native.verified, native.falseDone, native.usdPerVerified], [2, 0, 0.05]);
  assert.deepEqual([claude.verified, claude.falseDone, claude.costUsd, claude.usdPerVerified], [0, 2, null, null]);
});

test('invalid routes, budgets and duplicate participants are rejected before a run', () => {
  const base = ['--route', 'sonnet/medium', '--budget-usd', '1'];
  assert.throws(() => optionsFor([...base, '--harnesses', 'native,native']), /distinct/);
  assert.throws(() => optionsFor([...base, '--runs', '0']), /positive integer/);
  assert.throws(() => optionsFor([...base, '--runs=-1']), /positive integer/);
  assert.throws(() => optionsFor(['--route', 'sonnet/medium', '--budget-usd', 'NaN']), /positive total/);
  assert.throws(() => optionsFor(['--budget-usd', '4']), /model\/effort/);
});
