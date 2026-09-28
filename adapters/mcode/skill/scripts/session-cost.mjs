#!/usr/bin/env node
// The MCode runtime adapter. The orchestration this file used to contain now lives in the shared
// kernel (lib/kernel.mjs), which owns argument parsing, help and version, the order a run performs
// its steps in, and the translation from a thrown condition to an exit code. What stays here is
// everything genuinely specific to MiniMax Code: where its ledger lives, what a call record means,
// how a session becomes a priced report, and how that report is rendered.
//
// CommandCode and StepFun rate accounting semantics are documented in
// ../../references/ledger-internals.md.

import mcodeAdapter from './lib/runtime.mjs';
import { runCli } from './lib/kernel.mjs';

process.exitCode = await runCli(mcodeAdapter, process.argv.slice(2));
