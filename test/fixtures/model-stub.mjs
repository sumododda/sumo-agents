#!/usr/bin/env node
// Stands in for the cheap model: records what it was shown, replays a recorded answer.
// The local router gets its own answer when STUB_ROUTER_ANSWER is set, so a job can be routed
// while the scribe replays something else; a router answer that is not there is a failed call.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const request = readFileSync(0, 'utf8');
if (process.env.STUB_CAPTURE) writeFileSync(process.env.STUB_CAPTURE, request);
const router = process.env.STUB_ROUTER_ANSWER && JSON.parse(request).model === 'local';
if (router && !existsSync(process.env.STUB_ROUTER_ANSWER)) {
  process.stderr.write('no router answer recorded');
  process.exit(1);
}
process.stdout.write(readFileSync(router ? process.env.STUB_ROUTER_ANSWER : process.env.STUB_ANSWER, 'utf8'));
