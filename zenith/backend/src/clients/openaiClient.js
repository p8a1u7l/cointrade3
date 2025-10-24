import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { buildPrompt } from '../llm/prompts.js';
import { logger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/http.js';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const OPENAI_HTTP_OPTIONS = {
  timeoutMs: config.openAi.http?.timeoutMs ?? 15_000,
  retries: config.openAi.http?.maxRetries ?? 2,
  retryDelayMs: config.openAi.http?.retryDelayMs ?? 500,
};
const OPENAI_RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const PRIMARY_MODEL = config.openAi.primaryModel ?? 'gpt-5-mini';
const FALLBACK_MODEL = config.openAi.fallbackModel;
const MAX_OUTPUT_TOKENS = config.openAi.maxOutputTokens ?? 64;

const MIN_DECISION_INTERVAL_MS = Math.max(0, config.openAi.minDecisionIntervalMs ?? 45_000);
const FINGERPRINT_DECIMALS = Math.max(0, Math.min(6, config.openAi.fingerprintDecimals ?? 3));
const FINGERPRINT_ARRAY_SAMPLE = Math.max(1, Math.floor(config.openAi.fingerprintArraySample ?? 24));
const MAX_FINGERPRINT_DEPTH = 6;

const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitTimestamps = [];

const decisionCache = new Map();
const lastDecisions = new Map();

const cloneDecision = (value) => JSON.parse(JSON.stringify(value));

const hashPrompt = (prompt) => crypto.createHash('sha1').update(prompt).digest('hex');

const normalizeValue = (value, depth = 0) => {
  if (depth >= MAX_FINGERPRINT_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    const slice = value.length > FINGERPRINT_ARRAY_SAMPLE
      ? value.slice(-FINGERPRINT_ARRAY_SAMPLE)
      : value;
    return slice.map((item) => normalizeValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([key]) => typeof key === 'string')
      .sort(([a], [b]) => a.localeCompare(b));
    const normalized = {};
    for (const [key, val] of entries) {
      normalized[key] = normalizeValue(val, depth + 1);
    }
    return normalized;
  }
  if (typeof value === 'number') {
    const factor = 10 ** FINGERPRINT_DECIMALS;
    return Math.round(value * factor) / factor;
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  return String(value ?? '');
};

const computeMarketFingerprint = (marketContext) => {
  if (!marketContext) {
    return 'none';
  }
  try {
    const parsed = typeof marketContext === 'string' ? JSON.parse(marketContext) : marketContext;
    const normalized = normalizeValue(parsed);
    return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
  } catch (_error) {
    const serialized =
      typeof marketContext === 'string'
        ? marketContext
        : JSON.stringify(marketContext, Object.keys(marketContext ?? {}).sort());
    return crypto.createHash('sha1').update(serialized).digest('hex');
  }
};

const rememberDecision = (symbol, fingerprint, decision) => {
  if (!symbol) {
    return;
  }
  lastDecisions.set(symbol, {
    fingerprint,
    decision: cloneDecision(decision),
    timestamp: Date.now(),
  });
};

const enforceRateLimit = async () => {
  const limit = config.openAi.maxRequestsPerMinute;
  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }

  while (true) {
    const now = Date.now();
    while (rateLimitTimestamps.length > 0 && now - rateLimitTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
      rateLimitTimestamps.shift();
    }
    if (rateLimitTimestamps.length < limit) {
      rateLimitTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(RATE_LIMIT_WINDOW_MS - (now - rateLimitTimestamps[0]) + 5, 25);
    logger.debug({ waitMs }, 'OpenAI rate limit reached, delaying request');
    await delay(waitMs);
  }
};

const getCachedDecision = (cacheKey) => {
  if (!cacheKey || config.openAi.cacheTtlMs <= 0) {
    return undefined;
  }
  const entry = decisionCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    decisionCache.delete(cacheKey);
    return undefined;
  }
  return cloneDecision(entry.value);
};

const setCachedDecision = (cacheKey, decision) => {
  if (!cacheKey || config.openAi.cacheTtlMs <= 0) {
    return;
  }
  decisionCache.set(cacheKey, {
    value: cloneDecision(decision),
    expiresAt: Date.now() + config.openAi.cacheTtlMs,
  });
};

function extractUsage(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const coerce = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  };

  const promptTokens =
    coerce(usage.input_tokens) ?? coerce(usage.prompt_tokens) ?? coerce(usage.promptTokens);
  const completionTokens =
    coerce(usage.output_tokens) ?? coerce(usage.completion_tokens) ?? coerce(usage.completionTokens);
  const totalTokens =
    coerce(usage.total_tokens) ?? coerce(usage.totalTokens) ??
    (promptTokens ?? 0) + (completionTokens ?? 0);

  const inputCost = coerce(usage.input_cost) ?? coerce(usage.prompt_cost) ?? coerce(usage.inputCost);
  const outputCost =
    coerce(usage.output_cost) ?? coerce(usage.completion_cost) ?? coerce(usage.outputCost);
  let totalCost = coerce(usage.total_cost) ?? coerce(usage.totalCost);
  if (totalCost === undefined) {
    const parts = [inputCost, outputCost].filter((value) => value !== undefined);
    if (parts.length > 0) {
      totalCost = parts.reduce((sum, value) => sum + value, 0);
    }
  }

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    inputCost: inputCost ?? 0,
    outputCost: outputCost ?? 0,
    totalCost: totalCost ?? 0,
  };
}

