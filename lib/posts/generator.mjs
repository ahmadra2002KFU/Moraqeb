// Moraqeb Post Generator
// Generates short bilingual (EN + AR) intelligence updates using the configured LLM
import { createHash } from 'crypto';
import { buildIntelligenceContext } from '../context/builder.mjs';
import { assessEvidenceSet, buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage } from '../evidence/index.mjs';
import { getPostSystemPromptEN } from '../prompts/posts.mjs';

const LOG = '[Moraqeb Post]';
const TIMEOUT_MS = 90_000;

function hasArabic(text) {
  const value = String(text || '');
  const arabic = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const letters = (value.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  return arabic >= 12 && arabic / Math.max(letters, 1) >= 0.35;
}

/**
 * Call the configured LLM for post generation.
 */
async function callLLM(provider, systemPrompt, userMessage = 'Generate the intelligence update based on the live feed data provided.', maxTokens = 512) {
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

/**
 * Call the configured LLM with 1 retry on failure (2s backoff).
 */
async function callLLMWithRetry(provider, systemPrompt, userMessage, maxTokens = 512) {
  try {
    return await callLLM(provider, systemPrompt, userMessage, maxTokens);
  } catch (err) {
    console.warn(`${LOG} First provider attempt failed; retrying in 2s…`);
    await new Promise(r => setTimeout(r, 2000));
    return await callLLM(provider, systemPrompt, userMessage, maxTokens);
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
  return firstLine ? firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim().substring(0, 80) : fallback;
}

function translationBinding(englishText) {
  const letters = createHash('sha256').update(String(englishText)).digest('hex').slice(0, 20)
    .replace(/[0-9a-f]/g, char => String.fromCharCode(65 + parseInt(char, 16)));
  return `MORAQEB_BIND_${letters}`;
}

function translationPrompt(englishText, binding) {
  return `Translate this canonical intelligence update in Arabic (العربية), using Modern Standard Arabic. Translate text only; do not re-analyze, add, remove, reorder, or summarize. Preserve Markdown, every [OBSERVED]/[INFERENCE]/[UNSUPPORTED] marker, every evidence ID, number, hashtag, and the exact binding comment <!--${binding}-->.\n\nCANONICAL ENGLISH UPDATE:\n${englishText}\n\n<!--${binding}-->`;
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
    if (/^#\s+/.test(line)) return '# تحديث استخباراتي';
    if (!/\[OBSERVED\]/i.test(line)) return line;
    const canonical = observed[index++];
    if (!canonical) throw new Error('Bilingual post observed-claim count validation failed');
    return `[OBSERVED] بحسب النسخة المرجعية الإنجليزية: ${canonical.replace(/^.*?\[OBSERVED\]\s*/i, '')}`;
  });
  if (index !== observed.length) throw new Error('Bilingual post observed-claim count validation failed');
  return lines.join('\n');
}

/**
 * Generate a bilingual post from current sweep data.
 * @param {import('../llm/provider.mjs').LLMProvider} provider
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta from previous sweep
 * @param {Array} recentTopics - Recent post topics for dedup
 * @returns {Promise<{post: object, tokenUsage: object}>}
 */
export async function generatePost(provider, v2Data, deltaData, recentTopics = [], dedupCheck = null) {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} Starting post generation at ${timestamp}`);

  const evidenceCatalog = buildEvidenceCatalog(v2Data, deltaData);
  const context = `${buildIntelligenceContext(v2Data, deltaData)}\n\n${evidenceInstructions(evidenceCatalog)}`;

  const enPrompt = getPostSystemPromptEN(context, recentTopics);

  // ── Generate one canonical EN update, then translate it ────────────────────
  let totalInput = 0, totalOutput = 0;

  // EN generation + dedup gate
  let enText = null;
  try {
    const enRes = await callLLMWithRetry(provider, enPrompt);
    totalInput += enRes.inputTokens || 0;
    totalOutput += enRes.outputTokens || 0;
    enText = stripThinking(enRes.text);
  } catch (err) {
    console.error(`${LOG} EN generation failed after retry`);
  }

  // ── Dedup gate: check EN content against recent posts ─────────────────────
  if (enText && dedupCheck) {
    const dupResult = dedupCheck(enText);
    if (dupResult.isDuplicate) {
      console.warn(`${LOG} Duplicate detected (sim=${dupResult.similarity.toFixed(2)}, match="${dupResult.bestMatch}") — regenerating with avoidance`);
      const avoidPrompt = `CRITICAL: The topic "${dupResult.bestMatch}" has ALREADY been covered. You MUST choose a completely different signal.\n\n${enPrompt}`;
      try {
        const retry = await callLLMWithRetry(provider, avoidPrompt);
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
        console.error(`${LOG} Dedup regeneration failed — using original`);
      }
    }
  }

  if (!enText) throw new Error('Canonical post generation failed validation');
  const binding = translationBinding(enText);
  const arResult = await callLLMWithRetry(provider, translationPrompt(enText, binding), 'ترجم التحديث المرجعي إلى العربية دون تغيير محتواه مع إبقاء تعليق الربط كما هو.');
  totalInput += arResult.inputTokens || 0;
  totalOutput += arResult.outputTokens || 0;
  let arText = stripThinking(arResult.text);
  const bindingComment = `<!--${binding}-->`;
  if (!arText.includes(bindingComment)) throw new Error('Bilingual post translation binding failed validation');
  arText = arText.split(bindingComment).join('').trim();
  arText = bindArabicObservedClaims(enText, arText);
  if (!arText || !hasArabic(arText)
    || JSON.stringify(citationIds(enText)) !== JSON.stringify(citationIds(arText))
    || JSON.stringify(numericTokens(enText)) !== JSON.stringify(numericTokens(arText))) {
    throw new Error('Bilingual post generation failed validation');
  }

  enText = sanitizeCitations(enText, evidenceCatalog);
  const safeArText = arText ? sanitizeCitations(arText, evidenceCatalog) : arText;

  const en = enText
    ? { title: extractTitle(enText), content: enText, evidence: resolveEvidence(enText, evidenceCatalog) }
    : { title: 'Update Unavailable', content: 'The English update could not be generated at this time.' };

  const ar = safeArText
    ? { title: extractTitle(safeArText, 'تحديث استخباراتي'), content: safeArText, evidence: resolveEvidence(safeArText, evidenceCatalog) }
    : { title: 'التحديث غير متوفر', content: 'تعذّر إنشاء التحديث باللغة العربية في الوقت الحالي.' };
  const canonicalCoverage = validateCitationCoverage(en.content, evidenceCatalog);
  if (!canonicalCoverage.valid) {
    console.warn(`${LOG} Rejecting post coverage: cited=${canonicalCoverage.citedIds.length}, unsupported=${canonicalCoverage.unsupportedClaims.length}`);
    throw new Error('Canonical post citation validation failed');
  }
  en.citationValidation = { ...canonicalCoverage, valid: true, status: 'validated' };
  // Arabic is a constrained translation. Cross-language lexical inheritance is
  // permitted only after exact citation and numeric parity checks above.
  const arabicCoverage = validateCitationCoverage(ar.content, evidenceCatalog, { allowCrossLanguage: true, crossLanguageVerified: true });
  if (!arabicCoverage.valid) throw new Error('Arabic post citation validation failed');
  ar.citationValidation = { ...arabicCoverage, status: 'validated' };
  en.evidenceStatus = en.citationValidation.status;
  ar.evidenceStatus = ar.citationValidation.status;

  const tokenUsage = {
    post: { inputTokens: totalInput, outputTokens: totalOutput },
  };

  const evidence = [...new Map([...(en.evidence || []), ...(ar.evidence || [])].map(item => [item.id, item])).values()];
  const evidenceQuality = assessEvidenceSet(en.citationValidation.citedIds, evidenceCatalog);
  const post = { timestamp, en, ar, evidence, evidenceQuality };
  console.log(`${LOG} Post complete — EN: "${en.title}", AR: "${ar.title}" — tokens: ${totalInput}+${totalOutput}`);
  return { post, tokenUsage };
}
