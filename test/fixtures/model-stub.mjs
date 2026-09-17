#!/usr/bin/env node
// Stands in for the cheap model: records what it was shown, replays a recorded answer.
import { readFileSync, writeFileSync } from 'node:fs';

const request = readFileSync(0, 'utf8');
if (process.env.STUB_CAPTURE) writeFileSync(process.env.STUB_CAPTURE, request);
process.stdout.write(readFileSync(process.env.STUB_ANSWER, 'utf8'));
