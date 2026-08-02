// Moraqeb SITREP Blog Generator
// Generates bilingual (English + Arabic) intelligence briefings using the configured LLM
import { buildIntelligenceContext } from '../context/builder.mjs';
import { buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage, markUnsupportedClaims } from '../evidence/index.mjs';
import { getBlogSystemPromptEN, getSummaryPromptEN } from '../prompts/strategist.mjs';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the briefing template once at module init
const BRIEFING_TEMPLATE = readFileSync(join(__dirname, '../../apis/BRIEFING_TEMPLATE.md'), 'utf-8');

const LOG = '[Moraqeb Blog]';
const TIMEOUT_MS = 120_000;
const GENERATION_ERROR = 'The AI provider request failed. Please try again.';

function hasArabic(text) {
  const value = String(text || '');
  const arabic = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const letters = (value.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  return arabic >= 20 && arabic / Math.max(letters, 1) >= 0.35;
}

/**
 * Call the configured LLM with a system prompt.
 * @param {import('../llm/provider.mjs').LLMProvider} provider
 * @param {string} systemPrompt - System instruction for the model
 * @param {string} userMessage - User message / content to process
 * @param {number} maxTokens - Maximum output tokens
 */
async function callLLM(provider, systemPrompt, userMessage = 'Generate the intelligence briefing based on the live feed data provided.', maxTokens = 8192) {
  const result = await provider.complete(systemPrompt, userMessage, {
    maxTokens,
    timeout: TIMEOUT_MS,
  });
  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
  };
}

async function callGeneration(provider, systemPrompt, userMessage, maxTokens) {
  try {
    return await callLLM(provider, systemPrompt, userMessage, maxTokens);
  } catch (_) {
    console.error(`${LOG} Generation stage failed`);
    throw new Error('SITREP generation failed');
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

function translationPrompt(kind, englishText) {
  return `Translate this canonical ${kind} in Arabic (العربية), using Modern Standard Arabic. Translate text only; do not re-analyze, add, remove, reorder, merge, split, or summarize. Preserve Markdown structure, every [OBSERVED]/[INFERENCE]/[UNSUPPORTED] marker, every evidence ID, number, and section order exactly.\n\nCANONICAL ENGLISH ${kind.toUpperCase()}:\n${englishText}`;
}

function citationIds(text) {
  return String(text || '').match(/E\d+/g) || [];
}

function assertTranslationAligned(englishText, arabicText, label) {
  if (!hasArabic(arabicText) || JSON.stringify(citationIds(englishText)) !== JSON.stringify(citationIds(arabicText))) {
    throw new Error(`Arabic ${label} alignment validation failed`);
  }
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
      content: fallbackContent.replace('{{ERROR}}', GENERATION_ERROR),
    };
  }
}

/**
 * Generate a bilingual SITREP from current sweep data.
 * Two-pass generation: Pass 1 generates full SITREPs, Pass 2 generates summaries.
 * @param {import('../llm/provider.mjs').LLMProvider} provider
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @param {object|null} previousSitrep - Previous SITREP object with en/ar content for delta generation
 * @returns {Promise<{timestamp: string, en: {title: string, summary: string, content: string}, ar: {title: string, summary: string, content: string}}>}
 */
