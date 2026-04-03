// Moraqeb Post Generator
// Generates short bilingual (EN + AR) intelligence updates using MiniMax M2.7
import { buildIntelligenceContext } from '../context/builder.mjs';
import { getPostSystemPromptEN, getPostSystemPromptAR } from '../prompts/posts.mjs';

const LOG = '[Moraqeb Post]';
const TIMEOUT_MS = 60_000; // 60 seconds (short output, shouldn't need long)
const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';

/**
 * Call MiniMax API for post generation.
 */
async function callMiniMax(apiKey, model, systemPrompt, userMessage = 'Generate the intelligence update based on the live feed data provided.', maxTokens = 512) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '(no body)');
      throw new Error(`MiniMax API ${res.status}: ${errText.substring(0, 300)}`);
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error('MiniMax returned empty response');
    const usage = json.usage || {};
    return {
      text,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a short title from post content.
 * Looks for **Bold Label:** pattern, falls back to first line.
 */
function extractTitle(content, fallback = 'Intelligence Update') {
  if (!content) return fallback;
  // Match **Topic:** pattern
  const boldMatch = content.match(/\*\*([^*]+?)(?::|\*\*)/);
  if (boldMatch) return boldMatch[1].trim();
  // Fallback: first 80 chars
  const firstLine = content.split('\n').find(l => l.trim().length > 0);
  return firstLine ? firstLine.replace(/\*\*/g, '').trim().substring(0, 80) : fallback;
}

/**
 * Generate a bilingual post from current sweep data.
 * @param {string} apiKey - MiniMax Token Plan API key
 * @param {string} model - MiniMax model ID
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @param {Array} recentTopics - Recent post topics for dedup
 * @returns {Promise<{post: object, tokenUsage: object}>}
 */
export async function generatePost(apiKey, model, v2Data, deltaData, recentTopics = []) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting post generation at ${timestamp}`);

  const context = buildIntelligenceContext(v2Data, deltaData);

  const enPrompt = getPostSystemPromptEN(context, recentTopics);
  const arPrompt = getPostSystemPromptAR(context, recentTopics);

  const [enResult, arResult] = await Promise.allSettled([
    callMiniMax(apiKey, model, enPrompt),
    callMiniMax(apiKey, model, arPrompt),
  ]);

  console.log(`${LOG} EN: ${enResult.status}, AR: ${arResult.status}`);

  const en = enResult.status === 'fulfilled'
    ? { title: extractTitle(enResult.value.text), content: enResult.value.text }
    : { title: 'Update Unavailable', content: 'The English update could not be generated at this time.' };

  const ar = arResult.status === 'fulfilled'
    ? { title: extractTitle(arResult.value.text, 'تحديث استخباراتي'), content: arResult.value.text }
    : { title: 'التحديث غير متوفر', content: 'تعذّر إنشاء التحديث باللغة العربية في الوقت الحالي.' };

  const tokenUsage = {
    post: {
      inputTokens: (enResult.value?.inputTokens || 0) + (arResult.value?.inputTokens || 0),
      outputTokens: (enResult.value?.outputTokens || 0) + (arResult.value?.outputTokens || 0),
    },
  };

  const post = { timestamp, en, ar };
  console.log(`${LOG} Post complete — EN: "${en.title}", AR: "${ar.title}" — tokens: ${tokenUsage.post.inputTokens}+${tokenUsage.post.outputTokens}`);
  return { post, tokenUsage };
}
