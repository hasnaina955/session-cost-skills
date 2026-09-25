// Builds the customer-facing release archives for one version.
//
//   session-cost-cline-vX.Y.Z.zip    installable Cline skill
//   session-cost-mcode-vX.Y.Z.zip    installable MCode skill
//   session-cost-bundle-vX.Y.Z.zip   both skills plus shared docs and the MIT notice
//   SHA256SUMS.txt                   checksums for every archive
//
// Archives are deterministic: the same commit always produces the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDeterministicZip,
  collectFiles,
  forbiddenPackageReason,
  repositoryRoot,
  sha256,
} from './lib/release-pkg.mjs';

const BUNDLE_DOCS = ['README.md', 'LICENSE', 'CHANGELOG.md', 'SUPPORT.md'];
// Adapter tests are repository regression coverage, not part of an installed skill.
const PACKAGE_EXCLUDE = [/(^|\/)tests\//];
const parseArgs = (argv) => {
  const options = { out: path.join(repositoryRoot, 'dist') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.out = path.resolve(argv[++index] ?? options.out);
    else if (argv[index] === '--version') options.version = argv[++index];
    else if (argv[index] === '--check') options.check = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
};

const options = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = options.version ?? packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid release version: ${version}`);

function skillEntries(runtimeId) {
  const skillRoot = path.join(repositoryRoot, 'adapters', runtimeId, 'skill');
  const versionFile = path.join(skillRoot, 'VERSION');
  const stamped = fs.readFileSync(versionFile, 'utf8').trim();
  if (stamped !== version) {
    throw new Error(`adapters/${runtimeId}/skill/VERSION is ${stamped} but the release version is ${version}`);
  }
  return collectFiles(skillRoot, { exclude: (relative) => PACKAGE_EXCLUDE.some((pattern) => pattern.test(relative)) })
    .map((relative) => ({
      path: `${runtimeId}/${relative}`,
      data: fs.readFileSync(path.join(skillRoot, relative)),
    }));
}

const clineEntries = skillEntries('cline');
const mcodeEntries = skillEntries('mcode');
const sharedEntries = BUNDLE_DOCS
  .filter((file) => fs.existsSync(path.join(repositoryRoot, file)))
  .map((file) => ({ path: file, data: fs.readFileSync(path.join(repositoryRoot, file)) }));

const archives = [
  { name: `session-cost-cline-v${version}.zip`, entries: clineEntries },
  { name: `session-cost-mcode-v${version}.zip`, entries: mcodeEntries },
  { name: `session-cost-bundle-v${version}.zip`, entries: [...clineEntries, ...mcodeEntries, ...sharedEntries] },
];

for (const archive of archives) {
  for (const entry of archive.entries) {
    const reason = forbiddenPackageReason(entry.path);
    if (reason) throw new Error(`refusing to package ${entry.path}: matched ${reason}`);
  }
}

const built = archives.map((archive) => {
  const data = buildDeterministicZip(archive.entries);
  return { ...archive, data, digest: sha256(data), files: archive.entries.length };
});

if (options.check) {
  const expected = built.map((archive) => `${archive.digest.split(':')[1]}  ${archive.name}`).join('\n');
  const sumsPath = path.join(options.out, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsPath) || fs.readFileSync(sumsPath, 'utf8').trim() !== expected) {
    console.error(`Release checksums are missing or stale in ${path.relative(repositoryRoot, sumsPath)}. Run npm run build:release.`);
    process.exit(1);
  }
  console.log(`Release archives are present and reproducible (${archives.length} artifacts, v${version}).`);
  process.exit(0);
}

fs.mkdirSync(options.out, { recursive: true });
for (const archive of built) fs.writeFileSync(path.join(options.out, archive.name), archive.data);
fs.writeFileSync(
  path.join(options.out, 'SHA256SUMS.txt'),
  `${built.map((archive) => `${archive.digest.split(':')[1]}  ${archive.name}`).join('\n')}\n`,
  'utf8',
);

for (const archive of built) {
  console.log(`${archive.name}  ${archive.files} files  ${archive.data.length} bytes  ${archive.digest}`);
}
