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

### Updating

To update, copy the skill folder again over the installed one:

```powershell
$Skill = "$env:USERPROFILE\.minimax\skills\session-cost"
Copy-Item "$Skill\references\provider-rates.json" "$env:TEMP\provider-rates.json"   # MCode only
Copy-Item -Recurse -Force .\adapters\mcode\skill\* $Skill
Copy-Item "$env:TEMP\provider-rates.json" "$Skill\references\provider-rates.json"  # MCode only
node "$Skill\scripts\session-cost.mjs" --version
```

**MCode only:** `references/provider-rates.json` lives inside the skill folder, so copying
over it discards rates you fetched with `--refresh-rates`. The two lines above preserve
them; skip them and run `--refresh-rates` afterwards instead. Cline has no such file, so
a Cline update cannot lose anything.

## Released archives

Releases publish three archives plus a `SHA256SUMS.txt` file: one installable Cline skill, one
installable MCode skill, and a bundle containing both. Verify the checksum before installing:

```powershell
Get-FileHash .\session-cost-cline-v0.3.0.zip -Algorithm SHA256
```

Confirm what you installed with `--version`. The release version contract, archive contents,
and the full release process are documented in [docs/release.md](docs/release.md).

## Optional paid support

Paid support may cover installation, compatibility investigation, confirmed bug triage, runtime migration guidance, or sponsored development. It does not remove MIT rights, relicense the code, rebrand the public project, or withhold functionality already available in the repository.

Any paid listing must publish its scope, delivery period, response target, price, cancellation terms, and refund policy separately from the MIT license. Obtain qualified legal review before publishing commercial terms, guarantees, or refund language.

## Troubleshooting

- Run `npm run verify` from a source checkout.
- Confirm Node.js 22.15 or newer with `node --version`.
- Run the adapter help command and verify the installed `SKILL.md` path.
- Run `--version` to confirm the installed skill matches the release you expected.
- Use `--doctor`, `--providers`, and `config explain` to diagnose provider configuration.
- Never send credentials, session databases, message logs, or generated reports in a support request.

## Privacy

Local session reports read data already stored on the computer. Cline account mode uses the user's existing Cline authentication for read-only API requests. The skill does not require a developer-owned server and never embeds credentials in config, reports, logs, or dashboards.

## Contact

Public usage questions and reproducible defect reports belong in the repository issue tracker:

https://github.com/hasnaina955/session-cost-skills/issues

Security reports must follow [SECURITY.md](SECURITY.md) and must not be posted as a public issue.

Commercial support inquiries may use the contact method published on the offering page. No support purchase changes the license grant.
