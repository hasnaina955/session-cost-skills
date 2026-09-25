# Support

Session Cost Skills is free software under the [MIT License](LICENSE). Anyone may use, copy, modify, merge, publish, distribute, sublicense, and sell the source subject to that license.

No purchase is required for Cline usage, MCode usage, local accounting, dashboards, normalized JSON, account mode, rate coverage, provider profiles, or compatible provider drivers.

## Installation support

Cline:

```text
Copy the contents of adapters/cline/skill/ to
%USERPROFILE%\.cline\skills\session-cost\

Confirm:
%USERPROFILE%\.cline\skills\session-cost\SKILL.md
```

MiniMax Code:

```text
Copy the contents of adapters/mcode/skill/ to
%USERPROFILE%\.minimax\skills\session-cost\

Confirm:
%USERPROFILE%\.minimax\skills\session-cost\SKILL.md
```

The two skills may be updated independently. Do not merge their ledgers, token semantics, or rate catalogs.

## Optional paid support

Paid support may cover installation, compatibility investigation, confirmed bug triage, runtime migration guidance, or sponsored development. It does not remove MIT rights, relicense the code, rebrand the public project, or withhold functionality already available in the repository.

Any paid listing must publish its scope, delivery period, response target, price, cancellation terms, and refund policy separately from the MIT license. Obtain qualified legal review before publishing commercial terms, guarantees, or refund language.

## Troubleshooting

- Run `npm run verify` from a source checkout.
- Confirm Node.js 22.5 or newer with `node --version`.
- Run the adapter help command and verify the installed `SKILL.md` path.
- Use `--doctor`, `--providers`, and `config explain` to diagnose provider configuration.
- Never send credentials, session databases, message logs, or generated reports in a support request.

## Privacy

Local session reports read data already stored on the computer. Cline account mode uses the user's existing Cline authentication for read-only API requests. The skill does not require a developer-owned server and never embeds credentials in config, reports, logs, or dashboards.

## Contact

Public usage questions and reproducible defect reports belong in the repository issue tracker:

https://github.com/hasnaina955/session-cost-skills/issues

Security reports must follow [SECURITY.md](SECURITY.md) and must not be posted as a public issue.

Commercial support inquiries may use the contact method published on the offering page. No support purchase changes the license grant.
