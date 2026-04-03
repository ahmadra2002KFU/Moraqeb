// Moraqeb SITREP Blog Generator
// Generates bilingual (English + Arabic) intelligence briefings using MiniMax M2.7
import { buildIntelligenceContext } from '../context/builder.mjs';
import { getBlogSystemPromptEN, getBlogSystemPromptAR, getSummaryPromptEN, getSummaryPromptAR } from '../prompts/strategist.mjs';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the briefing template once at module init
const BRIEFING_TEMPLATE = readFileSync(join(__dirname, '../../apis/BRIEFING_TEMPLATE.md'), 'utf-8');

const LOG = '[Moraqeb Blog]';
const TIMEOUT_MS = 120_000; // 120 seconds per MiniMax call
const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';

/**
 * Call MiniMax API with a system prompt via OpenAI-compatible endpoint.
 * @param {string} apiKey - MiniMax Token Plan API key
 * @param {string} model - MiniMax model ID
 * @param {string} systemPrompt - System instruction for the model
 * @param {string} userMessage - User message / content to process
 * @param {number} maxTokens - Maximum output tokens
 */
async function callMiniMax(apiKey, model, systemPrompt, userMessage = 'Generate the intelligence briefing based on the live feed data provided.', maxTokens = 8192) {
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
    if (!text) {
      throw new Error('MiniMax returned empty response — no choices or content found');
    }
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
 * Extract the first markdown heading (# Title) from content.
 * Falls back to the first non-empty line, or a default string.
 */
function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

function extractTitle(content, fallback = 'Intelligence Briefing') {
  if (!content) return fallback;
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: first non-empty line
  const firstLine = content.split('\n').find(l => l.trim().length > 0);
  return firstLine ? firstLine.replace(/^#+\s*/, '').trim().substring(0, 120) : fallback;
}

/**
 * Process a Gemini generation result into a structured object.
 * @param {PromiseSettledResult} result - Result from Promise.allSettled
 * @param {string} fallbackTitle - Title to use on failure
 * @param {string} fallbackContent - Content to use on failure
 * @param {string} lang - Language label for logging ('EN' or 'AR')
 * @returns {{title: string, summary: string, content: string}}
 */
function processResult(result, fallbackTitle, fallbackContent, lang) {
  if (result.status === 'fulfilled') {
    const r = result.value;
    const content = stripThinking(typeof r === 'string' ? r : r.text);
    const title = extractTitle(content, fallbackTitle);
    console.log(`${LOG} ${lang} SITREP: "${title}" (${content.length} chars, ${r.inputTokens || 0}+${r.outputTokens || 0} tokens)`);
    return { title, summary: '', content, inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0 };
  } else {
    console.error(`${LOG} ${lang} generation failed:`, result.reason?.message || result.reason);
    return {
      title: fallbackTitle,
      summary: '',
      content: fallbackContent.replace('{{ERROR}}', result.reason?.message || 'Unknown error'),
    };
  }
}

/**
 * Generate a bilingual SITREP from current sweep data.
 * Two-pass generation: Pass 1 generates full SITREPs, Pass 2 generates summaries.
 * @param {string} apiKey - MiniMax Token Plan API key
 * @param {string} model - MiniMax model ID
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @param {object|null} previousSitrep - Previous SITREP object with en/ar content for delta generation
 * @returns {Promise<{timestamp: string, en: {title: string, summary: string, content: string}, ar: {title: string, summary: string, content: string}}>}
 */
export async function generateSITREP(apiKey, model, v2Data, deltaData, previousSitrep = null) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting SITREP generation at ${timestamp}`);

  // 1. Build context from live data
  const context = buildIntelligenceContext(v2Data, deltaData);
  console.log(`${LOG} Context built — ${(context.length / 1024).toFixed(1)}KB`);

  // Extract previous content for delta
  const prevEN = previousSitrep?.en?.content || null;
  const prevAR = previousSitrep?.ar?.content || null;

  // 2. Build system prompts for EN and AR (with previous content for delta)
  const enPrompt = getBlogSystemPromptEN(context, BRIEFING_TEMPLATE, prevEN);
  const arPrompt = getBlogSystemPromptAR(context, BRIEFING_TEMPLATE, prevAR);

  // 3. Pass 1: Fire both SITREP calls in parallel
  const [enResult, arResult] = await Promise.allSettled([
    callMiniMax(apiKey, model, enPrompt),
    callMiniMax(apiKey, model, arPrompt),
  ]);

  console.log(`${LOG} Pass 1 — EN: ${enResult.status}, AR: ${arResult.status}`);

  // 4. Process results
  const en = processResult(
    enResult,
    'English Briefing Unavailable',
    `# English Briefing Unavailable\n\nThe English SITREP could not be generated at this time.\n\n**Error:** {{ERROR}}\n\nPlease check the Arabic version or wait for the next update cycle.`,
    'EN',
  );

  const ar = processResult(
    arResult,
    'التقرير العربي غير متوفر',
    `# التقرير العربي غير متوفر\n\nتعذّر إنشاء التقرير باللغة العربية في الوقت الحالي.\n\n**خطأ:** {{ERROR}}\n\nيُرجى مراجعة النسخة الإنجليزية أو الانتظار حتى دورة التحديث التالية.`,
    'AR',
  );

  // 5. Pass 2: Generate summaries in parallel (only if Pass 1 succeeded)
  const [enSumResult, arSumResult] = await Promise.allSettled([
    enResult.status === 'fulfilled'
      ? callMiniMax(apiKey, model, getSummaryPromptEN(), enResult.value.text || enResult.value, 2048)
      : Promise.resolve({ text: 'Summary unavailable.', inputTokens: 0, outputTokens: 0 }),
    arResult.status === 'fulfilled'
      ? callMiniMax(apiKey, model, getSummaryPromptAR(), arResult.value.text || arResult.value, 2048)
      : Promise.resolve({ text: 'الملخص غير متوفر.', inputTokens: 0, outputTokens: 0 }),
  ]);

  console.log(`${LOG} Pass 2 — EN summary: ${enSumResult.status}, AR summary: ${arSumResult.status}`);

  // 6. Attach summaries (extract text from {text, inputTokens, outputTokens})
  const enSum = enSumResult.status === 'fulfilled' ? enSumResult.value : { text: 'Summary unavailable.', inputTokens: 0, outputTokens: 0 };
  const arSum = arSumResult.status === 'fulfilled' ? arSumResult.value : { text: 'الملخص غير متوفر.', inputTokens: 0, outputTokens: 0 };
  en.summary = stripThinking(typeof enSum === 'string' ? enSum : enSum.text);
  ar.summary = stripThinking(typeof arSum === 'string' ? arSum : arSum.text);

  // If both failed, still return the structure with error messages
  if (enResult.status === 'rejected' && arResult.status === 'rejected') {
    console.error(`${LOG} Both EN and AR generation failed — returning error placeholders`);
  }

  // 7. Collect token usage across all 4 calls
  const tokenUsage = {
    blog: {
      inputTokens: (en.inputTokens || 0) + (ar.inputTokens || 0),
      outputTokens: (en.outputTokens || 0) + (ar.outputTokens || 0),
    },
    blogSummary: {
      inputTokens: (typeof enSum === 'object' ? enSum.inputTokens : 0) + (typeof arSum === 'object' ? arSum.inputTokens : 0),
      outputTokens: (typeof enSum === 'object' ? enSum.outputTokens : 0) + (typeof arSum === 'object' ? arSum.outputTokens : 0),
    },
  };

  // Clean token fields from en/ar before saving
  delete en.inputTokens; delete en.outputTokens;
  delete ar.inputTokens; delete ar.outputTokens;

  const sitrep = { timestamp, en, ar };
  console.log(`${LOG} SITREP generation complete — tokens: blog=${tokenUsage.blog.inputTokens}+${tokenUsage.blog.outputTokens}, summary=${tokenUsage.blogSummary.inputTokens}+${tokenUsage.blogSummary.outputTokens}`);
  return { sitrep, tokenUsage };
}