export async function generateSITREP(provider, v2Data, deltaData, previousSitrep = null) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting SITREP generation at ${timestamp}`);

  // 1. Build context from live data
  const evidenceCatalog = buildEvidenceCatalog(v2Data, deltaData);
  const context = `${buildIntelligenceContext(v2Data, deltaData)}\n\n${evidenceInstructions(evidenceCatalog)}`;
  console.log(`${LOG} Context built — ${(context.length / 1024).toFixed(1)}KB`);

  // Extract previous content for delta
  const prevEN = previousSitrep?.en?.content || null;

  // Build one canonical English briefing, then translate it without re-analysis.
  const enPrompt = getBlogSystemPromptEN(context, BRIEFING_TEMPLATE, prevEN);
  const enResult = await callGeneration(provider, enPrompt);
  const arResult = await callGeneration(provider, translationPrompt('SITREP', enResult.text), 'ترجم التقرير المرجعي إلى العربية دون تغيير محتواه.');

  console.log(`${LOG} Pass 1 — canonical EN fulfilled, AR translation fulfilled`);
  assertTranslationAligned(enResult.text, arResult.text, 'SITREP');

  // 4. Process results
  const en = processResult(
    { status: 'fulfilled', value: enResult },
    'English Briefing Unavailable',
    `# English Briefing Unavailable\n\nThe English SITREP could not be generated at this time.\n\n**Error:** {{ERROR}}\n\nPlease check the Arabic version or wait for the next update cycle.`,
    'EN',
  );

  const ar = processResult(
    { status: 'fulfilled', value: arResult },
    'التقرير العربي غير متوفر',
    `# التقرير العربي غير متوفر\n\nتعذّر إنشاء التقرير باللغة العربية في الوقت الحالي.\n\n**خطأ:** {{ERROR}}\n\nيُرجى مراجعة النسخة الإنجليزية أو الانتظار حتى دورة التحديث التالية.`,
    'AR',
  );
  if (!hasArabic(ar.content)) throw new Error('Arabic SITREP validation failed');

  // Generate one canonical English summary, then translate it without re-analysis.
  const enSum = await callGeneration(provider, getSummaryPromptEN(), enResult.text, 2048);
  const arSum = await callGeneration(provider, translationPrompt('summary', enSum.text), 'ترجم الملخص المرجعي إلى العربية دون تغيير محتواه.', 2048);
  assertTranslationAligned(enSum.text, arSum.text, 'summary');
  console.log(`${LOG} Pass 2 — canonical EN summary fulfilled, AR translation fulfilled`);

  en.summary = stripThinking(enSum.text);
  ar.summary = stripThinking(arSum.text);
  en.content = sanitizeCitations(en.content, evidenceCatalog);
  ar.content = sanitizeCitations(ar.content, evidenceCatalog);
  en.summary = sanitizeCitations(en.summary, evidenceCatalog);
  ar.summary = sanitizeCitations(ar.summary, evidenceCatalog);
  if (!hasArabic(ar.summary)) throw new Error('Arabic SITREP summary validation failed');
  en.evidence = resolveEvidence(`${en.content}\n${en.summary}`, evidenceCatalog);
  ar.evidence = resolveEvidence(`${ar.content}\n${ar.summary}`, evidenceCatalog);
  en.citationValidation = validateCitationCoverage(`${en.content}\n${en.summary}`, evidenceCatalog);
  ar.citationValidation = validateCitationCoverage(`${ar.content}\n${ar.summary}`, evidenceCatalog);
  en.evidenceStatus = en.citationValidation.status;
  ar.evidenceStatus = ar.citationValidation.status;
  if (!en.citationValidation.valid || !ar.citationValidation.valid) {
    en.content = markUnsupportedClaims(en.content, en.citationValidation);
    en.summary = markUnsupportedClaims(en.summary, en.citationValidation);
    ar.content = markUnsupportedClaims(ar.content, ar.citationValidation);
    ar.summary = markUnsupportedClaims(ar.summary, ar.citationValidation);
    console.warn(`${LOG} Publishing visibly marked partial citation coverage (EN ${en.citationValidation.uncitedClaims.length + en.citationValidation.mismatchedClaims.length}, AR ${ar.citationValidation.uncitedClaims.length + ar.citationValidation.mismatchedClaims.length})`);
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

  const evidence = [...new Map([...en.evidence, ...ar.evidence].map(item => [item.id, item])).values()];
  const sitrep = { timestamp, en, ar, evidence };
  console.log(`${LOG} SITREP generation complete — tokens: blog=${tokenUsage.blog.inputTokens}+${tokenUsage.blog.outputTokens}, summary=${tokenUsage.blogSummary.inputTokens}+${tokenUsage.blogSummary.outputTokens}`);
  return { sitrep, tokenUsage };
}
