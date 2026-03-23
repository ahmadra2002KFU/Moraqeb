// Moraqeb SITREP Blog Generator
// Generates bilingual (English + Arabic) intelligence briefings using Gemini 3 Flash
import { buildIntelligenceContext } from '../context/builder.mjs';
import { getBlogSystemPromptEN, getBlogSystemPromptAR, getSummaryPromptEN, getSummaryPromptAR } from '../prompts/strategist.mjs';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the briefing template once at module init
const BRIEFING_TEMPLATE = readFileSync(join(__dirname, '../../apis/BRIEFING_TEMPLATE.md'), 'utf-8');

const LOG = '[Moraqeb Blog]';
const TIMEOUT_MS = 120_000; // 120 seconds per Gemini call
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

/**
 * Call Gemini 3 Flash REST API with a system prompt.
 * Returns the raw text response or throws on failure.
 * @param {string} apiKey - Gemini API key
 * @param {string} systemPrompt - System instruction for the model
 * @param {string} userMessage - User message / content to process
 * @param {number} maxTokens - Maximum output tokens
 */
async function callGemini(apiKey, systemPrompt, userMessage = 'Generate the intelligence briefing based on the live feed data provided.', maxTokens = 8192) {
  const url = `${GEMINI_URL}?key=${apiKey}`;
  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        parts: [{ text: userMessage }],
      },
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '(no body)');
      throw new Error(`Gemini API ${res.status}: ${errText.substring(0, 300)}`);
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini returned empty response — no candidates or text found');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first markdown heading (# Title) from content.
 * Falls back to the first non-empty line, or a default string.
 */
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
    const content = result.value;
    const title = extractTitle(content, fallbackTitle);
    console.log(`${LOG} ${lang} SITREP: "${title}" (${content.length} chars)`);
    return { title, summary: '', content };
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
 * @param {string} apiKey - Gemini API key
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @param {object|null} previousSitrep - Previous SITREP object with en/ar content for delta generation
 * @returns {Promise<{timestamp: string, en: {title: string, summary: string, content: string}, ar: {title: string, summary: string, content: string}}>}
 */
export async function generateSITREP(apiKey, v2Data, deltaData, previousSitrep = null) {
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
    callGemini(apiKey, enPrompt),
    callGemini(apiKey, arPrompt),
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
      ? callGemini(apiKey, getSummaryPromptEN(), enResult.value, 2048)
      : Promise.resolve('Summary unavailable.'),
    arResult.status === 'fulfilled'
      ? callGemini(apiKey, getSummaryPromptAR(), arResult.value, 2048)
      : Promise.resolve('الملخص غير متوفر.'),
  ]);

  console.log(`${LOG} Pass 2 — EN summary: ${enSumResult.status}, AR summary: ${arSumResult.status}`);

  // 6. Attach summaries
  en.summary = enSumResult.status === 'fulfilled' ? enSumResult.value : 'Summary unavailable.';
  ar.summary = arSumResult.status === 'fulfilled' ? arSumResult.value : 'الملخص غير متوفر.';

  // If both failed, still return the structure with error messages
  if (enResult.status === 'rejected' && arResult.status === 'rejected') {
    console.error(`${LOG} Both EN and AR generation failed — returning error placeholders`);
  }

  const sitrep = { timestamp, en, ar };
  console.log(`${LOG} SITREP generation complete`);
  return sitrep;
}
