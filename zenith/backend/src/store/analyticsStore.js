const round = (value, digits = 2) => Number(value.toFixed(digits));

export class AnalyticsStore {
  constructor() {
    this.equitySnapshots = [];
    this.signals = [];
    this.symbolStats = new Map();
    this.maxEntries = 1000;
    this.baselineEquity = undefined;
    this.openAiUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    };
  }

  addSignal(decision, riskLevel) {
    const record = {
      created_at: new Date().toISOString(),
      symbol: decision.symbol,
      bias: decision.bias,
      confidence: decision.confidence,
      risk_level: riskLevel,
    };
    this.signals.push(record);
    if (this.signals.length > this.maxEntries) {
      this.signals.shift();
    }
  }

  addExecution(result, decision) {
    const direction = decision.bias === 'long' ? 1 : decision.bias === 'short' ? -1 : 0;
    if (direction === 0 || result.filledQty <= 0) return;

    const signedQty = result.filledQty * direction;
    const now = new Date().toISOString();
    const existing =
      this.symbolStats.get(decision.symbol) ?? {
        netContracts: 0,
        avgEntryPrice: 0,
        realizedPnl: 0,
        totalVolume: 0,
        lastUpdated: now,
      };

    const previousQty = existing.netContracts;
    const previousAbs = Math.abs(previousQty);
    const incomingAbs = Math.abs(signedQty);

    existing.totalVolume += incomingAbs;
    existing.lastUpdated = now;

    if (previousQty === 0 || Math.sign(previousQty) === Math.sign(signedQty)) {
      const combined = previousAbs + incomingAbs;
      existing.avgEntryPrice =
        combined === 0 ? 0 : (existing.avgEntryPrice * previousAbs + result.avgPrice * incomingAbs) / combined;
      existing.netContracts = previousQty + signedQty;
    } else {
      const closingQty = Math.min(previousAbs, incomingAbs);
      const pnlPerContract =
        Math.sign(previousQty) > 0
          ? result.avgPrice - existing.avgEntryPrice
          : existing.avgEntryPrice - result.avgPrice;
      existing.realizedPnl += closingQty * pnlPerContract;

      const remainingFromExisting = previousAbs - closingQty;
      const remainingFromIncoming = incomingAbs - closingQty;

      if (remainingFromExisting > 0) {
        existing.netContracts = Math.sign(previousQty) * remainingFromExisting;
      } else if (remainingFromIncoming > 0) {
        existing.netContracts = Math.sign(signedQty) * remainingFromIncoming;
        existing.avgEntryPrice = result.avgPrice;
      } else {
        existing.netContracts = 0;
        existing.avgEntryPrice = 0;
      }
    }

    this.symbolStats.set(decision.symbol, existing);
  }

  recordOpenAiUsage(usage) {
    if (!usage) {
      return;
    }
    const toNumber = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    };

    const promptTokens = toNumber(usage.promptTokens);
    const completionTokens = toNumber(usage.completionTokens);
    const totalTokens = toNumber(usage.totalTokens);
    const inputCost = toNumber(usage.inputCost);
    const outputCost = toNumber(usage.outputCost);
    const totalCost = toNumber(usage.totalCost);

    if (promptTokens !== undefined) {
      this.openAiUsage.promptTokens += promptTokens;
    }
    if (completionTokens !== undefined) {
      this.openAiUsage.completionTokens += completionTokens;
    }
    if (totalTokens !== undefined) {
      this.openAiUsage.totalTokens += totalTokens;
    }
    if (inputCost !== undefined) {
      this.openAiUsage.inputCost += inputCost;
    }
    if (outputCost !== undefined) {
      this.openAiUsage.outputCost += outputCost;
    }
    if (totalCost !== undefined) {
      this.openAiUsage.totalCost += totalCost;
    }

  }

  getBaselineEquity() {
    return this.baselineEquity;
  }

  addEquity(snapshot) {
    if (this.baselineEquity === undefined) {
      this.baselineEquity = snapshot.baseline ?? snapshot.equity;
    }

    const basis = this.baselineEquity === 0 ? snapshot.equity : this.baselineEquity;
    const pnlPercent = basis === 0 ? 0 : ((snapshot.equity - basis) / basis) * 100;
    const normalized = {
      balance: snapshot.balance,
      equity: snapshot.equity,
      pnlPercent,
      timestamp: snapshot.timestamp,
    };

    this.equitySnapshots.push(normalized);
    if (this.equitySnapshots.length > this.maxEntries) {
      this.equitySnapshots.shift();
    }
    return normalized;
  }

  getLatestEquity() {
    return this.equitySnapshots[this.equitySnapshots.length - 1];
  }

  getRealizedPnl() {
    let total = 0;
    for (const stats of this.symbolStats.values()) {
      total += stats.realizedPnl;
    }
    return round(total);
  }

  getOpenAiUsage() {
    return {
      promptTokens: Math.max(0, Math.round(this.openAiUsage.promptTokens)),
      completionTokens: Math.max(0, Math.round(this.openAiUsage.completionTokens)),
      totalTokens: Math.max(0, Math.round(this.openAiUsage.totalTokens)),
      inputCost: round(this.openAiUsage.inputCost, 6),
      outputCost: round(this.openAiUsage.outputCost, 6),
      totalCost: round(this.openAiUsage.totalCost, 6),
    };
  }

  getSymbolPerformance() {
    return Array.from(this.symbolStats.entries()).map(([symbol, stats]) => ({
      symbol,
      realized_pnl: round(stats.realizedPnl),
      net_contracts: Number(stats.netContracts.toFixed(4)),
      avg_entry_price: round(stats.avgEntryPrice),
      total_volume: Number(stats.totalVolume.toFixed(4)),
      last_updated: stats.lastUpdated,
    }));
  }

  getRecentSignals(limit = 5) {
    return this.signals.slice(-limit).reverse();
  }
}

export const analyticsStore = new AnalyticsStore();
