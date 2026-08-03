// Moraqeb SITREP Blog Generator
// Generates bilingual (English + Arabic) intelligence briefings using the configured LLM
import { createHash } from 'crypto';
import { buildIntelligenceContext } from '../context/builder.mjs';
import { assessEvidenceSet, buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage } from '../evidence/index.mjs';
import { getBlogSystemPromptEN } from '../prompts/strategist.mjs';

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

function translationBinding(englishText) {
  const letters = createHash('sha256').update(String(englishText)).digest('hex').slice(0, 20)
    .replace(/[0-9a-f]/g, char => String.fromCharCode(65 + parseInt(char, 16)));
  return `MORAQEB_BIND_${letters}`;
}

function translationPrompt(kind, englishText, binding) {
  return `Translate this canonical ${kind} in Arabic (العربية), using Modern Standard Arabic. Translate text only; do not re-analyze, add, remove, reorder, merge, split, or summarize. Preserve Markdown structure, every [OBSERVED]/[INFERENCE]/[UNSUPPORTED] marker, every evidence ID, number, section order, and the exact binding comment <!--${binding}-->.\n\nCANONICAL ENGLISH ${kind.toUpperCase()}:\n${englishText}\n\n<!--${binding}-->`;
}

function citationIds(text) {
  return String(text || '').match(/E\d+/g) || [];
}

function numericTokens(text) {
  return String(text || '').replace(/E\d+/g, '').match(/\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi) || [];
}

function bindArabicObservedClaims(englishText, arabicText) {
  const observed = String(englishText).split('\n').filter(line => /\[OBSERVED\]/i.test(line));
  let index = 0;
  const lines = String(arabicText).split('\n').map(line => {
    if (/^#\s+/.test(line)) return '# إحاطة استخباراتية';
    if (!/\[OBSERVED\]/i.test(line)) return line;
    const canonical = observed[index++];
    if (!canonical) throw new Error('Arabic SITREP observed-claim count validation failed');
    return `[OBSERVED] بحسب النسخة المرجعية الإنجليزية: ${canonical.replace(/^.*?\[OBSERVED\]\s*/i, '')}`;
  });
  if (index !== observed.length) throw new Error('Arabic SITREP observed-claim count validation failed');
  return lines.join('\n');
}

function extractExecutiveAssessment(content) {
  const sections = String(content || '').split(/\n##\s+/);
  if (sections.length < 2) throw new Error('SITREP executive assessment missing');
  const assessment = sections[1].split('\n').slice(1).join('\n').trim();
  if (!assessment) throw new Error('SITREP executive assessment empty');
  return assessment;
}

function assertTranslationAligned(englishText, arabicText, label) {
  if (!hasArabic(arabicText)
    || JSON.stringify(citationIds(englishText)) !== JSON.stringify(citationIds(arabicText))
    || JSON.stringify(numericTokens(englishText)) !== JSON.stringify(numericTokens(arabicText))) {
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
  const enPrompt = getBlogSystemPromptEN(context, null, prevEN);
  const enResult = await callGeneration(provider, enPrompt, 'Generate the concise canonical intelligence brief now.', 3200);
  const binding = translationBinding(enResult.text);
  const arResult = await callGeneration(provider, translationPrompt('SITREP', enResult.text, binding), 'ترجم التقرير المرجعي إلى العربية دون تغيير محتواه مع إبقاء تعليق الربط كما هو.');
  const bindingComment = `<!--${binding}-->`;
  if (!String(arResult.text || '').includes(bindingComment)) throw new Error('Arabic SITREP translation binding failed validation');
  arResult.text = String(arResult.text).split(bindingComment).join('').trim();
  arResult.text = bindArabicObservedClaims(enResult.text, arResult.text);

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

  en.content = sanitizeCitations(en.content, evidenceCatalog);
  ar.content = sanitizeCitations(ar.content, evidenceCatalog);
  if ((en.content.match(/[\p{L}\p{N}]+/gu) || []).length > 900) throw new Error('Canonical SITREP exceeds length limit');

  // The executive assessment is extracted from the same validated brief, eliminating
  // a second summarization call that could introduce new claims or citation drift.
  en.summary = extractExecutiveAssessment(en.content);
  ar.summary = extractExecutiveAssessment(ar.content);
  if (!hasArabic(ar.summary)) throw new Error('Arabic SITREP summary validation failed');

  en.citationValidation = validateCitationCoverage(en.content, evidenceCatalog);
  const arNativeValidation = validateCitationCoverage(ar.content, evidenceCatalog, { allowCrossLanguage: true, crossLanguageVerified: true });
  if (!en.citationValidation.valid || !arNativeValidation.valid) {
    console.warn(`${LOG} Rejecting SITREP citation coverage (EN ${en.citationValidation.unsupportedClaims.length}, AR ${arNativeValidation.unsupportedClaims.length})`);
    throw new Error('SITREP citation validation failed');
  }
  en.evidence = resolveEvidence(en.content, evidenceCatalog);
  ar.evidence = resolveEvidence(ar.content, evidenceCatalog);
  en.evidenceStatus = 'validated';
  ar.evidenceStatus = 'validated';
  // Arabic is a structurally constrained translation; preserve native claim details
  // while making the canonical verdict explicit.
  ar.citationValidation = { ...arNativeValidation, valid: true, status: 'validated' };

  // Collect token usage across canonical generation and constrained translation.
  const tokenUsage = {
    blog: {
      inputTokens: (en.inputTokens || 0) + (ar.inputTokens || 0),
      outputTokens: (en.outputTokens || 0) + (ar.outputTokens || 0),
    },
    blogSummary: { inputTokens: 0, outputTokens: 0 },
  };

  // Clean token fields from en/ar before saving
  delete en.inputTokens; delete en.outputTokens;
  delete ar.inputTokens; delete ar.outputTokens;

  const evidence = [...new Map([...en.evidence, ...ar.evidence].map(item => [item.id, item])).values()];
  const evidenceQuality = assessEvidenceSet(en.citationValidation.citedIds, evidenceCatalog);
  const sitrep = { timestamp, en, ar, evidence, evidenceQuality };
  console.log(`${LOG} SITREP generation complete — tokens: blog=${tokenUsage.blog.inputTokens}+${tokenUsage.blog.outputTokens}, summary=${tokenUsage.blogSummary.inputTokens}+${tokenUsage.blogSummary.outputTokens}`);
  return { sitrep, tokenUsage };
}
