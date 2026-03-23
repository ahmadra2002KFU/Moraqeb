// Moraqeb SITREP Blog Generator
// Generates bilingual (English + Arabic) intelligence briefings using Gemini 3 Flash
import { buildIntelligenceContext } from '../context/builder.mjs';
import { getBlogSystemPromptEN, getBlogSystemPromptAR } from '../prompts/strategist.mjs';
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
 */
async function callGemini(apiKey, systemPrompt) {
  const url = `${GEMINI_URL}?key=${apiKey}`;
  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        parts: [{ text: 'Generate the intelligence briefing based on the live feed data provided.' }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 8192,
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
 * Generate a bilingual SITREP from current sweep data.
 * Makes 2 parallel Gemini 3 Flash calls (EN + AR).
 * @param {string} apiKey - Gemini API key
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @returns {Promise<{timestamp: string, en: {title: string, content: string}, ar: {title: string, content: string}}>}
 */
export async function generateSITREP(apiKey, v2Data, deltaData) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting SITREP generation at ${timestamp}`);

  // 1. Build context from live data
  const context = buildIntelligenceContext(v2Data, deltaData);
  console.log(`${LOG} Context built — ${(context.length / 1024).toFixed(1)}KB`);

  // 2. Build system prompts for EN and AR
  const enPrompt = getBlogSystemPromptEN(context, BRIEFING_TEMPLATE);
  const arPrompt = getBlogSystemPromptAR(context, BRIEFING_TEMPLATE);

  // 3. Fire both calls in parallel
  const [enResult, arResult] = await Promise.allSettled([
    callGemini(apiKey, enPrompt),
    callGemini(apiKey, arPrompt),
  ]);

  console.log(`${LOG} EN: ${enResult.status}, AR: ${arResult.status}`);

  // 4. Process English result
  let en;
  if (enResult.status === 'fulfilled') {
    const content = enResult.value;
    en = { title: extractTitle(content, 'Intelligence Briefing'), content };
    console.log(`${LOG} EN SITREP: "${en.title}" (${content.length} chars)`);
  } else {
    console.error(`${LOG} EN generation failed:`, enResult.reason?.message || enResult.reason);
    en = {
      title: 'English Briefing Unavailable',
      content: `# English Briefing Unavailable\n\nThe English SITREP could not be generated at this time.\n\n**Error:** ${enResult.reason?.message || 'Unknown error'}\n\nPlease check the Arabic version or wait for the next update cycle.`,
    };
  }

  // 5. Process Arabic result
  let ar;
  if (arResult.status === 'fulfilled') {
    const content = arResult.value;
    ar = { title: extractTitle(content, 'تقرير استخباراتي'), content };
    console.log(`${LOG} AR SITREP: "${ar.title}" (${content.length} chars)`);
  } else {
    console.error(`${LOG} AR generation failed:`, arResult.reason?.message || arResult.reason);
    ar = {
      title: 'التقرير العربي غير متوفر',
      content: `# التقرير العربي غير متوفر\n\nتعذّر إنشاء التقرير باللغة العربية في الوقت الحالي.\n\n**خطأ:** ${arResult.reason?.message || 'خطأ غير معروف'}\n\nيُرجى مراجعة النسخة الإنجليزية أو الانتظار حتى دورة التحديث التالية.`,
    };
  }

  // If both failed, still return the structure with error messages
  if (enResult.status === 'rejected' && arResult.status === 'rejected') {
    console.error(`${LOG} Both EN and AR generation failed — returning error placeholders`);
  }

  const sitrep = { timestamp, en, ar };
  console.log(`${LOG} SITREP generation complete`);
  return sitrep;
}
