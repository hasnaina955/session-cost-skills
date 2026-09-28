import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboard as renderClineDashboard } from '../scripts/lib/dashboard.mjs';
import { renderDashboard as renderMcodeDashboard } from '../../../mcode/skill/scripts/lib/dashboard.mjs';

const attack = '<img src=x onerror="globalThis.__dashboardXss = true">';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this._innerHTML = '';
    this.classList = {
      values: new Set(),
      add: (...values) => values.forEach((value) => this.classList.values.add(value)),
      toggle: (value) => {
        if (this.classList.values.has(value)) {
          this.classList.values.delete(value);
          return false;
        }
        this.classList.values.add(value);
        return true;
      },
    };
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelectorAll() {
    return [];
  }
}

function runBrowserScript(html) {
  const match = html.match(/<script nonce="([0-9a-f]{32})">([\s\S]*?)<\/script>/);
  assert.ok(match, 'dashboard must contain a nonce-bearing inline script');
  const ids = [
    'themeToggle',
    'formatToggle',
    'sessionFilter',
    'providerFilter',
    'modelFilter',
    'dayFilter',
    'filterStatus',
    'cards',
    'trendChart',
    'modelChart',
    'filterTables',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const document = {
    body: new FakeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
  };
  const storage = new Map();
  vm.runInNewContext(match[2], {
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  });
  return { nonce: match[1], elements };
}

function assertNoExecutableMarkup(value) {
  assert.doesNotMatch(value, /<\s*img\b/i, 'unescaped image markup reached an HTML sink');
  const tags = value.match(/<[a-z][^>]*>/gi) ?? [];
  for (const tag of tags) assert.doesNotMatch(tag, /\son[a-z][\w:-]*\s*=/i, 'inline event handler reached an HTML sink');
}

function assertSafeDashboard(html, { expectModelOption = false } = {}) {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.ok(csp, 'dashboard must include a CSP');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /style-src-attr 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i);
  assert.doesNotMatch(html, /\sstyle=/i);

  const { nonce, elements } = runBrowserScript(html);
  assert.match(csp, new RegExp(`script-src 'nonce-${nonce}'`));
  assert.match(csp, new RegExp(`style-src 'nonce-${nonce}'`));
  assert.match(html, new RegExp(`<style nonce="${nonce}">`));

  for (const element of elements.values()) {
    assertNoExecutableMarkup(element.innerHTML);
    for (const child of element.children) assert.equal(typeof child.textContent, 'string');
  }

  const modelOption = elements.get('modelFilter').children.at(-1);
  if (expectModelOption) assert.equal(modelOption?.textContent, attack, 'model options must use textContent, not HTML parsing');
  assert.ok(
    [...elements.values()].some((element) => element.innerHTML.includes('&lt;img')),
    'the browser render path must contain the escaped malicious value',
  );
}

function regularReport() {
  return {
    generatedAt: attack,
    session: { id: attack },
    models: [{ provider: attack, model: attack, calls: 1, totalTokens: 10, totalCost: 1 }],
    periods: { daily: [{ from: attack, label: attack, totalTokens: 10, totalCost: 1 }] },
    sessions: [{ id: attack, title: attack, metrics: { calls: 1, totalTokens: 10, totalCost: 1 } }],
  };
}

function rateReport() {
  return {
    rates: {
      refreshedAt: attack,
      providers: {
        [attack]: { models: attack, fetchedAt: attack, source: attack },
      },
    },
  };
}

for (const [name, renderDashboard] of [
  ['Cline', renderClineDashboard],
  ['MCode', renderMcodeDashboard],
]) {
  test(`${name} dashboard escapes browser-rendered values and keeps a strict CSP`, () => {
    assertSafeDashboard(renderDashboard(regularReport(), { title: attack }), { expectModelOption: true });
    assertSafeDashboard(renderDashboard(rateReport(), { title: attack }));
  });
}
