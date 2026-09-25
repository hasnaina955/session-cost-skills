// Every third-party action in a workflow must be pinned to a full commit SHA.
// A mutable tag such as `@v4` lets a third party change what runs in this
// repository without a pull request, which is exactly what release CI must not do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');
const workflows = fs.readdirSync(workflowDir).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));
assert.ok(workflows.length > 0, 'no GitHub Actions workflows were found');

const SHA = /^[a-f0-9]{40}$/;
for (const file of workflows) {
  const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');
  for (const [, action, ref] of text.matchAll(/^\s*-?\s*uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/gm)) {
    assert.match(
      ref,
      SHA,
      `${file} pins ${action} to "${ref}"; every action must be pinned to a full 40-character commit SHA`,
    );
    assert.doesNotMatch(ref, /^\d+$/, `${file} pins ${action} to a mutable tag`);
  }
  if (file !== 'ci.yml') continue;
  assert.match(text, /^permissions:\s*\n\s+contents: read/m, 'ci.yml must declare least-privilege contents: read');
}

console.log(`Workflow action pins verified (${workflows.length} workflow(s), all uses: pinned to full SHAs).`);
