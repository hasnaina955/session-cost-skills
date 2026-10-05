# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- `--notify` raises a terminal bell and, where the platform has one, a desktop notification when
  a session's spend passes `--budget`. The budget existed but was only ever a line of text on
  stderr and an exit code, which means it can only catch you if you happen to be reading. A budget
  you have to be looking at is not a budget, and the long `--watch` mode is the case that hurts
  most: the interesting moment is the one crossing, and a repainting frame is exactly the moment
  you are not looking at it.

  Three properties are the work, not the notification itself.

  An unknown cost never alerts. This is accounting rule 1 in a new place, and it is the reason
  the alert is driven by the budget *verdict* rather than by the amount. `exceeded` is the only
  status that means a known spend passed a known limit, so it is the only one that rings. A
  session nobody could price has no severity to raise, and a notification claiming otherwise would
  be the most expensive kind of wrong this tool can produce: it interrupts a person to tell them
  something false. A partially priced total that has already passed the cap still alerts, because
  a lower bound can prove a breach even though it can never prove compliance.

  Each threshold fires exactly once per process. `--watch` re-evaluates the same spend every
  500ms, so without a gate the same alert would arrive thousands of times an hour. The gate lives
  outside the per-poll reset in both adapters, which is the whole reason it is not a local.

  Platform commands are invoked with an argument array and `shell: false`, never a concatenated
  command line. A notification body carries a session id, which is an attacker-adjacent string as
  far as a shell is concerned. Where a platform's own quoting rules would have forced that string
  into a script literal - osascript's AppleScript, PowerShell's `-Command` - the script reads its
  arguments from the process argv instead, so a session id containing a quote cannot terminate
  the literal it would otherwise be pasted into. There is a test that asserts the caller data
  appears nowhere in the script text on those two platforms.

  A missing notifier warns once and the bell still rings, because a `--watch` that reprinted the
  warning every 500ms would be worse than no notification at all. A notifier that fails to start
  is swallowed: the verdict is already printed and has already set the exit code, and the number
  is the product.

  New `shared/notify.mjs`, with the `sync:`/`check:` pair wired into `verify` like every other
  shared module, so a drift between the two adapters' generated copies fails the build.

- The Command Code adapter joins Cline and MCode: a single self-contained
  TypeScript mod (`adapters/commandcode/skill/session-cost.ts`) that reads
  Command Code's own session ledger (`~/.commandcode/projects`), prices calls
  with the mirrored CommandCode provider-rate table (peak window 01-04 and
  06-10 UTC Mon-Fri at twice the off-peak rate), and reports through the same
  normalized report contract with runtime id `commandcode` and cost basis
  `provider-rate-estimate`. It carries the full feature set of the other
  adapters - current/last/today/compare/list/range modes, provider and model
  filters, subagent tracking, HTML dashboards with a strict CSP, rate refresh,
  the `doctor`/`providers`/`models discover`/`config explain` diagnostics,
  layered configuration with model aliases, and `--json` - plus the mod's own
  `session_cost` tool surface. Accounting semantics follow the repo principles:
  `inputTokens` excludes cached tokens, an unknown model reports tokens with a
  `null` cost rather than a guessed `$0`, a free-tier model is a known `$0`,
  and subagent usage blocks are tracked separately until `--include-children`.
  The reported clock honors `SESSION_COST_NOW` for deterministic output, and
  every failure path returns one readable line. The runtime enum of the
  normalized report contract gains `commandcode`; `contracts/README.md` now states
  the rule that makes that lawful: the runtime-id enum is open, consumers must
  tolerate ids they do not know, and extending it is additive rather than a
  version bump.

- The release version check now covers all three adapters: the Command Code
  mod must declare the repository version and the shared contract version, or
  the one-version-per-repository contract fails.

  The takeover review (the original author was unavailable) verified every ledger fact the
  mod relies on against the vendor's published docs and an independent parser before merge:
  the sessions/mods/pricing pages at commandcode.ai, and tokscale's commandcode.rs, which
  reproduces the transcript's recorded `costUsd` from the mirrored rates exactly. Three
  hardening changes came out of that review: a transcript-version guard (a v4+ ledger is
  reported unpriced with the drift named, never parsed into plausible zeros - the
  schema-drift rule), the upstream #100 rule applied to the mod (a banded call with no
  usable timestamp is unpriced rather than silently off-peak, the cheaper band), and the
  ledger's own recorded `costUsd` surfaced as a separate labelled domain with a staleness
  tripwire when it and the mirrored-rate estimate disagree. The mod also gains real
  behavioral tests: it is type-strippable TypeScript, so Node 24 and Bun run it against
  fixture transcripts in CI, with the static source-reading suite as the Node 22.15 floor.

- The Command Code adapter paints a live cost line around the input bar. A
  footer segment under the text box (the TUI surface wired today) and an
  above-editor widget (renders when the TUI wires widget placement) carry the
  running estimate for the active session: cost so far, call count, tokens,
  and the last model. The ledger is tailed incrementally — each refresh
  parses only the bytes the last commit appended — and repaints on run
  start, message end, tool completion, and run end, throttled to 800ms.
  The live line prices by the report engine's rules: a drifted transcript is
  reported unpriced with its version named, and a banded call without a
  usable timestamp counts as unpriced, never priced at the cheaper band; an
  unpriced call marks the figure with a trailing `+`. `"liveStatus": false`
  in the session-cost config turns it off.

### Changed

