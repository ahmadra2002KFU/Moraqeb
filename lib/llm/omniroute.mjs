// OmniRoute Provider — OpenAI-compatible local gateway

import { LLMProvider } from './provider.mjs';

export class OmniRouteProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'omniroute';
    this.apiKey = config.apiKey;
    this.model = config.model || 'cx/gpt-5.6-luna';
    this.baseUrl = (config.baseUrl || 'http://localhost:20128/v1').replace(/\/+$/, '');
    this.reasoningEffort = config.reasoningEffort || 'low';
  }

  get isConfigured() {
    return !!(this.apiKey && this.baseUrl && this.model);
  }

  buildBody(messages, opts = {}) {
    return {
      model: this.model,
      max_completion_tokens: opts.maxTokens || 4096,
      reasoning_effort: opts.reasoningEffort || this.reasoningEffort,
      stream: opts.stream === true,
      messages,
    };
  }

  async request(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(messages, opts)),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OmniRoute API ${res.status}: ${err.substring(0, 300)}`);
    }

    return res;
  }

  async completeMessages(messages, opts = {}) {
    const res = await this.request(messages, { ...opts, stream: false });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('OmniRoute returned an empty response');

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
      reasoningCharacters: (data.choices?.[0]?.message?.reasoning_content || '').length,
    };
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    return this.completeMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], opts);
  }

  async streamMessages(messages, opts = {}) {
    return this.request(messages, { ...opts, stream: true });
  }
}
