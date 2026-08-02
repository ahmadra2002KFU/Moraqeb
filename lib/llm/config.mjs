const DEFAULT_OMNIROUTE_MODEL = 'cx/gpt-5.6-luna';
const DEFAULT_OMNIROUTE_BASE_URL = 'http://localhost:20128/v1';
const DEFAULT_OMNIROUTE_REASONING = 'low';
const DEFAULT_LOCAL_CLIENT_KEY = 'local-moraqeb';

function value(env, key) {
  const candidate = env[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * Resolve LLM settings without allowing provider-specific credentials or URLs
 * to cross into another provider.
 */
export function resolveLLMConfig(env = process.env) {
  const explicitProvider = value(env, 'LLM_PROVIDER')?.toLowerCase() || null;
  if (explicitProvider === 'disabled' || explicitProvider === 'none') {
    return {
      provider: null,
      apiKey: null,
      model: null,
      baseUrl: null,
      reasoningEffort: null,
    };
  }
  const legacyMiniMax = !explicitProvider && !!value(env, 'MINIMAX_API_KEY');
  const provider = explicitProvider || (legacyMiniMax ? 'minimax' : 'omniroute');
  const genericKey = value(env, 'LLM_API_KEY');
  const genericModel = value(env, 'LLM_MODEL');
  const genericBaseUrl = value(env, 'LLM_BASE_URL');
  const genericReasoning = value(env, 'LLM_REASONING_EFFORT');

  if (provider === 'omniroute') {
    return {
      provider,
      apiKey: genericKey || value(env, 'OMNIROUTE_API_KEY') || DEFAULT_LOCAL_CLIENT_KEY,
      model: value(env, 'OMNIROUTE_MODEL') || genericModel || DEFAULT_OMNIROUTE_MODEL,
      baseUrl: value(env, 'OMNIROUTE_BASE_URL') || genericBaseUrl || DEFAULT_OMNIROUTE_BASE_URL,
      reasoningEffort: value(env, 'OMNIROUTE_REASONING_EFFORT') || genericReasoning || DEFAULT_OMNIROUTE_REASONING,
    };
  }

  if (provider === 'minimax') {
    return {
      provider,
      apiKey: genericKey || value(env, 'MINIMAX_API_KEY'),
      model: genericModel || value(env, 'MINIMAX_MODEL') || (legacyMiniMax ? 'MiniMax-M2.7' : null),
      baseUrl: genericBaseUrl,
      reasoningEffort: genericReasoning,
    };
  }

  if (provider === 'ollama') {
    return {
      provider,
      apiKey: genericKey,
      model: genericModel,
      baseUrl: genericBaseUrl || value(env, 'OLLAMA_BASE_URL'),
      reasoningEffort: genericReasoning,
    };
  }

  return {
    provider,
    apiKey: genericKey,
    model: genericModel,
    baseUrl: genericBaseUrl,
    reasoningEffort: genericReasoning,
  };
}
