import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCard } from '../shared/card.mjs';
import { removeDirectory } from './helpers/temp-dir.mjs';
import { mcodeScript, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const PINNED = '2026-06-15T18:00:00.000Z';

function report(sessionId = 'mcode-root') {
  const fixture = createMCodeFixture();
  return runJson(mcodeScript, fixture.dataDir, ['--session', sessionId, '--include-children', '--json'],
    { ...fixture.environment, SESSION_COST_NOW: PINNED }).output;
}

test('a card is a self-contained, well-formed SVG carrying the figures', () => {
  const svg = renderCard(report(), { generatedAt: '2026-06-15 18:00 UTC' });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'a card is one svg element');
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 1200 630"/, 'the Open Graph share size');
  assert.match(svg, /<title>/, 'a card needs a title for a screen reader and a file listing');
  assert.match(svg, /<desc>[^<]*\$0\.0005/, 'the description states the total');
  assert.match(svg, /494 tokens/, 'the description states the token count');
  assert.doesNotMatch(svg, /<script|<image|href=/i);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, 'nothing may be referenced');
});

test('a card leaks no session title, id, or path by default', () => {
  // The card is the artefact most likely to leave this machine, so identifiers are opt-in.
  // A cost summary does not need the name of the session to be useful.
  const source = report();
  const svg = renderCard(source);
  assert.ok(!svg.includes('Root contract fixture'), 'a session title must not appear');
  assert.ok(!svg.includes('mcode-root'), 'a session id must not appear');
  assert.match(svg, /no session data leaves this machine/, 'and it says so');
});

test('a title appears only when explicitly asked for', () => {
  const svg = renderCard(report(), { includeTitle: true });
  assert.ok(svg.includes('Root contract fixture'), 'includeTitle is how a title gets in');
});

test('markup in a title cannot escape the SVG', () => {
  const source = { ...report(), title: '</text><script>alert(1)</script>' };
  for (const includeTitle of [false, true]) {
    const svg = renderCard(source, { includeTitle });
    assert.doesNotMatch(svg, /<script>/, 'a title must never become a script element');
  }
});

test('a card for a session with nothing priced says so rather than showing a zero', () => {
  // The silent-zero failure, in the most shareable format this project has. A card showing
  // $0.00 for a session nobody could price is the worst artefact it can produce, because it is
  // the one designed to be passed on.
  const svg = renderCard(report('mcode-unpriced'));
  assert.doesNotMatch(svg, /\$0\.00(?![\d])/, 'no zero cost may stand in for an unknown one');
  assert.match(svg, /unavailable/, 'the card states the cost is unavailable');
  assert.match(svg, /no priced calls|partial coverage/i);
  assert.match(svg, /could not be priced/, 'an unpriced model is disclosed, even when nothing priced');
});

test('a partially priced card discloses the gap', () => {
  const svg = renderCard(report('mcode-partial'));
  assert.match(svg, /partial coverage/i);
  assert.doesNotMatch(svg, /\$0\.00(?![\d])/);
});

test('the plain variant carries a light background and no unresolved custom property', () => {
  const dark = renderCard(report());
  const plain = renderCard(report(), { plain: true });
  assert.match(plain, /fill="#ffffff"/, 'a plain card is for pasting into a document');
  assert.doesNotMatch(plain, /var\(--/, 'and does not depend on a CSS variable that will not resolve');
  assert.notEqual(dark, plain);
});

test('a card is small enough to send and deterministic', () => {
  const source = report();
  const first = renderCard(source, { generatedAt: 'fixed' });
  const second = renderCard(source, { generatedAt: 'fixed' });
  assert.equal(first, second, 'the same report must produce the same card');
  assert.ok(first.length < 20_000, `a card should stay small, got ${first.length} bytes`);
});

// --- End to end: the flag is wired and the privacy guarantee holds ---

test('--card writes a card, and a session title never appears without the opt-in flag', async () => {
  const { mcodeScript, createMCodeFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
  try {
    const fixture = createMCodeFixture();
    const out = path.join(dir, 'card.svg');
    const result = runCli(mcodeScript, fixture.dataDir,
      ['--session', 'mcode-root', '--include-children', '--card', '--out', out],
      { ...fixture.environment, NO_COLOR: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Card written/);
    const svg = fs.readFileSync(out, 'utf8');
    assert.ok(svg.startsWith('<svg'), 'the output is an SVG file');
    assert.match(svg, /\$0\.0005/, 'the cost is on the card');
    // The guarantee: a card is the one artefact designed to leave the machine, so the session
    // title is opt-in. Without the flag it must not appear at all.
    assert.ok(!svg.includes('Root contract fixture'), 'the session title must not appear by default');
    assert.ok(!svg.includes('mcode-root'), 'the session id must not appear by default');
    assert.match(svg, /no session data leaves this machine/, 'and the card says so');

    // With the flag, the title is there - the opt-in is the only way it gets in.
    const out2 = path.join(dir, 'card-titled.svg');
    runCli(mcodeScript, fixture.dataDir,
      ['--session', 'mcode-root', '--include-children', '--card', '--card-include-title', '--out', out2],
      { ...fixture.environment, NO_COLOR: '1' });
    assert.ok(fs.readFileSync(out2, 'utf8').includes('Root contract fixture'),
      '--card-include-title is how a title gets in');
  } finally {
    removeDirectory(dir);
  }
});

test('a card for an unpriced session states unavailable and never a zero', async () => {
  const { mcodeScript, createMCodeFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-unpriced-'));
  try {
    const fixture = createMCodeFixture();
    const out = path.join(dir, 'card.svg');
    // exit 2 is the unpriceable verdict; the card is still written.
    const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-unpriced', '--card', '--out', out],
      { ...fixture.environment, NO_COLOR: '1' });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /Card written/);
    const svg = fs.readFileSync(out, 'utf8');
    assert.match(svg, /unavailable/, 'the card states the cost is unavailable');
    assert.doesNotMatch(svg, /\$0\.00(?!\d)/, 'no zero stands in for an unknown cost');
    assert.match(svg, /could not be priced/, 'the unpriced model is disclosed');
  } finally {
    removeDirectory(dir);
  }
});

test('Cline writes a card too, with the same privacy default', async () => {
  const { clineScript, createClineFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-cline-'));
  try {
    const fixture = createClineFixture();
    const out = path.join(dir, 'card.svg');
    const result = runCli(clineScript, fixture.dataDir, ['--session', 'cline-root', '--card', '--out', out], { NO_COLOR: '1' });
    assert.equal(result.status, 0, result.stderr);
    const svg = fs.readFileSync(out, 'utf8');
    assert.match(svg, /\$0\.15/, 'Cline recorded cost is on the card');
    assert.ok(!svg.includes('Root contract fixture'), 'the title stays private by default');
  } finally {
    removeDirectory(dir);
  }
});