- `docs/handoff.md` and `docs/roadmap-plan.md` section 0 catch up with the Command Code adapter
  (#77 closed, delivered via the #99 takeover): the state table records the third runtime and the
  552-test suite, and the blocked table's #77 row is replaced by its one open follow-up, #107 -
  the live-install validation a merge could not do. The roadmap records the takeover's broader
  lesson: "blocked on knowledge" can often be unblocked by finding the primary sources, and the
  verification must be cited in the adapter, not assumed.

- `docs/handoff.md` and `docs/roadmap-plan.md` section 0 catch up with what merged: WP-4.4 is
  delivered (`--notify` shipped in #96), the `bandForTimestamp(null)` finding is now filed as
  #100, and #77 records that the CommandCode adapter attempt (#99) is held for provenance of the
  storage-layout facts. The status docs were asserting a queue that no longer existed.

### Fixed

- The Command Code adapter priced every cached token twice (#107). The v3
  ledger's `inputTokens` is the TOTAL prompt tokens and includes the cache
  buckets; the mod read it as fresh input and priced it at the input rate,
  so a session whose traffic was almost entirely cache-read was billed as
  if every cached token were fresh input. On a live install the disagreement
  was not a rounding gap: the mirrored-rate estimate ran 16x the ledger's
  recorded cost ($389.21 against $24.34), and the recorded-cost tripwire
  fired on every report. The vendor's arithmetic settles the semantics call
  by call: `inputTokens` minus the cache buckets, priced at the mirrored
  rates, reproduces the recorded `costUsd` exactly on every priced call of
  the install checked, while the raw figure never reproduces a single call
  that carries cache tokens. The mod now deducts the cache buckets and
  reports the fresh input, so the reported buckets stay disjoint,
  `inputTokenMeaning: 'excludes-cache'` becomes truthful, and every prompt
  total (`input + cacheRead + cacheWrite`) is the true prompt for the first
  time. After the fix the same install's flat-rate models reproduce the
  vendor's figures to the digit (Kimi-K3 $5.0915 estimated against
  $5.091515 recorded), the doctor's cache-read share corrected from a false
  49.1% - below the 60% threshold, so a warning was shown - to the true
  96.5%, and the aggregate estimate fell from $389.21 to $26.54 against
  $24.34 recorded. The provenance note in the mod, which claimed the buckets
  were disjoint on an independent parser's corroboration, is corrected: the
  live ledger overturned it.

  One disagreement survives the fix, and it is not a rate-table defect. All
  762 deepseek calls that fall in the documented peak windows (01-04 and
  06-10 UTC, Mon-Fri) were billed by the vendor at the off-peak rate on
  this install - every hour cell of the week, no exceptions - which is the
  entire $2.20 residual. Either the vendor's peak banding does not apply to
  this install's billing (a plan rate, not the public list price the mirror
  carries), or the published banding changed and the mirror's peak cards are
  stale. The evidence on this install cannot tell the two apart; settling it
  needs the vendor's current pricing page or a pay-per-token ledger. The
  tripwire is what surfaces the residual, and it stays armed: a table
  refresh cannot fix a banding disagreement, but silence would hide it.

- MCode's per-session metrics promised one contract and kept another (#104). The builder read
  `priced.missing`, a field `priceRow` does not return, so `unpricedCalls` was always 0 -
  and every shared consumer written for Cline's convention (the rollup's partial marker and
  cost exclusion, the insights baseline, the CSV count columns, cost centres) treated a
  partial MCode session as complete, rolling its lower bound up as a final figure. The
  convention is now kept, not just documented: `cost` is the sum of the calls that could be
  priced (a lower bound when partial, never a guessed total), `pricedCalls`/`unpricedCalls`
  are the real counts, and a session where no call could be priced carries `cost: null`,
  because the sum of zero priced calls is the absence of a figure, not $0 (rule 1). A
  zero-call session keeps its real zero: "nothing happened" is an answer, not an unknown.
  The new tests were proven to fail against the pre-fix builder before they were allowed to
  pass, and the rendered rollup now marks a partial day `unavailable` while naming the known
  portion - verified by reading it, not just by the suite.

