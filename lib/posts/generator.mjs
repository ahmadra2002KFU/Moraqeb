// Moraqeb Post Generator
// Generates short bilingual (EN + AR) intelligence updates using MiniMax M2.7
import { buildIntelligenceContext } from '../context/builder.mjs';
import { getPostSystemPromptEN, getPostSystemPromptAR } from '../prompts/posts.mjs';

const LOG = '[Moraqeb Post]';
const TIMEOUT_MS = 90_000; // 90 seconds — 60s was too tight with large context feeds
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
 * Call MiniMax with 1 retry on failure (2s backoff).
 */
async function callMiniMaxWithRetry(apiKey, model, systemPrompt, userMessage, maxTokens = 512) {
  try {
    return await callMiniMax(apiKey, model, systemPrompt, userMessage, maxTokens);
  } catch (err) {
    console.warn(`${LOG} First attempt failed (${err.message}), retrying in 2s…`);
    await new Promise(r => setTimeout(r, 2000));
    return await callMiniMax(apiKey, model, systemPrompt, userMessage, maxTokens);
  }
}

/**
 * Strip <think>...</think> reasoning blocks from model output.
 */
function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
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
export async function generatePost(apiKey, model, v2Data, deltaData, recentTopics = [], dedupCheck = null) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting post generation at ${timestamp}`);

  const context = buildIntelligenceContext(v2Data, deltaData);

  const enPrompt = getPostSystemPromptEN(context, recentTopics);
  const arPrompt = getPostSystemPromptAR(context, recentTopics);

  // ── Generate EN + AR in parallel (AR runs independently) ───────────────────
  let totalInput = 0, totalOutput = 0;

  const arPromise = callMiniMaxWithRetry(apiKey, model, arPrompt);

  // EN generation + dedup gate
  let enText = null;
  try {
    const enRes = await callMiniMaxWithRetry(apiKey, model, enPrompt);
    totalInput += enRes.inputTokens || 0;
    totalOutput += enRes.outputTokens || 0;
    enText = stripThinking(enRes.text);
  } catch (err) {
    console.error(`${LOG} EN generation failed after retry: ${err.message}`);
  }

  // ── Dedup gate: check EN content against recent posts ─────────────────────
  if (enText && dedupCheck) {
    const dupResult = dedupCheck(enText);
    if (dupResult.isDuplicate) {
      console.warn(`${LOG} Duplicate detected (sim=${dupResult.similarity.toFixed(2)}, match="${dupResult.bestMatch}") — regenerating with avoidance`);
      const avoidPrompt = `CRITICAL: The topic "${dupResult.bestMatch}" has ALREADY been covered. You MUST choose a completely different signal.\n\n${enPrompt}`;
      try {
        const retry = await callMiniMaxWithRetry(apiKey, model, avoidPrompt);
        totalInput += retry.inputTokens || 0;
        totalOutput += retry.outputTokens || 0;
        const retryText = stripThinking(retry.text);
        const retryDup = dedupCheck(retryText);
        if (retryDup.isDuplicate) {
          console.warn(`${LOG} Still duplicate after retry (sim=${retryDup.similarity.toFixed(2)}) — skipping this cycle`);
          return { skipped: true, reason: `duplicate of "${retryDup.bestMatch}" (sim=${retryDup.similarity.toFixed(2)})` };
        }
        enText = retryText;
      } catch (err) {
        console.error(`${LOG} Dedup regeneration failed: ${err.message} — using original`);
      }
    }
  }

  // ── Await AR result ───────────────────────────────────────────────────────
  const arResult = await Promise.allSettled([arPromise]).then(r => r[0]);

  const arText = arResult.status === 'fulfilled' ? stripThinking(arResult.value.text) : null;
  if (arResult.status === 'fulfilled') {
    totalInput += arResult.value.inputTokens || 0;
    totalOutput += arResult.value.outputTokens || 0;
  }

  const en = enText
    ? { title: extractTitle(enText), content: enText }
    : { title: 'Update Unavailable', content: 'The English update could not be generated at this time.' };

  const ar = arText
    ? { title: extractTitle(arText, 'تحديث استخباراتي'), content: arText }
    : { title: 'التحديث غير متوفر', content: 'تعذّر إنشاء التحديث باللغة العربية في الوقت الحالي.' };

  const tokenUsage = {
    post: { inputTokens: totalInput, outputTokens: totalOutput },
  };

  const post = { timestamp, en, ar };
  console.log(`${LOG} Post complete — EN: "${en.title}", AR: "${ar.title}" — tokens: ${totalInput}+${totalOutput}`);
  return { post, tokenUsage };
}
