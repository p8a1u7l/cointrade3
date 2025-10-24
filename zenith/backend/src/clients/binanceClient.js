import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { TypedEventEmitter } from '../utils/eventEmitter.js';
import { fetchWithRetry } from '../utils/http.js';

const REST_BASE_URL = config.binance.useTestnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

const BINANCE_HTTP_OPTIONS = {
  timeoutMs: config.binance.http?.timeoutMs ?? 10_000,
  retries: config.binance.http?.maxRetries ?? 2,
  retryDelayMs: config.binance.http?.retryDelayMs ?? 300,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const OFFLINE_MODE = config.binance.offlineMode === true;

const OFFLINE_STATE = OFFLINE_MODE
  ? {
      prices: new Map(),
      positions: new Map(),
      leverage: new Map(),
      balance: {
        asset: 'USDT',
        balance: config.trading.initialBalance,
        available: config.trading.initialBalance,
      },
      orderSequence: 0,
    }
  : null;

const OFFLINE_QUOTE_ASSETS = config.binance.symbolDiscovery?.quoteAssets ?? ['USDT'];

const intervalToMs = (interval) => {
  const match = typeof interval === 'string' ? interval.trim().match(/^(\d+)([smhd])$/i) : null;
  if (!match) {
    return 60_000;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000;
  return value * unitMs;
};

const ensureOfflinePrice = (symbol) => {
  if (!OFFLINE_STATE) return 0;
  const upper = symbol.toUpperCase();
  if (!OFFLINE_STATE.prices.has(upper)) {
    const base = 50 + Math.random() * 200;
    OFFLINE_STATE.prices.set(upper, base);
  }
  return OFFLINE_STATE.prices.get(upper);
};

const nextOfflinePrice = (symbol) => {
  if (!OFFLINE_STATE) return 0;
  const upper = symbol.toUpperCase();
  const current = ensureOfflinePrice(upper);
  const drift = (Math.random() - 0.5) * Math.max(current * 0.0025, 0.05);
  const next = Math.max(0.0001, current + drift);
  OFFLINE_STATE.prices.set(upper, next);
  return next;
};

const offlineQuoteAsset = (symbol) => {
  const upper = symbol.toUpperCase();
  for (const asset of OFFLINE_QUOTE_ASSETS) {
    if (upper.endsWith(asset)) {
      return asset;
    }
  }
  return OFFLINE_QUOTE_ASSETS[0] ?? 'USDT';
};

const generateOfflineCandles = (symbol, interval, limit) => {
  if (!OFFLINE_STATE) return [];
  const intervalMs = intervalToMs(interval);
  const now = Date.now();
  const startTime = now - limit * intervalMs;
  const candles = [];
  let previousClose = ensureOfflinePrice(symbol);
  for (let i = 0; i < limit; i += 1) {
    const openTime = startTime + i * intervalMs;
    const closeTime = openTime + intervalMs;
    const base = previousClose;
    const delta = (Math.random() - 0.5) * Math.max(base * 0.002, 0.05);
    const close = Math.max(0.0001, base + delta);
    const high = Math.max(base, close) * (1 + Math.random() * 0.0015);
    const low = Math.min(base, close) * (1 - Math.random() * 0.0015);
    const volume = Math.max(5, (base + close) / 2 * (0.15 + Math.random()));
    candles.push({
      openTime: Math.floor(openTime),
      closeTime: Math.floor(closeTime),
      open: base,
      high,
      low,
      close,
      volume,
    });
    previousClose = close;
    OFFLINE_STATE.prices.set(symbol.toUpperCase(), close);
  }
  return candles;
};

if (OFFLINE_MODE) {
  logger.warn('Binance offline mode enabled – market data and executions will be simulated.');
}

export class BinanceRealtimeFeed extends TypedEventEmitter {
  constructor() {
    super();
    this.pollTimer = undefined;
    this.symbols = [];
    this.offline = OFFLINE_MODE;
  }

  start(symbols) {
    this.stop();
    this.symbols = Array.from(new Set(Array.isArray(symbols) ? symbols : []));
    if (this.symbols.length === 0) {
      return;
    }
    const poll = () => {
      void this._pollPrices(this.symbols);
    };
    poll();
    this.pollTimer = setInterval(poll, 1000);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.symbols = [];
  }

  async _pollPrices(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return;
    }

    if (this.offline && OFFLINE_STATE) {
      const now = Date.now();
      for (const symbol of symbols) {
        const price = nextOfflinePrice(symbol);
        this.emit('tick', {
          symbol,
          price,
          eventTime: now,
        });
      }
      return;
    }

    if (symbols.length > 40) {
      await this._pollBulkPrices(symbols);
      return;
    }

    for (const symbol of symbols) {
      try {
        const response = await fetchWithRetry(
          `${REST_BASE_URL}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`,
          {
            timeoutMs: BINANCE_HTTP_OPTIONS.timeoutMs,
            retries: BINANCE_HTTP_OPTIONS.retries,
            retryDelayMs: BINANCE_HTTP_OPTIONS.retryDelayMs,
            retryOn: RETRYABLE_STATUS,
          }
        );
        if (!response.ok) {
          throw new Error(`Binance price request failed: ${response.status}`);
        }
        const payload = await response.json();
        const price = Number(payload.price);
        if (Number.isNaN(price)) {
          throw new Error('Received invalid price from Binance');
        }
        this.emit('tick', {
          symbol: payload.symbol ?? symbol,
          price,
          eventTime: Date.now(),
        });
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to fetch Binance ticker price');
      }
    }
  }

  async _pollBulkPrices(symbols) {
    if (this.offline && OFFLINE_STATE) {
      const now = Date.now();
      for (const symbol of symbols) {
        const price = nextOfflinePrice(symbol);
        this.emit('tick', {
          symbol,
          price,
          eventTime: now,
        });
      }
      return;
    }
    try {
      const response = await fetchWithRetry(`${REST_BASE_URL}/fapi/v1/ticker/price`, {
        timeoutMs: BINANCE_HTTP_OPTIONS.timeoutMs,
        retries: BINANCE_HTTP_OPTIONS.retries,
        retryDelayMs: BINANCE_HTTP_OPTIONS.retryDelayMs,
        retryOn: RETRYABLE_STATUS,
      });
      if (!response.ok) {
        throw new Error(`Binance bulk price request failed: ${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Binance bulk price payload was not an array');
      }
      const wanted = new Set(symbols);
      const now = Date.now();
      for (const entry of payload) {
        const symbol = entry?.symbol;
        if (!wanted.has(symbol)) continue;
        const price = Number(entry.price);
        if (Number.isNaN(price)) continue;
        this.emit('tick', {
          symbol,
          price,
          eventTime: now,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Binance bulk ticker prices');
    }
  }
}

export class BinanceClient {
  constructor() {
    this.baseUrl = REST_BASE_URL;
    this.offline = OFFLINE_MODE;
    this.httpOptions = BINANCE_HTTP_OPTIONS;
    this.retryOn = RETRYABLE_STATUS;
  }

  async fetchKlines(symbol, interval = '1m', limit = 120) {
    if (this.offline && OFFLINE_STATE) {
      return generateOfflineCandles(symbol, interval, Math.max(1, Math.min(limit, 500)));
    }
    const params = new URLSearchParams({
      symbol,
      interval,
      limit: String(Math.max(1, Math.min(limit, 500))),
    });
    const response = await fetchWithRetry(`${this.baseUrl}/fapi/v1/klines?${params.toString()}`, {
      timeoutMs: this.httpOptions.timeoutMs,
      retries: this.httpOptions.retries,
      retryDelayMs: this.httpOptions.retryDelayMs,
      retryOn: this.retryOn,
    });
    if (!response.ok) {
      throw new Error(`Binance klines request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Binance klines payload was not an array');
    }
    return data.map((entry) => ({
      openTime: Number(entry[0]),
      open: Number(entry[1]),
      high: Number(entry[2]),
      low: Number(entry[3]),
      close: Number(entry[4]),
      volume: Number(entry[5]),
      closeTime: Number(entry[6]),
    }));
  }

  signParams(params) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...params, timestamp: String(timestamp) });
    const hmac = crypto.createHmac('sha256', config.binance.apiSecret);
    hmac.update(query.toString());
    query.append('signature', hmac.digest('hex'));
    return query.toString();
  }

  async request(method, path, params = {}) {
    if (this.offline) {
      throw new Error('Binance request is unavailable in offline mode');
    }
    const query = this.signParams(params);
    const url = `${this.baseUrl}${path}?${query}`;
    const response = await fetchWithRetry(url, {
      method,
      headers: { 'X-MBX-APIKEY': config.binance.apiKey },
      timeoutMs: this.httpOptions.timeoutMs,
      retries: this.httpOptions.retries,
      retryDelayMs: this.httpOptions.retryDelayMs,
      retryOn: this.retryOn,
    });
    if (!response.ok) {
      throw new Error(`Binance request failed: ${response.status}`);
    }
    return await response.json();
  }

  async fetchAccountBalance() {
    if (this.offline && OFFLINE_STATE) {
      const { asset, balance, available } = OFFLINE_STATE.balance;
      return [
        {
          asset,
          balance,
          available,
        },
      ];
    }
    try {
      const data = await this.request('GET', '/fapi/v2/account');
      return (data.assets ?? []).map((asset) => ({
        asset: asset.asset,
        balance: Number(asset.walletBalance),
        available: Number(asset.availableBalance),
      }));
    } catch (error) {
      logger.error({ error }, 'Unable to fetch Binance account balance');
      throw error;
    }
  }

  async fetchPositions() {
    if (this.offline && OFFLINE_STATE) {
      return Array.from(OFFLINE_STATE.positions.values()).map((position) => ({
        symbol: position.symbol,
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice,
        unrealizedProfit: 0,
      }));
    }
    try {
      const data = await this.request('GET', '/fapi/v2/positionRisk');
      return (data ?? []).map((position) => ({
        symbol: position.symbol,
        positionAmt: Number(position.positionAmt),
        entryPrice: Number(position.entryPrice),
        unrealizedProfit: Number(position.unRealizedProfit ?? position.unrealizedProfit ?? 0),
      }));
    } catch (error) {
      logger.error({ error }, 'Unable to fetch Binance positions');
      throw error;
    }
  }

  async setLeverage(symbol, leverage) {
    if (this.offline && OFFLINE_STATE) {
      OFFLINE_STATE.leverage.set(symbol.toUpperCase(), leverage);
      return;
    }
    try {
      await this.request('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (error) {
      logger.error({ error, symbol, leverage }, 'Failed to set Binance leverage');
      throw error;
    }
  }

  async placeMarketOrder(symbol, side, quantity) {
    if (this.offline && OFFLINE_STATE) {
      const upper = symbol.toUpperCase();
      const price = nextOfflinePrice(upper);
      const executedQty = Number(quantity);
      const leverage = OFFLINE_STATE.leverage.get(upper) ?? 1;
      const direction = side === 'BUY' ? 1 : -1;
      const previous = OFFLINE_STATE.positions.get(upper) ?? {
        symbol: upper,
        positionAmt: 0,
        entryPrice: price,
      };
      const nextAmt = Number((previous.positionAmt + direction * executedQty).toFixed(4));
      if (Math.abs(nextAmt) < 1e-6) {
        OFFLINE_STATE.positions.delete(upper);
      } else {
        OFFLINE_STATE.positions.set(upper, {
          symbol: upper,
          positionAmt: nextAmt,
          entryPrice: price,
        });
      }
      const notional = price * executedQty;
      const marginImpact = notional / Math.max(leverage, 1);
      OFFLINE_STATE.balance.available = Math.max(
        0,
        OFFLINE_STATE.balance.available - marginImpact * 0.01
      );
      return {
        orderId: crypto.randomUUID ? crypto.randomUUID() : String(OFFLINE_STATE.orderSequence += 1),
        status: 'FILLED',
        avgPrice: price,
        executedQty,
      };
    }
    try {
      const data = await this.request('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity,
      });
      return {
        orderId: String(data.orderId),
        status: data.status,
        avgPrice: Number(data.avgPrice ?? data.price ?? 0),
        executedQty: Number(data.executedQty ?? data.origQty ?? 0),
      };
    } catch (error) {
      logger.error({ error, symbol, side, quantity }, 'Failed to execute Binance market order');
      throw error;
    }
  }

  async fetchTopMovers(options = {}) {
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
    const minQuoteVolume = Number.isFinite(options.minQuoteVolume)
      ? Number(options.minQuoteVolume)
      : 0;
    const quoteAssets = Array.isArray(options.quoteAssets) && options.quoteAssets.length > 0
      ? options.quoteAssets.map((asset) => asset.toUpperCase())
      : ['USDT'];

    if (this.offline && OFFLINE_STATE) {
      const symbols = new Set([
        ...config.binance.symbols,
        ...Array.from(OFFLINE_STATE.prices.keys()),
      ]);
      const ranked = [];
      for (const symbol of symbols) {
        if (!symbol) continue;
        const quoteAsset = offlineQuoteAsset(symbol);
        if (!quoteAssets.includes(quoteAsset)) continue;
        const lastPrice = nextOfflinePrice(symbol);
        const priceChangePercent = (Math.random() - 0.5) * 10;
        const quoteVolume = Math.max(minQuoteVolume, 1_000_000 + Math.random() * 5_000_000);
        const baseVolume = quoteVolume / Math.max(lastPrice, 1);
        const liquidityBoost = Math.log10(Math.max(quoteVolume, 1) + 10);
        const score = Math.abs(priceChangePercent) * liquidityBoost;
        ranked.push({
          symbol,
          quoteAsset,
          priceChangePercent,
          lastPrice,
          quoteVolume,
          baseVolume,
          score,
          direction: priceChangePercent >= 0 ? 'up' : 'down',
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      return ranked.slice(0, limit);
    }

    const response = await fetchWithRetry(`${this.baseUrl}/fapi/v1/ticker/24hr`, {
      timeoutMs: this.httpOptions.timeoutMs,
      retries: this.httpOptions.retries,
      retryDelayMs: this.httpOptions.retryDelayMs,
      retryOn: this.retryOn,
    });
    if (!response.ok) {
      throw new Error(`Binance 24hr ticker request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Binance 24hr ticker payload was not an array');
    }

    const ranked = [];
    for (const entry of data) {
      const symbol = typeof entry.symbol === 'string' ? entry.symbol.toUpperCase() : undefined;
      if (!symbol) continue;
      const matchingQuote = quoteAssets.find((asset) => symbol.endsWith(asset));
      if (!matchingQuote) continue;

      const priceChangePercent = Number(entry.priceChangePercent ?? entry.priceChange_pct ?? entry.priceChange);
      const lastPrice = Number(entry.lastPrice ?? entry.prevClosePrice ?? entry.close ?? entry.price);
      const quoteVolume = Number(entry.quoteVolume ?? entry.volume ?? 0);
      const baseVolume = Number(entry.volume ?? 0);

      if (
        !Number.isFinite(priceChangePercent) ||
        !Number.isFinite(lastPrice) ||
        !Number.isFinite(quoteVolume)
      ) {
        continue;
      }
      if (quoteVolume < minQuoteVolume) {
        continue;
      }

      const absChange = Math.abs(priceChangePercent);
      const liquidityBoost = Math.log10(Math.max(quoteVolume, 1) + 10);
      const score = absChange * liquidityBoost;

      ranked.push({
        symbol,
        quoteAsset: matchingQuote,
        priceChangePercent,
        lastPrice,
        quoteVolume,
        baseVolume,
        score,
        direction: priceChangePercent >= 0 ? 'up' : 'down',
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }
}
