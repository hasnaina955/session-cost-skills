import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColor, relativeLuminance, contrastRatio, auditTheme } from '../shared/contrast.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(path.join(repositoryRoot, 'shared', 'dashboard.mjs'), 'utf8');

function tokensFrom(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+)/g)].map((match) => [match[1], match[2].trim()]));
}

const themes = {
  dark: tokensFrom(/:root\{([^}]*)\}/.exec(dashboard)[1]),
  light: tokensFrom(/body\.theme-light\{([^}]*)\}/.exec(dashboard)[1]),
};

test('the contrast maths is right, so a failure below means a colour', () => {
  // A contrast helper that is itself wrong would make this file a rubber stamp. These are the
  // two anchors from the WCAG definition.
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00');
  assert.ok(Math.abs(relativeLuminance('#808080') - 0.2158) < 0.001, 'mid grey luminance is about 0.216');
  // Ratio is symmetric, so a foreground/background swap cannot change the answer.
  assert.equal(contrastRatio('#123456', '#fedcba'), contrastRatio('#fedcba', '#123456'));
});

test('a colour this cannot read is a failure, not a silent pass', () => {
  assert.equal(parseColor('nonsense'), null);
  assert.equal(contrastRatio('nonsense', '#fff'), null);
  const audit = auditTheme({ text: 'nonsense', bg: '#fff', surface: '#fff', muted: '#fff', accent: '#fff', 'accent-2': '#fff', warning: '#fff', danger: '#fff', line: '#fff' });
  assert.equal(audit.pass, false, 'an unreadable colour must fail the audit rather than be skipped');
});

for (const [name, tokens] of Object.entries(themes)) {
  test(`the ${name} theme meets WCAG contrast for text and chart marks`, () => {
    const audit = auditTheme(tokens);
    const report = audit.failures
      .map((failure) => `${failure.name}: ${failure.ratio?.toFixed(2) ?? 'unreadable'} (needs ${failure.minimum})`)
      .join('\n');
    assert.equal(audit.failures.length, 0, `the ${name} theme fails contrast:\n${report}`);
  });
}

test('both themes declare the same tokens, so one cannot silently lose a colour', () => {
  const shared = ['bg', 'surface', 'text', 'muted', 'accent', 'accent-2', 'warning', 'danger'];
  for (const token of shared) {
    assert.ok(themes.dark[token], `the dark theme is missing --${token}`);
    assert.ok(themes.light[token], `the light theme is missing --${token}`);
  }
});

test('the dashboard honours prefers-color-scheme, so it does not flash the wrong theme', () => {
  assert.match(dashboard, /prefers-color-scheme/,
    'a page that renders dark for someone set to light is wrong before it is clicked');
});

test('every interactive control has a visible focus ring', () => {
  // Keyboard users navigate by focus. A control reachable by Tab and invisible while focused is
  // worse than one that is not focusable, because there is no way to tell where you are.
  assert.match(dashboard, /:focus-visible\{[^}]*outline/,
    'a :focus-visible rule with an outline is required');
  const focusRules = /:focus-visible\{([^}]*)\}/.exec(dashboard)?.[1] ?? '';
  assert.match(focusRules, /outline:\s*3px/, 'the focus ring needs a visible width, not a hairline');
  // Every control the page renders is a real button, input, or select - never a styled div.
  assert.doesNotMatch(dashboard, /<div[^>]*onclick=/i, 'a clickable div is not keyboard reachable');
  assert.match(dashboard, /<button id="themeToggle"[^>]*type="button"/, 'the theme toggle must be a button element');
});
