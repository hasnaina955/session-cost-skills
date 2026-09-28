# Support

Session Cost Skills is free under the [MIT License](LICENSE). Anyone may use, inspect, modify, and redistribute the Cline and MCode skills under that license. A purchase is never required for local accounting, JSON output, dashboards, Cline account mode, or MCode rate coverage.

## Get support

For installation, command usage, or a non-sensitive compatibility problem:

1. Search the existing [public issues](https://github.com/hasnaina955/session-cost-skills/issues).
2. Open a public issue at [hasnaina955/session-cost-skills](https://github.com/hasnaina955/session-cost-skills/issues/new/choose) when the repository host offers an issue template.
3. Include the adapter, installed/repository version, operating system, Node or Bun version, exact command, expected result, and a redacted error.

Do not post credentials, `providers.json`, `secrets.json`, session databases, message JSON/JSONL, private dashboards, or account identifiers. For a vulnerability or possible credential exposure, use the private advisory route in [SECURITY.md](SECURITY.md), not a public issue.

The browser-ready [customer support pack](docs/session-cost-support-pack.html) contains exact install paths, a clean-install assertion, network/write disclosures, accounting notes, and troubleshooting steps.

## Optional paid support

An operator may offer voluntary, separately scoped help through a marketplace listing. Possible services include:

- installation and compatibility help
- triage of a confirmed, reproducible bug
- runtime migration guidance
- bounded sponsored changes
- a stated support window or response target

A marketplace listing must identify its service period, price, delivery method, support channel, exclusions, cancellation terms, and any refund policy. Those terms should receive appropriate legal/business review before publication. Response targets are not an engineering warranty or guaranteed fix.

Paid support terms apply only to the service described at checkout. They do **not**:

- relicense, rebrand, or withdraw MIT rights from the public source;
- turn the MIT source into commercial or single-user software;
- unlock a feature that is already available in the public repository; or
- authorize inclusion of customer data, credentials, or private runtime files.

The repository does not set marketplace prices or fees because those change. Publish current commercial terms only on the actual listing. The public [optional support listing guide](docs/gumroad-selling-guide.html) explains the separation without selling or relicensing the code.

## Data shared during support

Ask the user to redact local data before sending logs or examples. Prefer:

- command flags and the Node/Bun version, not environment dumps;
- error text with paths and IDs redacted, not complete transcripts;
- a small synthetic ledger fixture, not a copied production database; and
- screenshots cropped to the relevant error.

MCode `--refresh-rates` contacts public provider pricing pages and atomically rewrites its installed rate file only after all sources validate; otherwise a previous valid table is retained without a write. Cline `--account` contacts the Cline API. Explain those behaviors before collecting diagnostics.
