// Moraqeb Token Usage Tracker
// Tracks Gemini API token usage across all features (blog, chat, ideas, voice)
// Persists to runs/token-usage.json

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

const LOG = '[Moraqeb Tokens]';

// Pricing per 1M tokens
const PRICING = {
  // MiniMax (Token Plan — fixed fee, costs shown for reference)
  'MiniMax-M2.7': { input: 0.30, output: 1.20 },
  'MiniMax-M2.7-highspeed': { input: 0.60, output: 2.40 },
  'MiniMax-M2.5': { input: 0.30, output: 1.20 },
  'MiniMax-M2.5-highspeed': { input: 0.60, output: 2.40 },
  // Gemini (voice only)
  'gemini-2.5-flash-native-audio-preview-12-2025': { inputText: 0.50, inputAudio: 3.00, outputText: 2.00, outputAudio: 12.00 },
};
const DEFAULT_PRICING = { input: 0.30, output: 1.20 };

export class TokenTracker {
  /**
   * @param {string} dataDir - Directory to persist usage data (e.g., runs/)
   */
  constructor(dataDir) {
    this.filePath = join(dataDir, 'token-usage.json');
    this.data = this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch (err) {
      console.error(LOG, 'Failed to load token usage:', err.message);
    }
    return this._empty();
  }

  _empty() {
    return {
      startedAt: new Date().toISOString(),
      totals: { inputTokens: 0, outputTokens: 0, requests: 0 },
      features: {
        blog: { inputTokens: 0, outputTokens: 0, requests: 0 },
        blogSummary: { inputTokens: 0, outputTokens: 0, requests: 0 },
        chat: { inputTokens: 0, outputTokens: 0, requests: 0 },
        post: { inputTokens: 0, outputTokens: 0, requests: 0 },
        ideas: { inputTokens: 0, outputTokens: 0, requests: 0 },
        voice: { sessions: 0 },
      },
      daily: {},
    };
  }

  _save() {
    try {
      const tmp = this.filePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(LOG, 'Failed to save token usage:', err.message);
    }
  }

  _today() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Record token usage from a Gemini API call.
   * @param {string} feature - 'blog' | 'blogSummary' | 'chat' | 'ideas'
   * @param {number} inputTokens
   * @param {number} outputTokens
   */
  record(feature, inputTokens, outputTokens) {
    inputTokens = inputTokens || 0;
    outputTokens = outputTokens || 0;

    // Update totals
    this.data.totals.inputTokens += inputTokens;
    this.data.totals.outputTokens += outputTokens;
    this.data.totals.requests += 1;

    // Update feature
    if (!this.data.features[feature]) {
      this.data.features[feature] = { inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    this.data.features[feature].inputTokens += inputTokens;
    this.data.features[feature].outputTokens += outputTokens;
    this.data.features[feature].requests += 1;

    // Update daily
    const day = this._today();
    if (!this.data.daily[day]) {
      this.data.daily[day] = { inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    this.data.daily[day].inputTokens += inputTokens;
    this.data.daily[day].outputTokens += outputTokens;
    this.data.daily[day].requests += 1;

    this._save();
  }

  /** Record a voice session (no token count available for Live API). */
  recordVoiceSession() {
    if (!this.data.features.voice) this.data.features.voice = { sessions: 0 };
    this.data.features.voice.sessions += 1;
    this._save();
  }

  /**
   * Get usage summary with estimated costs.
   * @param {string} model - Model ID for pricing lookup
   * @returns {object}
   */
  getSummary(model = 'gemini-3-flash-preview') {
    const pricing = PRICING[model] || DEFAULT_PRICING;
    const inputCostPer1M = pricing.input || pricing.inputText || DEFAULT_PRICING.input;
    const outputCostPer1M = pricing.output || pricing.outputText || DEFAULT_PRICING.output;

    const t = this.data.totals;
    const estimatedCost = (t.inputTokens / 1_000_000) * inputCostPer1M +
                          (t.outputTokens / 1_000_000) * outputCostPer1M;

    // Per-feature costs
    const featureCosts = {};
    for (const [name, f] of Object.entries(this.data.features)) {
      if (f.inputTokens !== undefined) {
        featureCosts[name] = {
          ...f,
          estimatedCost: parseFloat(
            ((f.inputTokens / 1_000_000) * inputCostPer1M +
             (f.outputTokens / 1_000_000) * outputCostPer1M).toFixed(4)
          ),
        };
      } else {
        featureCosts[name] = f;
      }
    }

    // Last 7 days
    const dailySorted = Object.entries(this.data.daily || {})
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .map(([date, d]) => ({
        date,
        ...d,
        estimatedCost: parseFloat(
          ((d.inputTokens / 1_000_000) * inputCostPer1M +
           (d.outputTokens / 1_000_000) * outputCostPer1M).toFixed(4)
        ),
      }));

    return {
      startedAt: this.data.startedAt,
      model,
      pricing: { inputPer1M: inputCostPer1M, outputPer1M: outputCostPer1M, currency: 'USD' },
      totals: {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        totalTokens: t.inputTokens + t.outputTokens,
        requests: t.requests,
        estimatedCost: parseFloat(estimatedCost.toFixed(4)),
      },
      features: featureCosts,
      daily: dailySorted,
      note: 'Chat and Blog use MiniMax (Token Plan — fixed fee). Voice uses Gemini. Costs shown are pay-as-you-go equivalents for reference.',
    };
  }
}
