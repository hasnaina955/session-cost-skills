# MCode porting plan

## Phase 1 — preserve the native baseline

- Keep the existing MCode skill and provider-rate logic intact.
- Copy it into `adapters/mcode/skill/` without importing Cline credentials or local session data.
- Add a version marker and tests for the native MCode ledger assumptions.

## Phase 2 — extract shared UX

Port these Cline usability improvements to the MCode adapter:

- Automatic current-session selection
- `--last`
- `--today`
- `--compare`
- Date range filters
- Provider/model filters
- Versioned JSON output
- Snapshot metadata
- Optional standing-summary configuration
- Clear excluded/included subagent reporting

## Phase 3 — preserve MCode-specific accounting

Keep these semantics MCode-only:

- `input_tokens` is fresh input and excludes cache reads
- Total prompt = input + cache read + cache write
- Cost is calculated from mirrored CommandCode/StepFun rates
- Unknown provider/model rates produce token counts without a guessed cost
- Model/provider can switch within one session
- Rate timestamps and coverage must be visible

## Phase 4 — add MCode rate coverage mode

Instead of copying Cline `--account`, add an MCode-specific mode such as:

```text
/session-cost rates
```

It should report:

- Mirrored providers
- Rate-table freshness
- Models with complete rates
- Models with unknown rates
- Whether the selected session is fully priceable
- Priced versus unpriced call counts

## Phase 5 — release

Build separate, reproducible archives. The release version contract, archive contents, and
the full release process live in [release.md](release.md).

```text
dist/session-cost-cline-vX.Y.Z.zip
dist/session-cost-mcode-vX.Y.Z.zip
dist/session-cost-bundle-vX.Y.Z.zip
dist/SHA256SUMS.txt
```

Run both adapter test suites and `npm run rehearse:release` before creating any artifact.
