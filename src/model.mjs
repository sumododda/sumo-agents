import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMeta } from './db.mjs';
import { paths } from './paths.mjs';

const TIMEOUT_MS = 180_000;
const MAX_SPEND_USD = '0.25';

/** The path setup pinned, unless it has since vanished — then whatever PATH offers, which may still be nothing. */
function pinnedOrOnPath(db) {
  const pinned = getMeta(db, 'claude.path');
  if (pinned) {
    try {
      accessSync(pinned, constants.X_OK);
      return pinned;
    } catch {
      // Pinned before a reinstall or a move; fall through.
    }
  }
  return 'claude';
}

/**
 * One call to the cheap model, outside any conversation.
 *
 * It runs Claude Code headless with its tools off, its system prompt replaced
 * and the user's own hooks skipped, from an empty directory — so it loads no
 * project instructions, cannot touch anything, and costs a few thousand tokens
 * instead of a session's worth. SUMO_AGENTS_SCRIBE marks the process so this
 * repo's hooks ignore it: the call must never be recorded as something the
 * user said, or trigger another call.
 *
 * SUMO_AGENTS_MODEL_CMD swaps the binary for a stand-in that reads the same
 * request and prints the same envelope; the tests use it to replay recorded
 * answers without spending anything.
 */
export function callModel(db, { system, prompt, schema, model }) {
  const cwd = join(paths().home, 'scribe');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  const command = standIn ?? pinnedOrOnPath(db);
  const args = standIn
    ? []
    : [
        '-p', '--model', model, '--tools', '', '--setting-sources', 'project', '--no-session-persistence',
        '--output-format', 'json', '--max-budget-usd', MAX_SPEND_USD,
        '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      ];
  const input = standIn ? JSON.stringify({ system, prompt, schema, model }) : prompt;

  const run = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // Extended thinking is off on purpose. Measured on the same input it took 6,426 output tokens and 65 s
    // to find 2 memories; without it, 479 tokens and 4 s to find 5. Labelling text is not a reasoning task.
    env: { ...process.env, SUMO_AGENTS_SCRIBE: '1', MAX_THINKING_TOKENS: '0' },
  });

  if (run.error) return failure(`could not run ${command}: ${run.error.message}`);
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    return failure(`unreadable answer (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 300)}`);
  }

  const usage = {
    inputTokens: (envelope.usage?.input_tokens ?? 0) + (envelope.usage?.cache_read_input_tokens ?? 0) + (envelope.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: envelope.usage?.output_tokens ?? 0,
    costUsd: envelope.total_cost_usd ?? 0,
  };
  if (envelope.is_error) return { ...failure(`model call failed: ${String(envelope.result ?? envelope.subtype).slice(0, 300)}`), usage };

  let data = envelope.structured_output;
  if (data === undefined || data === null) {
    try {
      data = JSON.parse(String(envelope.result).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { ...failure('the answer was not the JSON that was asked for'), usage };
    }
  }
  return { ok: true, data, usage, error: null };
}

function failure(error) {
  return { ok: false, data: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error };
}
