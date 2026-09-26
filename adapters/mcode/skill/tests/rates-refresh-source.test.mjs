import test from 'node:test';
import assert from 'node:assert/strict';
import { RATES_SOURCE, fetchText, isAllowedRateContentType } from '../scripts/lib/rates.mjs';

// Every configured rate source and the content-type allowlist are two independent declarations
// of the same fact: "this URL is a document we are allowed to read". When they drift, the
// refresh rejects its own configured source and can never succeed.
//
// This is not hypothetical. RATES_SOURCE.stepfun is a raw `.md` document that correctly answers
// `content-type: text/markdown`, and `text/markdown` was absent from the allowlist. Every
// `--refresh-rates` therefore failed on stepfun, and because the refresh is transactional the
// successful CommandCode fetch was thrown away with it. Rate tables silently froze, and because
// the failure surfaced as a plain error rather than a wrong number, nothing looked wrong.

/** A URL that ends in `.md` is a markdown document and must be readable as one. */
function contentTypeForUrl(url) {
  if (/\.md(?:$|\?)/i.test(url)) return 'text/markdown; charset=utf-8';
  return 'text/html; charset=utf-8';
}

test('every configured rate source passes the content-type allowlist', () => {
  for (const [provider, url] of Object.entries(RATES_SOURCE)) {
    const contentType = contentTypeForUrl(url);
    assert.ok(
      isAllowedRateContentType(contentType),
      `${provider}: ${url} is served as ${contentType}, which the allowlist rejects — `
      + '--refresh-rates could never succeed for this provider',
    );
  }
});

test('a markdown rate source is fetched, not rejected', async () => {
  // The stepfun source in particular. This is the exact call that used to throw
  // "rate source returned an unexpected content type (text/markdown)".
  const markdown = 'text/markdown; charset=utf-8';
  let seen = null;
  const body = await fetchText('https://platform.stepfun.ai/docs/en/guides/pricing/details.md', {
    fetcher: async () => {
      seen = markdown;
      return {
        ok: true,
        headers: { get: (name) => (name === 'content-type' ? markdown : null) },
        text: async () => '# pricing',
      };
    },
  });
  assert.equal(seen, markdown);
  assert.equal(body, '# pricing', 'the body must be returned, not rejected');
});

test('a genuinely hostile content type is still refused', () => {
  // Widening the allowlist must not turn into "accept anything".
  assert.equal(isAllowedRateContentType('text/markdown'), true);
  assert.equal(isAllowedRateContentType('text/html; charset=utf-8'), true);
  assert.equal(isAllowedRateContentType('application/octet-stream'), false);
  assert.equal(isAllowedRateContentType('application/zip'), false);
  assert.equal(isAllowedRateContentType('image/png'), false);
});
