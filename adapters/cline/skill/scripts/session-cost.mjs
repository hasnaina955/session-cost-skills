#!/usr/bin/env node
// The Cline runtime adapter. The orchestration this file used to contain now lives in the shared
// kernel (lib/kernel.mjs), which owns argument parsing, help and version, the order a run performs
// its steps in, and the translation from a thrown condition to an exit code. What stays in
// lib/runtime.mjs is everything genuinely specific to Cline: where its ledger lives, what the
// recorded cost on a call means, and how that becomes a report.

import clineAdapter from './lib/runtime.mjs';
import { runCli } from './lib/kernel.mjs';

process.exitCode = await runCli(clineAdapter, process.argv.slice(2));
