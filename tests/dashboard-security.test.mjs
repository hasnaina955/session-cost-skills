import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderDashboard as renderClineDashboard } from '../adapters/cline/skill/scripts/lib/dashboard.mjs';
import { renderDashboard as renderMcodeDashboard } from '../adapters/mcode/skill/scripts/lib/dashboard.mjs';

const canonicalSource = fs.readFileSync(new URL('../shared/dashboard.mjs', import.meta.url), 'utf8');

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.data = String(value);
  }

  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(tagName, namespace = null) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.namespace = namespace;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    };
    for (const sink of ['innerHTML', 'outerHTML']) {
      Object.defineProperty(this, sink, {
        get() { throw new Error(`unsafe ${sink} read`); },
        set() { throw new Error(`unsafe ${sink} write`); },
      });
    }
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = value === '' ? [] : [new FakeText(value)];
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }

  insertAdjacentHTML() {
    throw new Error('unsafe insertAdjacentHTML write');
  }

  descendants() {
    return this.children.flatMap((child) => (
      child.nodeType === 1 ? [child, ...child.descendants()] : []
    ));
  }

  findTag(tagName) {
    return this.descendants().find((node) => node.tagName === tagName.toUpperCase()) ?? null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.body = new FakeElement('body');
    for (const id of [
      'themeToggle',
      'formatToggle',
      'providerFilter',
      'modelFilter',
      'sessionFilter',
      'dayFilter',
      'filterStatus',
      'cards',
      'trendChart',
      'modelChart',
      'filterTables',
      'resetFilters',
    ]) {
      this.elements.set(id, new FakeElement(id === 'resetFilters' ? 'button' : 'div'));
    }
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createElementNS(namespace, tagName) {
    return new FakeElement(tagName, namespace);
  }

  createTextNode(value) {
    return new FakeText(value);
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  descendants() {
    return [...this.elements.values()].flatMap((element) => [element, ...element.descendants()]);
  }

  findTag(tagName) {
    return this.descendants().find((node) => node.tagName === tagName.toUpperCase()) ?? null;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function extractBrowserScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'dashboard must contain its self-contained browser runtime');
  return match[1];
}

function executeBrowserRuntime(html) {
  const document = new FakeDocument();
  const context = vm.createContext({
    console,
    document,
    localStorage: createStorage(),
  });
  vm.runInContext(extractBrowserScript(html), context, { timeout: 1_000 });
  return document;
}

function assertNoExecutableNodes(document) {
  assert.equal(document.findTag('script'), null);
  assert.equal(document.findTag('img'), null);
  assert.equal(document.findTag('iframe'), null);
  assert.equal(document.findTag('object'), null);
  assert.equal(document.findTag('embed'), null);
  for (const node of document.descendants()) {
    for (const name of node.attributes.keys()) {
      assert.doesNotMatch(name, /^on/i, `unexpected event attribute ${name}`);
    }
  }
}

const renderers = [
  ['Cline', renderClineDashboard],
  ['MCode', renderMcodeDashboard],
];


test('every installable adapter contains the canonical dashboard renderer', () => {
  for (const adapter of ['cline', 'mcode', 'opencode']) {
    const adapterSource = fs.readFileSync(new URL(
      `../adapters/${adapter}/skill/scripts/lib/dashboard.mjs`,
      import.meta.url,
    ), 'utf8');
    assert.equal(adapterSource, canonicalSource);
  }
});

for (const [name, renderDashboard] of renderers) {
  test(`${name} dashboard uses a hash-locked, offline browser runtime`, () => {
    const html = renderDashboard({
      generatedAt: '2026-01-01T00:00:00.000Z',
      models: [{ provider: 'test', model: 'model', totalTokens: 10 }],
      sessions: [],
    }, { title: 'Security test' });
    const script = extractBrowserScript(html);
    const digest = crypto.createHash('sha256').update(script).digest('base64');
    const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1]
      .replaceAll('&#39;', "'");

    assert.ok(policy);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /connect-src 'none'/);
    assert.ok(policy.includes(`script-src 'sha256-${digest}'`));
    assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(script, /\.(?:innerHTML|outerHTML)|insertAdjacentHTML|document\.write|eval\(|new Function/);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i);
  });
}


const attacks = {
  provider: `"><img src=x onerror="globalThis.pwned=true">`,
  model: `</option></select><svg onload="globalThis.pwned=true">`,
  session: `</td></tr><script>globalThis.pwned=true</script>`,
  title: `<script id="injected-title">globalThis.pwned=true</script>`,
  day: `"><img src=x onerror="globalThis.pwned=true">`,
};

for (const [name, renderDashboard] of renderers) {
  test(`${name} browser rendering keeps malicious report values inert`, () => {
    const report = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      totalTokens: 12,
      cacheRate: 0.25,
      totalCost: 1,
      models: [{
        provider: attacks.provider,
        model: attacks.model,
        calls: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        totalTokens: 12,
        totalCost: 1,
        rateKnown: true,
      }],
      sessions: [{
        id: attacks.session,
        title: attacks.title,
        metrics: {
          calls: 1,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          totalCost: 1,
          models: [{ model: attacks.model }],
        },
      }],
      periods: {
        daily: [{
          from: attacks.day,
          requests: 1,
          totalTokens: 12,
          totalCost: 1,
        }],
      },
    };
    const html = renderDashboard(report, { title: attacks.title });
    for (const value of Object.values(attacks)) {
      assert.equal(html.includes(value), false, 'raw payload must not reach an HTML sink');
    }

    const document = executeBrowserRuntime(html);
    assertNoExecutableNodes(document);
    const renderedText = [
      'cards',
      'filterTables',
      'modelChart',
      'trendChart',
      'providerFilter',
      'modelFilter',
      'sessionFilter',
      'dayFilter',
      'filterStatus',
    ].map((id) => document.getElementById(id).textContent).join('\n');
    for (const value of Object.values(attacks)) {
      assert.ok(renderedText.includes(value), `browser output should preserve ${value} as text`);
    }

    const provider = document.getElementById('providerFilter');
    const model = document.getElementById('modelFilter');
    const session = document.getElementById('sessionFilter');
    const day = document.getElementById('dayFilter');
    assert.ok(provider.descendants().some((node) => node.getAttribute('value') === attacks.provider));
    assert.ok(model.descendants().some((node) => node.getAttribute('value') === attacks.model));
    assert.ok(session.descendants().some((node) => node.getAttribute('value') === attacks.session));
    assert.ok(day.descendants().some((node) => node.getAttribute('value') === attacks.day));

    provider.value = attacks.provider;
    provider.dispatch('input');
    model.value = attacks.model;
    model.dispatch('input');
    session.value = attacks.session;
    session.dispatch('change');
    day.value = attacks.day;
    day.dispatch('change');
    document.getElementById('resetFilters').dispatch('click');
    assertNoExecutableNodes(document);
  });

  test(`${name} rate coverage rendering keeps provider metadata inert`, () => {
    const html = renderDashboard({
      generatedAt: '2026-01-01T00:00:00.000Z',
      rates: {
        refreshedAt: attacks.day,
        providers: {
          [attacks.provider]: {
            models: 1,
            fetchedAt: attacks.day,
            source: attacks.title,
          },
        },
      },
    });
    const document = executeBrowserRuntime(html);
    assertNoExecutableNodes(document);
    const text = document.getElementById('filterTables').textContent
      + document.getElementById('cards').textContent;
    assert.ok(text.includes(attacks.provider));
    assert.ok(text.includes(attacks.day));
    assert.ok(text.includes(attacks.title));
  });
}
