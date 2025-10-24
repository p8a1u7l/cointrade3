import { loadEnvFile } from './utils/env.js';

loadEnvFile();

const optionalEnv = (name) => {
  const value = process.env[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' ? undefined : trimmed;
};

const parseNumber = (value, fallback) => {
  const source = value ?? fallback;
  if (source === undefined || source === null || (typeof source === 'string' && source.trim().length === 0)) {
    if (fallback === undefined) {
      throw new Error('Missing numeric configuration value');
    }
    return parseNumber(fallback, undefined);
  }
  const numeric = Number(source);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid numeric configuration: ${source}`);
  }
  return numeric;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseSymbols = (value) => {
  const raw = value && value.trim().length > 0 ? value : 'BTCUSDT,ETHUSDT';
  return raw
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
};

const parseList = (value, fallback) => {
  const source = value && value.trim().length > 0 ? value : fallback;
  return source
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
};

const ensureValue = (value, name) => {
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const envBinanceKey = optionalEnv('BINANCE_API_KEY');
const envBinanceSecret = optionalEnv('BINANCE_API_SECRET');
const envOpenAiKey = optionalEnv('OPENAI_API_KEY');

const binanceApiKey = ensureValue(envBinanceKey, 'BINANCE_API_KEY');
const binanceApiSecret = ensureValue(envBinanceSecret, 'BINANCE_API_SECRET');
const openAiApiKey = ensureValue(envOpenAiKey, 'OPENAI_API_KEY');
const envOpenAiPrimaryModel = optionalEnv('OPENAI_PRIMARY_MODEL');
const envOpenAiFallbackModel = optionalEnv('OPENAI_FALLBACK_MODEL');
const openAiFallbackExplicitlySet = Object.prototype.hasOwnProperty.call(
  process.env,
  'OPENAI_FALLBACK_MODEL'
);

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseNumber(process.env.PORT, 8080),
  binance: {
    apiKey: binanceApiKey,
    apiSecret: binanceApiSecret,
    useTestnet: parseBoolean(process.env.BINANCE_USE_TESTNET, true),
    symbols: parseSymbols(process.env.BINANCE_SYMBOLS),
    symbolDiscovery: {
      enabled: parseBoolean(process.env.SYMBOL_DISCOVERY_ENABLED, true),
      refreshIntervalSeconds: parseNumber(process.env.SYMBOL_DISCOVERY_REFRESH_SECONDS, 180),
      topMoverLimit: parseNumber(process.env.SYMBOL_DISCOVERY_TOP_LIMIT, 400),
      maxActiveSymbols: parseNumber(process.env.SYMBOL_DISCOVERY_MAX_ACTIVE, 400),
      minQuoteVolume: parseNumber(process.env.SYMBOL_DISCOVERY_MIN_QUOTE_VOLUME, 5_000_000),
      quoteAssets: parseList(process.env.SYMBOL_DISCOVERY_QUOTE_ASSETS, 'USDT'),
      routeLimit: parseNumber(process.env.SYMBOL_DISCOVERY_ROUTE_LIMIT, 10),
    },
    http: {
      timeoutMs: parseNumber(process.env.BINANCE_HTTP_TIMEOUT_MS, 10_000),
      maxRetries: parseNumber(process.env.BINANCE_HTTP_MAX_RETRIES, 2),
      retryDelayMs: parseNumber(process.env.BINANCE_HTTP_RETRY_DELAY_MS, 300),
    },
  },
  openAi: {
    apiKey: openAiApiKey,
    primaryModel: envOpenAiPrimaryModel ?? 'gpt-5-mini',
    fallbackModel: envOpenAiFallbackModel ?? (openAiFallbackExplicitlySet ? undefined : 'gpt-5-nano'),
    maxOutputTokens: parseNumber(process.env.OPENAI_MAX_OUTPUT_TOKENS, 64),
    maxRequestsPerMinute: parseNumber(process.env.OPENAI_MAX_REQUESTS_PER_MINUTE, 15),
    cacheTtlMs: parseNumber(process.env.OPENAI_DECISION_CACHE_TTL_MS, 90_000),
    minDecisionIntervalMs: parseNumber(process.env.OPENAI_DECISION_MIN_INTERVAL_MS, 45_000),
    fingerprintDecimals: parseNumber(process.env.OPENAI_FINGERPRINT_DECIMALS, 3),
    fingerprintArraySample: parseNumber(process.env.OPENAI_FINGERPRINT_ARRAY_SAMPLE, 24),
    http: {
      timeoutMs: parseNumber(process.env.OPENAI_HTTP_TIMEOUT_MS, 15_000),
      maxRetries: parseNumber(process.env.OPENAI_HTTP_MAX_RETRIES, 2),
      retryDelayMs: parseNumber(process.env.OPENAI_HTTP_RETRY_DELAY_MS, 500),
    },
  },
  trading: {
    initialBalance: parseNumber(process.env.INITIAL_BALANCE, 100_000),
    loopIntervalSeconds: parseNumber(process.env.LOOP_INTERVAL_SECONDS, 30),
    maxPositionLeverage: parseNumber(process.env.MAX_POSITION_LEVERAGE, 5),
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
};
