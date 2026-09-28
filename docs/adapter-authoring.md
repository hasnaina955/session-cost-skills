# Writing a runtime adapter

A runtime adapter teaches this project how to read one coding agent's ledger. Everything it does not
need to know for itself - argument parsing, the order a run performs its steps in, help, version,
and what an exit code means - lives in the shared kernel. What is left is the part that must stay
where a human reads it: where the ledger lives, what a call record means, and how a session becomes
a report.

## The shape

An adapter is a plain object. It declares six facts and implements the steps it supports:

```js
export default {
  id: 'mcode',                      // lowercase kebab-case; used in the CLI and the report contract
  displayName: 'MiniMax Code',
  costBasis: COST_BASIS.ESTIMATED,  // or COST_BASIS.RECORDED - see "Cost bases" below
  defaultDataDir: () => '/path/to/agent/data',
  defaults: DEFAULT_OPTIONS,        // option defaults for the shared parser
  versionBanner: () => formatVersionBanner(versionBanner('mcode')),
  helpLines: () => [HELP_TEXT],

  // Steps, in the order the kernel runs them. Omit any you do not support.
  loadConfig: (context) => { /* ... */ },
  configAction: (context) => 0,     // return an exit code to end the run here
  setup: (context) => 0,
  diagnostic: async (context) => 0,
  applyDefaults: (context) => { /* ... */ },
  preflight: async (context) => { /* ... */ },
  run: (context) => 0,
};
```

Two things are deliberately **not** in that list. `open`, `close`, `listSessions`,
`resolveCurrent`, `buildReport` and `aggregate` are in `KIT_MEMBERS`, which nothing requires yet,
because nothing calls them. Implementing one anyway is a bug this repository now has a test for: a
member that no code invokes is a member an author implements wrongly with no signal, and `() => []`
satisfies the checklist while doing nothing. The conformance kit is what will make them real, and
the day it does, the interface is widened deliberately.

### Steps and exit codes

A step that returns a **number** ends the run with that exit code. A step that returns `undefined`
lets the run continue. That is how `--setup`, `--doctor` and the config actions work: they return
before the report ever runs.

The exit codes are the kernel's contract and are not yours to redefine:

| Code | Meaning |
| --- | --- |
| `0` | The run succeeded and every figure was priced. |

## Proving the adapter conforms

Conformance is one command, or one line in a test:

```js
import { assertConformance } from './conformance/run-conformance.mjs';

test('the acme adapter passes the conformance kit', () => {
  assertConformance({
    adapter: acmeAdapter,
    fixture: createAcmeFixture(),
    ambiguous: createAcmeAmbiguousFixture(),
    label: 'acme',
  });
});
```

The kit runs nine scenarios: contract validity, explicit selection, current selection, ambiguity
refusal, child inclusion exactly once, unknown cost staying unknown, a torn final record, the three
output formats agreeing, and the total being the sum of its parts.

It is not a value oracle. It does not know what a session should cost, because no runtime's numbers
are another's. It knows the things that must hold for any runtime whose numbers can be trusted at
all - and each of those is a way to produce a plausible number instead of an error.

## The fixture contract

The kit drives the CLI, so your fixture is what tells it where the ledger is and which sessions
hold which case:

| Handle | Required | What it must be |
| --- | --- | --- |
| `script` | yes | The adapter's entry point. |
| `dataDir` | yes | Where the ledger is. |
| `environment` | no | Env vars the run needs - a rate table path, a pinned clock. |
| `sessionIds` | yes | Every session in the fixture. |
| `root` | yes | A fully-priced root session. |
| `child`, `grandchild` | yes | A direct child and a descendant of it. |
| `unpriced` | yes | A session whose cost is not fully known. |
| `torn` | yes | A session whose final record is truncated. |
| `ambiguous` | no | A fixture with two live root sessions, as a separate factory. |

`unpriced` means *not fully known*, not *wholly unknown*. A partially priced session is the sharper
case: the disclosed amount is a lower bound, and the CSV charge cell must stay empty rather than
carrying the partial sum as if it were the whole. A runtime whose costs are always recorded can
still have this, and should.

### Building the ambiguous fixture

"Live" is the one thing runtimes genuinely disagree on, which is why the fixture owns it. Cline
reads a `status` column, so two roots set to `running` must be refused. MCode reads how recently a
call landed, so a fixture with two recent roots is already ambiguous. See
`tests/conformance/ambiguous-fixtures.mjs` for both, and copy whichever matches your runtime.

## A worked example

The Cline adapter is the smallest thing that conforms. Its entry point is nine lines:

```js
#!/usr/bin/env node
import clineAdapter from './lib/runtime.mjs';
import { runCli } from './lib/kernel.mjs';

process.exitCode = await runCli(clineAdapter, process.argv.slice(2));
```

Everything else - 1,020 lines of ledger reads, cost classification, ambiguity refusal, every
renderer - is in `lib/runtime.mjs`, where the person who has to change it can read it. The point of
the split is not brevity; it is that the arithmetic and the orchestration are not in the same file,
so a change to one cannot quietly change the other.

Three rules the port had to respect, each of which cost a real bug once:

1. **Do not parse argv yourself.** The kernel does it through `shared/cli-args.mjs`, which is where
   flag names, exclusivity and defaults live. Parse once, in the kernel.
2. **Do not call `process.exit()`.** Throw `KernelError`. The kernel turns a condition into an exit
   code; an exit in the middle of a report strands a database handle.
3. **Do not merge cost domains.** Cline's `--account` reads the account API while a session report
   reads the local ledger. That is why it is an `extraModes` entry rather than a branch inside the
   report: there is then no function through which an account figure could reach `billing`.

## Before you open the pull request

- `npm run verify` - the full gate. The conformance kit runs as a discovered test, so it is part of
  this rather than a separate thing to remember.
- `npm run rehearse:release` - the archive installs and runs from a clean extraction.
- The golden corpus is unchanged. A new adapter adds its own goldens rather than editing existing
  ones, and a refactor that moves a figure belongs in its own pull request.

| `2` | The run succeeded but the answer is incomplete: an unpriced session, partial coverage, or a usage error. |
| `1` | An unexpected failure. Never for a condition you understood. |

To report a condition you understood, throw `KernelError` rather than calling `process.exit()`.
Exiting while a database handle is open trips a libuv assertion on Windows, and it makes the path
untestable.

### Cost bases

`costBasis` is the one field that is never cosmetic. `RECORDED` means the runtime wrote a cost on
each call; `ESTIMATED` means we price the call from a rate record. Rule 3 says those two never
merge, and `costBasis` is where that is stated. A report that claims the wrong provenance is worse
than one that admits it does not know.
