const amount = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function normalizedUsage(fields, { complete = true } = {}) {
  const coreFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const missing = coreFields.filter((key) => fields[key] === null);
  return {
    ...fields,
    coverage: !complete ? 'unavailable' : missing.length === 0 ? 'complete' : 'partial',
    missingComponents: missing,
  };
}

export function normalizeOpenAIUsage(payload) {
  const usage = payload?.usage ?? payload;
  const hasUsage = usage && typeof usage === 'object' && ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'prompt_tokens_details']
    .some((key) => Object.hasOwn(usage, key));
  if (!hasUsage) {
    return normalizedUsage({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    }, { complete: false });
  }
  const promptTokens = amount(usage.prompt_tokens ?? usage.input_tokens);
  const cacheReadTokens = amount(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
  return normalizedUsage({
    inputTokens: promptTokens === null ? null : Math.max(0, promptTokens - (cacheReadTokens ?? 0)),
    outputTokens: amount(usage.completion_tokens ?? usage.output_tokens),
    cacheReadTokens,
    cacheWriteTokens: amount(usage.prompt_tokens_details?.cache_creation_tokens ?? usage.cache_creation_tokens),
    reasoningTokens: amount(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens),
  });
}

export function parseOpenAICompatibleStream(text) {
  const events = [];
  let model = null;
  let usage = null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const event = JSON.parse(payload);
    events.push(event);
    model = event.model ?? model;
    if (event.usage) usage = event.usage;
  }
  return { protocol: 'openai-compatible', model, events, usage, normalizedUsage: normalizeOpenAIUsage(usage ? { usage } : null) };
}

export function normalizeAnthropicUsage(payload) {
  const usage = payload?.usage ?? payload;
  const hasUsage = usage && typeof usage === 'object' && ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .some((key) => Object.hasOwn(usage, key));
  if (!hasUsage) {
    return normalizedUsage({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    }, { complete: false });
  }
  return normalizedUsage({
    inputTokens: amount(usage.input_tokens),
    outputTokens: amount(usage.output_tokens),
    cacheReadTokens: amount(usage.cache_read_input_tokens),
    cacheWriteTokens: amount(usage.cache_creation_input_tokens),
    reasoningTokens: null,
  });
}

export function parseAnthropicCompatibleStream(text) {
  const events = [];
  let model = null;
  const usage = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = JSON.parse(trimmed);
    events.push(event);
    model = event.message?.model ?? event.model ?? model;
    const incoming = event.message?.usage ?? event.usage;
    if (!incoming) continue;
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (Number.isFinite(incoming[key])) usage[key] = incoming[key];
    }
  }
  return {
    protocol: 'anthropic-compatible',
    model,
    events,
    usage: Object.keys(usage).length ? usage : null,
    normalizedUsage: normalizeAnthropicUsage(Object.keys(usage).length ? usage : null),
  };
}

export const PROTOCOL_ADAPTERS = Object.freeze({
  'openai-compatible': Object.freeze({
    normalizeUsage: normalizeOpenAIUsage,
    parseStream: parseOpenAICompatibleStream,
  }),
  'anthropic-compatible': Object.freeze({
    normalizeUsage: normalizeAnthropicUsage,
    parseStream: parseAnthropicCompatibleStream,
  }),
});