- A ledger row with a missing timestamp was priced at the epoch (#100). `Number(null)` is 0,
  and `new Date(0)` is a real instant - epoch Thursday, 00:00 UTC - which falls in the
  off-peak band, the cheaper one, so a torn row on a banded model was silently priced at the
  cheapest rate. The custom-provider path was worse: the band came from the epoch while the
  record filter defaulted the missing time to now, so a peak-hour call with no timestamp
  priced at off-peak *right now*. A missing timestamp is now treated exactly like a corrupt
  token count (#67): the call takes the no-cost path, and `bandForTimestamp` throws on
  null/undefined so any caller that bypasses the graceful path fails loudly instead of at
  the epoch. `resolveRate` and the profile band resolver report the call unpriced with the
  reason named.

  The verdict aggregation had to grow up to say this. A session whose priced and unpriced
  calls share one model reported `unavailable` while a priced sum sat beside it, because the
  per-model verdict kept whichever row arrived first (NULL sorts first in SQLite). A model's
  rate is now known when any call resolved it - a resolved rate is always complete - and the
  report-level `rateKnown` additionally requires zero unpriced calls, so the session reports
  `partial` with the gap named, exits 2, and still prints every figure it has. This also
  delivers what #67's entry already claimed for a same-model mix: partial, not unavailable.

- The dashboard's headline KPI row was hardcoded to the Cline account domains, so on an MCode
  dashboard two of the four tiles could only ever read "-" and the estimated cost - the one
  number the tool exists to report - appeared nowhere in the server-rendered page, only as a
  small chart caption. A no-JS reader got tokens and a cache rate but never the cost. The row
  now leads with the domain the report actually carries (accounting rule 3): an estimated-cost
  tile for estimate-basis reports, the recorded/reference tile for recorded-basis ones, and a
  credits tile only when credits carry a figure. A foreign domain renders no tile rather than
  a permanent em dash, and the report's own cost tile renders even when the figure is unknown,
  because an em dash there is the honest state (rule 1). Found by rendering the dashboard and
  reading it - the failure mode the handoff says catches every serious bug here.

- An unpriced session renders as `$0.000000` in the dashboard's session table. This is accounting
  rule 1 - the silent zero, the failure this whole project exists to prevent - and it was visible
  on a real report: the same unknown cost appeared four ways on one page, as an em dash in the
  Models table, as `unpriced` in the model breakdown, as `unavailable` with an explanatory note in
  Cost by model, and as `$0.000000` in Matching sessions.

  The cause is the trap the file's own comment describes. Both adapters keep a legacy
  `totalCost`/`cost` aggregate that is a finite `0`, not null, when no call could be priced, so
  `normalizeSession` nulled a cost only when it was `null` or non-finite. A finite zero is exactly
  what "unknown" looks like once it has passed through an arithmetic accumulator, and it is
  indistinguishable from a real free session unless something declares otherwise. The report
  always declared: `coverage.status: "unavailable"`, every `costUsd: null`, an empty
  `rateProvenance`, and a warning naming the reason. The table simply never read any of it.

  The discriminator turned out not to be the obvious one. `rateKnown: false` is set for a *partly*
  priced session too, so treating it as "unknown" would blank a genuine lower bound - its own kind
  of lie, and the first version of this fix did exactly that until the tests caught it. The
  authoritative signal is `coverage.status`: `unavailable` means there is no figure, `partial`
  means there is a real amount that happens to be incomplete, and only the former blanks the cell.
  The booleans are now consulted only for a payload that carries no coverage claim at all.

- `--dashboard` combined with an aggregate mode (`--today`, `--compare`, `--list`,
  `--from`/`--to`, `--rollup`) printed a text report, wrote no dashboard, and said nothing at all.
  The flag was accepted and silently did nothing, which is the same class of failure as printing a
  figure the accounting did not produce: the user asked for an artefact, got none, and was not
  told. A dashboard is only ever written for one selected session, or for `--account` on Cline, so
  the combination is now rejected before any storage opens, naming the flags that caused it. The
  roadmap never promised a range dashboard, so failing loudly is the honest reading; implementing
  one is new work, not a fix.

### Tests

- The Command Code behavioral suite silently skipped every live test on
  Windows. It imported the mod through a bare Windows path, which is not a
  valid ESM URL, and the catch that handles "this Node cannot strip types"
  swallowed the import failure as a skip. Node 24 on Windows strips types
  fine, so the suite reported "skipped, not failed" while proving nothing on
  an entire platform - the same trap as a test anchored to the wrong
  witness. The import goes through `pathToFileURL`, and the suite now runs
  3/3 on Windows. The fixture was rewritten to the ledger's real semantics -
  inclusive `inputTokens`, the way a live ledger writes them - so the good
  call's recorded `costUsd` is the figure the vendor arithmetic produces.
  Against the pre-fix mod the corrected fixture fails by exactly the
  double-counted cache tokens at the input rate (0.0004728 against
  0.0004503), which is the failing-then-passing proof for the fix above;
  against the fixed mod it passes, and the suite was proven to fail before
  the fix was allowed to land.

- `check:docs` now fails when `## Unreleased` repeats a `### ` heading. Unreleased had grown three
  separate `### Added` blocks before the 0.6.0 cut, so a reader could not tell which batch an
  entry belonged to, and the cut merged them by accident rather than by guard. The check is
  scoped to Unreleased because released sections are memory rather than drafts, and 0.3.0
  deliberately files a second batch under `### Also in this release`. Carried forward unchanged
  from the closed #98, whose other two parts - the changelog restructure and the roadmap
  section-0 corrections - were overtaken by #94 and #95 while it sat. The guard was proven to
  fail on a reintroduced duplicate heading and to pass on the clean file, rather than only that
  it passes.

- The regression test for the silent zero was green while the defect was live, and understanding
  why mattered more than the fix. It asserted `strip(html)` contains no `$0.0000` - but the two
  filter tables are built by the browser runtime, so the file on disk never contains the string a
  reader finally sees. The assertion could not fail on any build, including one that renders
  `$0.000000` to the reader. It is anchored to the wrong witness.

  The new tests read the client payload instead - the `const P={...}` the script is handed - and
  assert the session arrives with `costKnown: false` and a null cost, alongside a priced positive
  control and a partly priced one, so a guard that blanked every cost would fail rather than pass.
  The original assertion is kept, with a comment recording what it does and does not cover.

  This is the second time the same mistake has cost this project a bug: the earlier redesign
  dropped the headline figures and every assertion was about charts and sections rather than
  numbers. The pattern is the same both times - assert on the artefact a reader actually consumes,
  not on the nearest thing a test can cheaply reach.

- A third guard bug, caught the same way: the `--dashboard` validation first read "absent" as
  `undefined` for every flag, but the runtimes spell absent three different ways - a null (`from`),
  a zero (`list`), and a missing key (`rollup`). It rejected every dashboard, including the
  supported single-session ones. The positive-control test is what caught it; a test that only
  checked the rejections would have shipped it green.

## 0.6.0

The reach and readability release. A shared CLI kernel makes each runtime adapter a few hundred
lines instead of a third copy; the dashboard is redesigned as a modern flat report; the tool
learned to answer quickly (--brief), to be shared (--card), and to stay fast at scale. The trust
release theme holds throughout: an unknown cost is still never a zero, and every figure can
still be traced to a rate record.

### Added

- The dashboard is redesigned as a modern flat report. The old page wore 2020-era chrome - a
  radial-gradient background, gradient-filled panels, an 18px radius, large shadows, and an
  accent bar on every card - and stacked eight sections in a single column with the raw JSON
  envelope as a visible section. It is now a bento grid on a 12-column layout with flat surfaces,
  hairline 1px separators, no shadows, a 12px radius, a compact header, quiet KPI tiles, and
  small uppercase section labels with tabular figures. The raw JSON envelope is collapsed behind
  a disclosure, because it is data for a consumer rather than part of the report. Every colour is
  now a token, so the light theme follows automatically; both palettes were checked against the
  WCAG audit before the CSS was written, not after. The CSP, the hashed inline script, the
  server-rendered SVG charts, the focus rings, and prefers-reduced-motion are all unchanged.

- `docs/handoff.md` is a starting brief for picking this up with no prior context: the state, the
  one architecture rule that bites (edit `shared/`, never an adapter's generated copy), the process
  rules, and the failure mode that has caught every serious bug here - rendering the awkward case
  and reading it, rather than trusting a passing suite. It also records what is blocked and exactly
  what would unblock it, so the next person does not guess a storage schema and produce plausible,
  wrong numbers.


### Added

- `tests/conformance/run-conformance.mjs`: the adapter conformance kit, which is issue #21's
  "an adapter must pass the shared usage, selection, session-graph and cost-domain contracts before
  it is accepted" turned from a review question into one command. It runs nine scenarios against any
  adapter - contract validity, explicit and current selection, ambiguity refusal, child inclusion
  exactly once, unknown cost staying unknown, a torn final record, the three output formats
  agreeing, and the total being the sum of its parts. Both existing adapters pass it, and a new
  adapter's acceptance test is one line calling `assertConformance`, which is the state WP-2.4
  called done when.

  It is deliberately not a value oracle. It does not know what a session should cost, because no
  runtime's numbers are another's; it knows the things that must hold for any runtime whose numbers
  can be trusted at all, and each of those is a way to produce a plausible number instead of an
  error.

  Writing it found two things the other tests did not. The two runtimes do not agree on the report
  shape - Cline normalizes to `session.id`, MCode carries `sessionId` at the top level - so the kit
  reads both rather than assuming one, and it sums `sessions[].metrics.cost`, the one per-session
  field they share, so the total is checked against figures it did not accumulate itself. And
  Cline has no session whose cost is wholly unknown, because it records a cost per call; its
  rule-1 case is a partially priced session, where the disclosed amount is a lower bound and the CSV
  charge cell must stay empty. That is the sharper test, and the kit now states rule 1 as the CSV
  contract actually implements it - the charge is written only when the ledger disclosed the whole
  of it, with a known zero as the one exception that may legitimately read `0`.

  `docs/adapter-authoring.md` documents the adapter interface, the step contract, the exit codes,
  the fixture contract, and the three rules the Cline port had to learn the hard way. It also says
  plainly that `open`, `close`, `listSessions`, `resolveCurrent`, `buildReport` and `aggregate` are
  not to be implemented yet, because nothing calls them.

### Changed

- Cline runs on the shared kernel, the second runtime to do so. `adapters/cline/skill/scripts/session-cost.mjs`
  went from 898 lines to 9. The runtime-specific half moved intact to
  `adapters/cline/skill/scripts/lib/runtime.mjs` (1,020 lines). As with MCode this was code motion
  rather than a rewrite: all ten golden files are byte-identical to the baseline captured before
  either port, and `--help` was diffed line by line against a stashed pre-port build.

  Cline needed one thing MCode did not. Its `die()` called `process.exit(2)` from the inside of
  the report path, which is untestable and unsafe on Windows, where exiting while a database
  handle is open trips a libuv assertion. It now raises the kernel's `KernelError`, so the exit
  code is the kernel's decision and no function below the adapter decides it. `--account` also
  stopped being a branch inside the report and became an `extraModes` entry: it reads a different
  source and produces a different document, and there is now no function through which an account
  figure could reach `billing`. That is accounting rule 3 made structural instead of promised, and
  a test asserts the report step does not mention `account` at all.

  The kernel gained the extra-mode dispatch WP-2.3 assumed and which WP-2.1 had not built. An extra
  mode runs after the configuration is loaded and instead of the report, so `--session-config`
  still applies to it and no invocation can produce both documents.

  Review found that last claim was wrong on the first attempt and the shipped version is corrected:
  the extra mode was dispatched straight after `loadConfig`, which silently skipped `configAction`,
  `setup`, `diagnostic` and `applyDefaults`. `--account --init-config` therefore stopped writing the
  config file and went to the network instead - verified by running the pre-port and post-port
  builds side by side, since both still exited 2 and only the side effect differed. An extra mode now
  replaces the report step alone, and a test pins the ordering.

  Two wiring bugs in the same code are also fixed. The adapter's `aggregate` member called a
  three-argument function with one, which would have left the aggregate's title and selection method
  undefined. And `runOnce` re-implemented the database-open guards inline while the adapter's own
  `open` member existed unused, so those guards now exist once.

  Review also found that the runtime-adapter interface over-claimed, and that is corrected here
  rather than deferred. WP-2.1 required twelve members, but the kernel invokes three of them:
  `open`, `close`, `listSessions`, `resolveCurrent`, `buildReport` and `aggregate` are never
  called, and both adapters satisfied them with `() => []` and `() => ({})`. `validateAdapter`
  passed, which is the precise false confidence the interface exists to prevent - and the reason
  the `aggregate` arity bug above could sit in the tree unnoticed. Those six move to a new
  exported `KIT_MEMBERS`, which nothing requires yet; the required list is now the members a run
  actually consumes plus the facts it states about a runtime. A test fails if either adapter starts
  defining a kit member, and another asserts the two lists stay disjoint, so the gap cannot quietly
  close with a stub. They are the contract WP-2.4's conformance kit will exercise.

- MCode runs on the shared kernel. `adapters/mcode/skill/scripts/session-cost.mjs` went from 1,444
  lines to 12: it imports the adapter and calls `runCli`. The runtime-specific half moved, intact,
  to `adapters/mcode/skill/scripts/lib/runtime.mjs` (1,502 lines) - the ledger reads, the pricer,
  `--rates`, `--refresh-rates`, and every renderer. The kernel now decides the order a run performs
  its steps in; the adapter says what each step means for MiniMax Code.

  The work was code motion rather than a rewrite, because the acceptance criterion is that output
  does not change. All ten golden files are byte-identical to a baseline captured before the port
  started, and the `--help` output was diffed line by line against the pre-port build rather than
  trusted. The two things that had to be understood rather than moved: the options used to be
  parsed at module load, so they now arrive through the run context and are reset per run, because
  `--watch` calls the report once per poll inside one process; and the local `CostError` is now the
  kernel's `KernelError`, which carries the same "understood failure, exit 2, no stack" contract.

  One existing test needed correcting rather than the code. "Every flag the schema accepts is
  actually acted on" read `session-cost.mjs` looking for `opts.<key>`, which was a reasonable proxy
  while the option flow lived in one file and silently became wrong once it did not. It now searches
  the whole scripts directory. That is a weaker-looking change, so I confirmed the stronger
  behaviour by renaming every `opts.counterfactual` reference in the adapter and checking the test
  still fails with "the CLI never reads opts.counterfactual" - it does. A test that stops catching
  the bug it was written for is worse than one that fails on a layout change.

### Added

- `shared/kernel.mjs`: the orchestration both entry points were writing twice, and the piece
  WP-2.1's title promised but did not ship. It owns argument parsing (through the existing
  `shared/cli-args.mjs`), the order a run performs its steps in, help and version, and the
  translation from a thrown condition to an exit code. It deliberately does not interpret storage
  or render a report: those are the two places where being wrong produces a plausible number
  instead of an error, so they stay in the adapter.

  The step order is exported as data (`RUN_STEPS`) rather than written as a call graph, so it is
  readable in one place and testable without running a runtime. A step the adapter does not define
  is skipped, not called, so a runtime with no rate table has no refresh step.

  The exit codes are pinned individually in the tests, because they are the part that cannot
  change later without breaking someone's automation: `0` priced, `2` ran but incomplete or a
  usage error, `1` a real fault. A caller can tell "I could not price this" from "the tool broke",
  and a stack trace stays behind `SESSION_COST_DEBUG` because it names local paths and can quote a
  payload fragment.

  `defaults` and `versionBanner` join the required members of the runtime-adapter interface,
  because the kernel drives them on the runtime's behalf and cannot run an adapter that omits
  them. The step hooks are permitted but not required, and `RUN_STEPS` is derived from the
  interface's own list so the two cannot drift.

  No adapter uses any of this yet: both entry points are untouched and their output is unchanged.
  Porting MCode is the next work package, with the golden corpus as the check that it changes
  nothing.

  The Node 22.15 CI jobs caught what a local run on Node 24 could not: a missing brace in the new
  test file made one test swallow the following nine as nested subtests, so the file reported nine
  failures and cancelled the rest instead of the fifteen independent tests it contains. It is
  worth recording because the file passed `node --check` and passed on the newer runtime - only
  the older runner's subtest accounting exposed it.

- `docs/session-cost-support-pack.html`: the one customer-facing document to send when someone is
  already installed and asks where the numbers come from. It covers the exact install paths, the
  config layers, what each operation reads and writes, where the network is used, how Cline
  credentials resolve, the accounting that differs between the two runtimes, and troubleshooting.
  It is registered in `check:docs`, and its version, Node floor, Bun support, child-session, and
  config-key claims are asserted against `package.json`, `engines.node`, and the session-config
  schema rather than trusted. That matters because the pack was written against 0.2.0 and had
  drifted on every one of those points while staying quietly readable: it promised a 22.13 floor
  the project had raised to 22.15, told Windows users Bun was supported when CI only tests it on
  Ubuntu, claimed MCode stopped at direct children when both adapters have since included all
  descendants, and showed three configuration keys that are not in the schema - instructions that
  would have produced a file the CLI then rejected. A document that is confidently wrong is worse
  than a missing one, so the checks now fail on the drift rather than on its absence. Registering
  it also caught a stale bundle folder name on its first run, the same class
  of error `check:docs` already guards in the selling guide.

- `docs/roadmap-plan.md` now opens with a status table recording what has shipped, what is still
  ahead, and the two findings deliberately left as issues rather than quietly fixed:
  `calculateTokenCost` coerces unusable token counts into a finite `0` (#67), and
  `bandForTimestamp` resolves a `null` timestamp to the off-peak band, which is the cheaper of the
  two. Both are reachable only in narrow circumstances today, and both are the kind of thing that
  becomes reachable later without anyone noticing.

- The dashboard gains four server-rendered sections: cumulative cost over the session, the token
  mix, cost by model, and the session tree with excluded subagents marked. They are drawn in Node
  and ship as inline SVG in the file itself, so they work with JavaScript disabled and print to a
  clean PDF, alongside the existing interactive charts rather than replacing them. Each chart is
  followed by a collapsed table carrying the same figures, so no number exists only inside a
  graphic, and Cline gets the same sections as MCode. They are placed above the existing
  interactive charts, because those render as empty boxes when script is unavailable and the
  whole point of drawing in Node is that the page still reads without it. A 2,000-call session
  produces a 99 KB file and the page says when a timeline has been bucketed.

- The plain-text report gains bars: a one-line token mix (fresh input, cached read, cache write,
  output) with a legend, and a per-model share bar in both adapters. A column of numbers makes a
  reader do the arithmetic; a bar answers "which of these dominates?" at a glance, which is the
  question a cost report is usually asked. The new `shared/term-bars.mjs` holds the rules, all of
  which exist because the alternative was once a bug here: a bar is decoration and the figure is
  repeated beside it, so no value is carried only by a length; an unknown value is never an empty
  bar, because an empty bar and a zero bar are the same pixels; padding is measured in visible
  characters, so colour and block glyphs cannot break alignment; and colour is off unless stdout
  is a terminal and `NO_COLOR` is unset, with a `--plain` escape hatch for code pages that render
  `█` as mojibake. Cline's bar asks the same `costState` helper its label uses, so the two cannot
  disagree about whether a model has a cost.

- `shared/contrast.mjs` computes WCAG contrast ratios, and `tests/theme-contrast.test.mjs`
  audits the dashboard's actual dark and light palettes against them. The audit found that the
  light theme never declared `--danger` at all, so every danger-coloured chart mark in light mode
  resolved to nothing; it now declares a value at 6:1. The page also honours
  `prefers-color-scheme`, so a reader whose system asks for light no longer sees a dark page flash
  before the script decides. The test asserts the maths against the two WCAG anchors first, so a
  failure means a colour rather than a broken helper.
- `shared/card.mjs` renders a 1200x630 standalone SVG summary: the total, the token mix, the cache
  rate, the top models, and the coverage verdict. SVG rather than PNG, so there is no encoder, no
  dependency, and the file renders anywhere. **Privacy by default** - no session title, id, or
  path appears unless the caller asks, because a card is the artefact most likely to leave the
  machine and a cost summary does not need a session name to be useful. A card for a session
  nothing could be priced says `unavailable` and names the unpriced models; it never shows $0.00.

- `shared/runtime-adapter.mjs` defines the interface a runtime adapter implements, and validates one
  before any storage is opened. The two current entry points are 922 and 1,533 lines with six
  functions written twice verbatim, so a third runtime added the current way is a third copy of all
  of it - and the roadmap has six more runtimes queued, which multiplies the cost of every later fix.
  The interface keeps parsing, selection, mode dispatch, rendering, and exit codes in the kernel,
  and leaves an adapter holding only what is genuinely runtime-specific: where the ledger lives,
  what a call record means, and how a session becomes a normalized report. An **unknown member is
  refused** rather than ignored, because a typo like `buildReprot` is otherwise a method that is
  never called and is discovered only when a report comes back empty. `costBasis` is part of the
  required surface for the same reason principle 3 exists: "the runtime recorded this" and "we
  calculated this" must never be merged.

- Issue #67 closed: an unusable token count can no longer move a bill down. A count is now
  usable only if it is `null` (a call that recorded no tokens, which honestly costs nothing) or a
  finite, non-negative number. The earlier `Number(value) || 0` coercion did two dishonest things
  in the *under-reporting* direction this project refuses: a negative count subtracted from a
  total, and a non-numeric or empty value became a confident `$0.00`. Both now route the call into
  the same "no cost" path a model with no rate takes, so the session degrades to partial coverage
  and names the gap instead of silently shrinking. The fuzzer found this by feeding `"NaN"` and
  `-1` through; the fix is pinned by a unit test over the coercions and an end-to-end test that
  plants a negative count in a real fixture and asserts the report goes partial rather than
  understating. `tokenCountIsUsable` is exported for other readers.

- `--brief` answers "what did this cost?" in at most six lines: the cost with its coverage
  beside it, the tokens and cache rate, the top model, whether subagents are billed, and one caveat
  if there is a single thing worth knowing. `--brief --json` returns a small, stable, documented
  shape (`session-brief`) so a consumer does not re-derive the contract from the full report. The
  full report is thorough because a person auditing a bill needs it to be; the agent answering a
  bare cost question does not, and it pays the token cost of the whole thing either way. Unknown
  cost stays `unavailable` or `null`, never a zero, and a partial total is labelled rather than
  shown as a small number. Both `SKILL.md` files now steer the common case to `--brief` first.

- `--list` no longer takes eleven seconds on a large ledger, and the reason was not where the
  benchmark first pointed. The dominant cost was `selectTopLevelCandidates` in
  `shared/session-graph.mjs`, which asked `isDescendant(candidate, other)` for every pair of
  candidates - a full depth-first descent per pair, so a 10,000-session ledger spent **10,127 ms**
  deciding which sessions were top-level. It now walks each candidate's parent chain once instead,
  which is the same answer in **6 ms**. The optimisation is proven faithful by comparing it against
  the pairwise reference on random graphs, not by reading it. On a 10,000-session / 500,000-call
  ledger `--list 20` went from 10,837 ms cold and 10,089 ms warm to **1,007 ms** and **243 ms**.
- `rollup-cache.mjs` is now wired into that path, so a repeated `--list` reuses the per-session
  reports instead of recomputing them. The cached value is the **whole report**, not a subset: the
  first attempt cached only what the text table renders, and `--list` has three consumers with
  different needs - the text table, `--json` (which runs each report through the normalized
  contract), and `--rollup` - so the subset satisfied one and stripped the session ids out of the
  other two. `CACHE_VERSION` is bumped to 2, because a cache written with the old shape must be
  ignored rather than read into code expecting a new one.
- `tests/rollup-cache-contract.test.mjs` proves the cache cannot change a figure: a hit and a cold
  computation produce byte-identical output, and a ledger write, a rate refresh, or a different
  `--include-children` each invalidate it. `scripts/bench.mjs` compares only like-for-like shapes,
  since a baseline recorded for a smaller ledger says nothing about a larger one.

- `scripts/bench.mjs` measures the database-driven operations against a synthetic ledger and
  fails if any of them regress. `--list 20` on a 10,000-session / 500,000-call ledger took
  **eleven seconds** when it was first measured, because it builds a full `buildReport` per
  session instead of reading one grouped query - and `shared/rollup-cache.mjs`, a per-session
  aggregate cache invalidated by the ledger's own file fingerprint, exists for exactly that and
  was never wired in. That is why the benchmark's cold and warm runs come out the same speed.
  The bench is a regression gate, not a machine benchmark: an operation fails when it is much
  slower than a recorded baseline for the same shape, refreshed deliberately with
  `--write-baseline`, never automatically. The absolute-speed finding is filed as #87; the cache
  wiring is a separate change because it touches the money path.

- `--card` writes the shareable SVG summary that `shared/card.mjs` has been able to render since
  WP-3.5 but that no flag reached. The module shipped and the wiring was missed. A 1200x630 card -
  the Open Graph size - carrying the total, token mix, cache rate, top models, and the coverage
  verdict, written to `reports/session-cost/session-card.svg` (override with `--out`). **A session
  title, id, or path appears only with `--card-include-title`**, because a card is the one artefact
  of this tool designed to leave the machine and a cost summary does not need a session name to be
  useful. For a session nothing could price the card says `unavailable` and names the unpriced
  models; it never shows `$0.00`. Both adapters write it.

- `shared/charts.mjs` renders bar, stacked-bar, and sparkline charts as inline SVG **strings**, built
  in Node at report time rather than drawn in the browser. That is a constraint, not a limitation:
  no script means the dashboard works with JavaScript disabled and prints to PDF, the existing
  strict CSP needs no new allowance, and a chart becomes a pure function that can be asserted by
  comparing strings instead of by screenshot. The module never computes money - it draws figures
  the accounting already produced, so a chart cannot disagree with the report beside it. An unknown
  value is drawn hatched and labelled "unavailable" rather than as a zero-height bar, because a
  chart that renders "we do not know" as nothing is the silent-zero failure in a new place, and a
  priced zero stays visibly different from an unpriced one. Every chart carries a title, a
  description, and the figure as text, so no number exists only inside a graphic. A sparkline
  refuses to draw a trend from fewer than three points, and a flat series is drawn flat instead of
  being given an invented shape.

- `shared/timeline.mjs` builds a bounded, per-call timeline for a report: the time-ordered events a
  cost-over-time chart, a cache-rate trend, or a "where did the money go" view needs. A report
  exposes `calls` as a count, which is enough to say what a session cost and not enough to draw it.
  Entries are appended by the same code path that prices the call, so a timeline entry and the
  total it rolls up to cannot disagree, and past a limit the timeline becomes fixed-width time
  buckets rather than an unbounded array in a file that is written to disk and embedded in a
  dashboard. A bucket containing any unpriced call is `null` for the whole bucket, because summing
  the priced calls and dropping the unpriced one would make it look cheaper than the truth. The
  contract is extended in `contracts/normalized-report-v1.schema.json`.
- MCode `--json` reports now carry that timeline. It is emitted from the same loop that prices each
  call, so an entry and the total it rolls up to cannot disagree, and the suite asserts the
  rollup against `billing.amountUsd` for both a fully priced and a partially priced session. A
  partial session's timeline is `null` in total, not the sum of the calls that happened to price.
  This follows `--json` rather than a new flag on purpose: a flag only one adapter honoured would
  be a footgun, and `--json` is already the contract for "give me the data". A text report carries
  no timeline, so the golden corpus stays readable.
- `tests/golden.test.mjs` checks the rendered output of ten scenarios - both runtimes, a single
  session, subagents included, a session list, CSV, rate coverage, and the two unknown-cost paths
  that exit 2 - against checked-in files, byte for byte. Every other assertion in the suite checks
  that a *value* is right; none of them notices that a table lost its borders, a column drifted, a
  line disappeared, or the wording softened from "not recorded" to something vaguer. Those are
  regressions a user sees and a value assertion cannot, and they are what the Phase 3 visual work
  risks while it is in flight. A failure prints the first differing line with its number.
- `createClineFixture` and `createMCodeFixture` accept an optional `base` instant, and
  `FIXTURE_EPOCH` is a fixed constant. They previously built every session timestamp from
  `Date.now()`, which is why a golden file would have embedded a date that is two days old every
  morning - the same expiry that made `rate-provenance` flip from pass to fail on consecutive days.
  The default is still the real clock, so tests asserting relative-date behaviour are unchanged;
  the golden scenarios pin both the data and `SESSION_COST_NOW`, and a test asserts both pins
  rather than trusting them.

## 0.5.0

The trust release. Every change here makes a wrong number less likely to survive, and none of
them changes what a correct report says. The theme is that this project's own test suite and
runtime dependencies could produce or hide a wrong figure, and both are now pinned. Updating an
installed skill also stops silently discarding state; see [docs/updating.md](docs/updating.md).

### Added

- `scripts/update-skill.mjs` installs or updates an installed skill on Windows, macOS, and Linux.
  It replaces a PowerShell `Copy-Item` instruction that left macOS and Linux with no supported
  path, and it fixes two things a plain folder copy gets wrong. MCode mirrors provider rates into
  `references/provider-rates.json` *inside* the skill directory, so an update discards every table
  fetched with `--refresh-rates` and resets the refresh history while the next report quietly uses
  the bundled rates - the script backs that file up and restores it. And files the new release no
  longer ships survive a copy, leaving a stale generated copy beside the current CLI; the script
  removes them. Read-only unless `--apply`, it verifies `VERSION` and the installed `--version`
  afterwards, reports a `PROBLEM` line and a non-zero exit on failure, and is idempotent.
  `--check` is a CI gate that fails unless the installed skill is exactly this release.
  `docs/updating.md` documents the workflow, and `tests/update-skill.test.mjs` covers it -
  including a test that plants a refreshed rate table and asserts it survives an update.
- `docs/principles.md` lists the 16 rules this project does not trade, each linked to the test
  that enforces it. The CHANGELOG had been citing "non-negotiable rule 1" for two releases with no
  document defining the rules, so a contributor or agent could not follow rules they could not
  find. Two rules cannot be test-enforced and say so: no forecasting, and the free-software
  guarantee. `check:docs` now fails if the document cites a `tests/` file that does not exist, so
  a rule cannot claim enforcement it does not have.
- `tests/invariants.test.mjs` checks seven accounting properties over randomly generated ledgers
  rather than fixed ones: the total is exactly the sum of per-model, per-session, and per-component
  costs; an unpriced call never becomes a `0` total; token totals reconcile under each runtime's
  own input semantics; per-model rows sum to the ledger read directly in SQL; `--include-children`
  counts each descendant once; the text, CSV, and JSON reports agree; and reordering ledger rows
  changes no figure. Every wrong-money bug in this project's history produced a plausible number
  rather than an error, and a spot assertion on one fixture misses that class. The ledger-anchored
  test is the one that matters: it caught an injected cache-write double-count that the
  self-consistent reconciliations all missed, because every side of those equalities came from the
  same accumulator. Ledgers are seeded and replayable via `INVARIANT_SEED=<n>`.
- `SESSION_COST_NOW` pins the reported clock: `generatedAt`, snapshot `capturedAt`, and the UTC
  day boundary `--today` uses. With the clock pinned, two runs of the same command produce
  byte-identical output, which is what makes rendered output testable at all. An invalid value
  fails with one readable line naming the variable rather than silently falling back to the real
  clock, because a silent fallback is the failure the hook exists to prevent. This is a test and
  diagnostics hook, not a user setting. The `--watch` poll loop and the live view's "last ledger
  activity Ns ago" line keep the real clock, since elapsed time against a pinned clock means
  nothing. See `docs/configuration.md`.

### Fixed

- The MCode contract fixture could be priced by the bundled rate table, which made one contract
  test a function of the wall clock rather than of the code. `tests/rate-provenance.test.mjs`
  deliberately runs the CLI *without* `SESSION_COST_RATES_PATH` to prove that a session the
  fixture cannot price reports no provenance and a `null` cost rather than `$0.0000`. Its session
  dates are relative to now, and the fixture's stepfun model was named `step-5-preview`, which
  the bundled catalog also publishes. Bundled records with no explicit effective date inherit the
  provider's `fetchedAt`, so that model became priceable the moment the fixture's `now - 2d`
  window crossed the table's `2026-09-25T09:01Z` refresh: `tests/rate-provenance.test.mjs` passed
  on 2026-09-26 and failed on 2026-09-27 on one unchanged commit, and the 0.4.1 CI run of that
  commit is still green today. The fixture's model names are now synthetic, and a new test
  asserts that no fixture model is a key in the bundled table, so the next collision is a test
  failure rather than a surprise the day after a rate refresh moves the boundary. Every other
  `step-5-preview` reference is untouched: those tests deliberately exercise the real StepFun
  parser and the published catalog.
- Every reported timestamp in both adapters read the real clock directly, so output depended on
  the day the report was produced. That is the condition that let the fixture bug above pass on one
  day and fail on the next, and it also blocked the snapshot tests that visual work needs. All
  reporting paths now take the clock from `shared/clock.mjs`, and
  `tests/clock-determinism.test.mjs` fails the build if a reporting path reads the real clock
  without a preceding `// clock: real-time` comment, so the next one has to be a written-down
  choice rather than an oversight. `shared/budget.mjs` keeps its bare `Date.now()` default: that
  module is contractually import-free so that no dependency can be pulled in, and it already
  accepts the clock as an argument.
- The README quoted `session-cost 0.3.0` in its `--version` example, two releases behind the
  published 0.4.1. `check:docs` now asserts the quoted version against `package.json`, so it
  cannot drift again.

- A renamed column in a runtime's own storage no longer reads as zero. A `SELECT` against a
  missing column does not throw: the row carries `undefined` and the aggregate treats it as
  nothing, so a session reports a smaller bill with complete coverage instead of an error - the
  silent-zero failure this project treats as its worst bug class, arriving through storage
  rather than through pricing. Each adapter now declares the columns it reads, compares them
  against `PRAGMA table_info` before computing any figure, and fails with one line naming the
  table and column. An *extra* column is reported as `newer` rather than treated as a failure,
  because a runtime that grows a column is normal. `doctor` carries a `storage` block with the
  observed schema and a stable fingerprint, so a report says which layout it read.
- Bun now runs on Windows in CI as well as Ubuntu. Windows previously failed 11 tests with
  `EBUSY: resource busy or locked, rm '<tmpdir>'`: the fixtures deleted a temp directory while
  its SQLite handle was still open, which POSIX permits and Windows refuses. Directory cleanup
  now goes through `removeDirectory` in `tests/helpers/temp-dir.mjs`, which retries, and
  `tests/temp-cleanup-contract.test.mjs` fails if a new test deletes a directory with a bare
  `fs.rmSync`, so the failure cannot return quietly.

- `tests/fuzz.test.mjs` fuzzes the untrusted-input surfaces with seeded, replayable mutations
  (`FUZZ_SEED=<n>`): a session log torn mid-write, a truncated Cline message file, hostile provider
  pricing pages, and unusable token counts. The invariant is that nothing throws uncaught, nothing
  prints a stack trace or a local path, and nothing exits 0 with unparseable JSON. The in-process
  parser targets run 2,000 mutations each; the two that spawn a real CLI run 100, because a
  suite nobody runs catches nothing. Three findings are recorded in the file as comments rather
  than papered over: `messages.jsonl` is not MCode's money path (the SQLite ledger is, which
  changed what the test could honestly claim), `bandForTimestamp` throws on an unparseable
  timestamp so banded rates cannot silently misprice, and `calculateTokenCost` coerces unusable
  token counts - tracked as #67 and pinned by a `KNOWN GAP` test rather than fixed inside a
  test-only change.

## 0.4.1

### Fixed

- `--watch` reported `$0.0000` for a session it could not price. Non-negotiable rule 1 says an
  unknown cost is `null`, never `0`, and both adapters keep a legacy `totalCost` aggregate that
  is `0` - not `null` - when nothing could be priced, so the guard fell through to it and turned
  "we do not know what this cost" into a figure a reader takes as "this session was free". The
  same trap applied to every model row. Found by watching a live MCode session on a model with
  no mirrored rate, where the text report correctly said `COST UNAVAILABLE` while the live view
  showed `$0.0000` for the same session. The report's own declared verdict now wins, and the
  legacy aggregate is only consulted when nothing contradicts it.
- `--refresh-rates` could never succeed. `RATES_SOURCE.stepfun` is a raw `.md` document that
  correctly answers `content-type: text/markdown`, and `text/markdown` was missing from the
  allowlist, so `fetchText` rejected the skill's own configured URL. Because the refresh is
  transactional, the successful CommandCode fetch was discarded with it, so rate tables silently
  froze while the tool kept reporting plausible numbers. The allowlist and `RATES_SOURCE` are two
  independent declarations of one fact and had drifted; `adapters/mcode/skill/tests/rates-refresh-source.test.mjs`
  now asserts they agree, and still refuses genuinely hostile content types.
- The bundled-catalog test pinned the live provider's exact model counts (`79/78/1`), so a correct
  `--refresh-rates` turned the suite red when CommandCode published an 80th model - teaching the
  next person that refreshing rates is a test failure. Those numbers are data, not behaviour. The
  test now asserts the coverage block is internally consistent and that the MiniMax flagship is
  inside the priceable set, which is what its name claims.

### Added

- `tests/builtin-rate-fixtures.test.mjs` closes the asymmetry between the two driver families. The
  generic protocol drivers already assert that their offline usage, stream and pricing fixtures
  cover the protocol driver list, so a protocol driver cannot be added without them. The built-in
  drivers that mirror a pricing page over the network - commandcode and stepfun - had no such
  guard: their parser cases lived in the MCode adapter's suite as inline assertions with nothing
  tying them to the manifest list, so a new `rateRetrieval: 'network'` driver could ship with a
  parser that had never run without a network call and CI would stay green. All three wrong-money
  bugs fixed in 0.4.0 lived in exactly such parsers.

## 0.4.0

### Added

- CI now runs the full matrix: `npm run verify` on ubuntu, windows, and macos against Node 22.15
  and 24 with fail-fast disabled, the full test suite under Bun on ubuntu, and a release
  rehearsal on ubuntu and windows. The declared Node 22.15 floor and the ubuntu/macos runners
  were claimed but never exercised before this; a regression on either now fails a push.
- `.github/workflows/release.yml` is new. A tag push verifies the tree, rehearses the install
  from the archives, rebuilds them, confirms the published checksums and that the tag matches
  `package.json`, then publishes the archives with `SHA256SUMS.txt`. Releases were cut by hand
  until now, which is why `docs/release.md` referred to a release workflow that did not exist.

### Fixed

- `tests/release-contract.test.mjs` derived the repository root from
  `new URL(import.meta.url).pathname`, which yields a `/C:/...` path on Windows and resolved to
  `C:\C:\...`. The file threw while being imported, so all ten of its tests - including the
  published-checksum verification - never ran, and `npm run verify` failed on `windows-latest`.
  It now uses `fileURLToPath`, as the rest of the repository does.
- `CONTRIBUTING.md` and `docs/ci-matrix.yml` described a CI matrix (ubuntu/windows/macos against
  Node 22.15 and 24, plus Bun and release-rehearsal jobs) that no workflow implemented. Both now
  describe what CI actually runs.
- `scripts/run-tests.mjs` invokes Bun's runner correctly. It spawned `process.execPath --test`,
  which under Bun is `bun --test` - not Bun's runner, so every file ran as a plain script and
  each suite threw `Cannot use test outside of the test runner`, exiting 1. It now uses
  `bun test` and raises Bun's 5000ms default per-test timeout, which `node:test` does not impose
  and which the slowest CLI end-to-end test exceeds.

### Security

- `ci.yml` now pins `actions/checkout` and `actions/setup-node` to full commit SHAs instead of
  mutable `@v4` tags, and declares least-privilege `contents: read` permissions. A moved tag
  previously let a third party change what release CI executed with no pull request.
- `npm run check:workflows` is now part of `npm run verify`, so the pin policy is enforced on
  every push rather than only when run by hand.

## 0.3.0

### Added

- Added fingerprinted effective-dated rate records with context thresholds, time bands, source metadata, and immutable refresh history.
- Added a versioned provider-driver contract with deterministic detection, aliases, capability declarations, and safe user-module loading.
- Added layered project/user configuration, provider profiles, safe secret references, and config lifecycle commands.
- Added secret-safe doctor/provider/model discovery and deterministic match explanations with suggestion-only aliases.
- Added OpenAI/Anthropic-compatible protocol drivers, custom endpoint profiles, and manual or imported effective rate cards.
- Made explicit, runtime-provided, active-root, ambiguous, and zero-call session selection explicit across both adapters.
- Separated Cline end-to-end aggregates from reconstructed session scope and made billing classification provider-aware.
- Made Cline account history windows exact, period completeness explicit, and malformed API pages fail deterministically.
- Reconciled MIT and optional-support terms, corrected install paths, and added UTF-8/legal-copy documentation checks.
- Added cross-platform/Bun CI matrix templates, artifact allowlist checks, and a Node.js 22.15 runtime floor.
- Added repository secret/data ignore rules, a history-wide audit, and a documented audit result.
- Added a release version contract: a single semantic version shared by the repository, both adapter skills, and every archive.
- Added a `VERSION` file and `--version` flag to both skills so an installed copy identifies itself without the repository.
- Added reproducible Cline, MCode, and combined release archives with published SHA-256 checksums.

### Security

- Replaced browser-side dashboard HTML sinks with DOM text construction and locked dashboards to a hash-scoped, offline content security policy.
- Added regression coverage for malicious model, provider, session, title, filter, and rate metadata in both adapters.
- Set the package to `private` so no npm publication can leak a skill source as an unintended package.

### Fixed

- Corrected MCode CommandCode cache-write pricing, made missing rate components fail validation, and made provider refreshes atomic and all-or-nothing.
- Corrected CommandCode rendered-row parsing so non-1M context rows and 50% promo rows are published, including MiniMax M3.
- Made Cline and MCode descendant selection recursive and duplicate-free, with explicit included, excluded, and suppressed session IDs.

### Changed

- Added a formal normalized report contract shared by both CLIs, including token semantics, cost basis, provenance, coverage, warnings, selection, and session-graph state.
- Label MCode rate-derived totals as estimates rather than runtime-recorded charges.
- Discover every adapter and contract test recursively instead of maintaining a partial package script list.
- Generate independently installable Cline and MCode dashboard renderers from one canonical implementation and fail verification when copies drift.
- Documented the relationship between release, adapter, report-contract, and optional-support versions in [docs/release.md](docs/release.md).

### Also in this release

### Fixed
- A corrupt or unreadable session database no longer prints a raw Node stack trace quoting
  the full local install path. Both adapters now report one readable line, for example
  `Cline session database could not be read (sessions.db): the file is not a readable database`.
  `node:sqlite` opens lazily, so the schema is now probed inside the guard.
- A database whose schema lacks the expected table now fails instead of reading as an empty
  ledger. An empty successful report was indistinguishable from a genuine "no sessions" result.
- Rate refreshes now have a request deadline, a response-size cap, and a content-type check.
  A hung socket previously left the refresh running indefinitely and a hostile endpoint could
  stream until the process died.
- Rate fetch failures no longer echo the offending URL or a local path back to the user.
- Dashboard writes are now atomic: a temp file plus rename, so an interrupted write can no
  longer leave a half-written HTML file that is indistinguishable from a good one. A failed
  write removes its temp file and names the target by basename only.
- MCode no longer prints a stack trace for an unexpected failure. Set `SESSION_COST_DEBUG=1`
  to opt back in to the full trace when diagnosing a defect.

### Fixed (accounting)
- Corrected peak/off-peak pricing for OpenAI- and Anthropic-compatible provider profiles.
  `bandForTimestamp` did `new Date(Number(timestamp))`, and `Number()` of an ISO-8601 string is
  `NaN`, so every ISO timestamp resolved to off-peak and **silently under-reported cost** during
  peak windows. An ISO `at` now prices identically to the same instant as epoch milliseconds.
- Stopped applying CommandCode/StepFun's peak calendar to arbitrary third-party providers. A
  profile that declares both peak and off-peak records but no time-of-day policy now reports
  `coverage: unavailable` instead of guessing a band.
- `bandForTimestamp` now throws on an unparseable timestamp rather than falling through to
  off-peak, and returns `flat` for an empty time-of-day policy.
- Fixed the Anthropic-compatible stream parser. The Messages API emits server-sent events, but
  the parser treated every line as bare JSON and threw on the first `event:` line, so no
  Anthropic-compatible streaming usage could ever be read.
- `doctor` and `providers` now report the manifest `fingerprint` the provider-driver contract
  requires. Built-in manifests were surfaced raw and never passed through the registry, so
  `doctor --json` listed driver identities the pricing path could not reproduce.
- Replaced two hand-rolled argument parsers with one shared option schema, so both adapters
  accept, reject, and explain the same flags identically.
- `--list` no longer consumes the following flag as its count. `--list --json` used to
  silently discard `--json` and return a single-session report instead of a list.
- Every value-taking flag now requires a value. `--session` with no value used to swallow
  the next flag and report it as a session id.
- Conflicting flags are rejected instead of silently overridden. `--last --today` used to
  discard `--last` and run `--today`.
- Numeric ranges (`--list`, `--account-days`) and calendar dates are validated before any
  storage is opened, so a bad invocation fails immediately instead of after loading a ledger.
- `--account-days abc` no longer crashes MCode with a raw stack trace.

### Added
- Documented the configuration system, provider-driver contract, model-matching precedence,
  and skill migration in `docs/configuration.md`, `docs/provider-drivers.md`,
  `docs/model-matching.md`, and `docs/migration.md`.
- Added offline fixtures covering every built-in provider driver in both adapters plus the
  generic OpenAI- and Anthropic-compatible protocol drivers.

### Changed
- Both help texts now document the `--models-discover` and `--config-explain` spellings, which
  the schema accepted but the help text never mentioned.
- `--help` and `--version` answer immediately even when combined with invalid flags.

## 0.2.0

### Added

- Public MIT-licensed Cline and MCode skill sources
- Cline OAuth credential resolution and live account mode
- Cline daily, weekly, monthly, and account-limit reporting
- MCode command parity with Cline
- MCode rate-coverage view
- Interactive self-contained HTML dashboards
- Provider/model/search filters and dynamic dashboard statistics
- Subagent-aware aggregation
- Versioned JSON output
- Cline and MCode usage references
- Gumroad selling guide
- Free software with optional paid support policy
- Security, contribution, changelog, and CI documentation

### Compatibility

- Node.js 22.15 or newer
- Windows 10/11
- Cline CLI and MiniMax Code CLI have separate adapters and installation targets
