// Moraqeb Post Generator
// Generates short bilingual (EN + AR) intelligence updates using the configured LLM
import { buildIntelligenceContext } from '../context/builder.mjs';
import { buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage, markUnsupportedClaims } from '../evidence/index.mjs';
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

function translationPrompt(englishText) {
  return 'Translate this canonical intelligence update in Arabic (العربية), using Modern Standard Arabic. Translate text only; do not re-analyze, add, remove, reorder, or summarize. Preserve Markdown, every [OBSERVED]/[INFERENCE]/[UNSUPPORTED] marker, every evidence ID, number, and hashtag exactly.\n\nCANONICAL ENGLISH UPDATE:\n' + englishText;
}

function citationIds(text) {
  return String(text || '').match(/E\d+/g) || [];
}

function numericTokens(text) {
  return String(text || '').replace(/E\d+/g, '').match(/\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi) || [];
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
  const arResult = await callLLMWithRetry(provider, translationPrompt(enText), 'ترجم التحديث المرجعي إلى العربية دون تغيير محتواه.');
  totalInput += arResult.inputTokens || 0;
  totalOutput += arResult.outputTokens || 0;
  const arText = stripThinking(arResult.text);
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
  const isInference = claim => /\[INFERENCE\]/i.test(String(claim));
  const factualUncited = canonicalCoverage.uncitedClaims.filter(claim => !isInference(claim));
  const factualMismatched = canonicalCoverage.mismatchedClaims.filter(claim => !isInference(claim));
  if (!canonicalCoverage.citedIds.length || factualUncited.length) {
    console.warn(`${LOG} Rejecting post coverage: cited=${canonicalCoverage.citedIds.length}, uncitedFactual=${factualUncited.length}`);
    throw new Error('Canonical post citation validation failed');
  }
  const canonicalValid = factualMismatched.length === 0;
  en.citationValidation = {
    ...canonicalCoverage,
    valid: canonicalValid,
    status: canonicalValid ? 'supported' : 'partial',
    uncitedClaims: [],
    mismatchedClaims: factualMismatched,
  };
  if (!canonicalValid) {
    en.content = markUnsupportedClaims(en.content, en.citationValidation);
    ar.content = `[UNSUPPORTED] ${ar.content}`;
  }
  // Arabic is a constrained, structure-validated translation of the canonical post.
  // Reuse the canonical coverage verdict because lexical matching is language-specific.
  ar.citationValidation = {
    ...validateCitationCoverage(ar.content, evidenceCatalog),
    valid: canonicalValid,
    status: en.citationValidation.status,
    uncitedClaims: [],
    mismatchedClaims: canonicalValid ? [] : ['Canonical source-to-claim match requires review'],
  };
  en.evidenceStatus = en.citationValidation.status;
  ar.evidenceStatus = en.citationValidation.status;

  const tokenUsage = {
    post: { inputTokens: totalInput, outputTokens: totalOutput },
  };

  const evidence = [...new Map([...(en.evidence || []), ...(ar.evidence || [])].map(item => [item.id, item])).values()];
  const post = { timestamp, en, ar, evidence };
  console.log(`${LOG} Post complete — EN: "${en.title}", AR: "${ar.title}" — tokens: ${totalInput}+${totalOutput}`);
  return { post, tokenUsage };
}