async function callOpenAi(prompt, model) {
  const response = await fetchWithRetry(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openAi.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
    timeoutMs: OPENAI_HTTP_OPTIONS.timeoutMs,
    retries: OPENAI_HTTP_OPTIONS.retries,
    retryDelayMs: OPENAI_HTTP_OPTIONS.retryDelayMs,
    retryOn: OPENAI_RETRY_STATUS,
  });

  const raw = await response.text();
  let data;
  try {
    data = raw.length > 0 ? JSON.parse(raw) : {};
  } catch (error) {
    const parseError = new Error('Failed to parse OpenAI response payload');
    parseError.cause = error;
    parseError.body = raw;
    throw parseError;
  }

  if (!response.ok) {
    const message =
      typeof data?.error?.message === 'string'
        ? `OpenAI responded with status ${response.status}: ${data.error.message}`
        : `OpenAI responded with status ${response.status}`;
    const error = new Error(message);
    error.body = data;
    throw error;
  }

  if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
    return { text: data.output_text, usage: extractUsage(data) };
  }

  const choices = Array.isArray(data.output) ? data.output : [];
  for (const choice of choices) {
    const content = Array.isArray(choice.content) ? choice.content : [];
    for (const block of content) {
      if (typeof block.text === 'string' && block.text.trim().length > 0) {
        return { text: block.text, usage: extractUsage(data) };
      }
    }
  }

  const error = new Error('OpenAI response did not include text content');
  error.body = data;
  throw error;
}

export async function requestStrategy(symbol, marketContext) {
  const prompt = buildPrompt(symbol, marketContext);
  const cacheKey = config.openAi.cacheTtlMs > 0 ? hashPrompt(prompt) : undefined;
  const fingerprint = computeMarketFingerprint(marketContext);
  const cached = getCachedDecision(cacheKey);
  if (cached) {
    logger.debug({ symbol }, 'Reusing cached OpenAI decision');
    rememberDecision(symbol, fingerprint, cached);
    return cached;
  }

  const last = symbol ? lastDecisions.get(symbol) : undefined;
  const now = Date.now();
  if (last && last.fingerprint === fingerprint) {
    logger.debug({ symbol }, 'Market fingerprint unchanged, reusing last decision');
    last.timestamp = now;
    return cloneDecision(last.decision);
  }
  if (last && now - last.timestamp < MIN_DECISION_INTERVAL_MS) {
    logger.debug({
      symbol,
      waitedMs: now - last.timestamp,
      minMs: MIN_DECISION_INTERVAL_MS,
    }, 'Skipping OpenAI call due to minimum decision interval');
    return cloneDecision(last.decision);
  }

  await enforceRateLimit();

  const triedModels = new Set();
  const modelQueue = [PRIMARY_MODEL, FALLBACK_MODEL].filter((model) => model && !triedModels.has(model));
  let text;
  let usage;
  let lastError;

  for (const model of modelQueue) {
    triedModels.add(model);
    try {
      ({ text, usage } = await callOpenAi(prompt, model));
      logger.debug({ symbol, model }, 'Received OpenAI decision');
      break;
    } catch (error) {
      lastError = error;
      logger.warn({ symbol, model, err: error }, 'OpenAI call failed, considering fallback model');
    }
  }

  if (!text) {
    throw lastError ?? new Error('OpenAI request failed without a response');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const parseError = new Error('Failed to parse OpenAI strategy JSON');
    parseError.cause = error;
    parseError.body = text;
    throw parseError;
  }
  const bias = parsed.bias;
  if (!['long', 'short', 'flat'].includes(bias)) {
    throw new Error('Invalid bias returned from OpenAI');
  }
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) {
    const asString = typeof parsed.confidence === 'string' ? parsed.confidence.trim() : '';
    if (asString.endsWith('%')) {
      const percent = Number(asString.slice(0, -1));
      confidence = percent / 100;
    }
  }
  if (!Number.isFinite(confidence)) {
    throw new Error('Invalid confidence returned from OpenAI');
  }
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
    ? parsed.reasoning
    : 'No reasoning provided';
  const result = {
    symbol: typeof parsed.symbol === 'string' && parsed.symbol.length > 0 ? parsed.symbol : symbol,
    bias: bias,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning,
    usage,
  };
  setCachedDecision(cacheKey, result);
  rememberDecision(symbol, fingerprint, result);
  return result;
}
