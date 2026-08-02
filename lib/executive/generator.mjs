import { buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage, markUnsupportedClaims } from '../evidence/index.mjs';
import { buildIntelligenceContext } from '../context/builder.mjs';
import { buildWhatChanged } from '../delta/briefing.mjs';

const RISK_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CONFIDENCE_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);

function hasArabic(text) {
  const value = String(text || '');
  const arabic = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const letters = (value.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  return arabic >= 20 && arabic / Math.max(letters, 1) >= 0.35;
}

function parseJson(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Executive model returned invalid JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

function normalizeBrief(parsed, language, whatChanged, catalog) {
  const validIds = new Set(catalog.map(item => item.id));
  const developments = (Array.isArray(parsed.developments) ? parsed.developments : []).slice(0, 5).map(development => {
    const rawCitations = [...new Set(development.citations || [])];
    if (!rawCitations.length || rawCitations.some(id => !validIds.has(id))) {
      throw new Error('Executive citation validation failed');
    }
    const citations = rawCitations;
    const citationTags = citations.map(id => `[${id}]`).join(' ');
    const confidence = String(development.confidence || '').toUpperCase();
    if (!CONFIDENCE_LEVELS.has(confidence)) throw new Error('Executive confidence validation failed');
    const fields = {};
    const validations = [];
    for (const field of ['title', 'whyItMatters', 'businessImpact', 'action']) {
      const value = sanitizeCitations(development[field], catalog);
      const validation = validateCitationCoverage(`${value} ${citationTags}`, catalog);
      fields[field] = validation.valid ? value : `[UNSUPPORTED] ${value}`;
      validations.push(validation);
    }
    return {
      ...fields,
      confidence,
      citations,
      citationValidation: {
        valid: validations.every(item => item.valid),
        claims: validations.flatMap(item => item.claims),
        uncitedClaims: validations.flatMap(item => item.uncitedClaims),
        mismatchedClaims: validations.flatMap(item => item.mismatchedClaims),
      },
    };
  });
  const riskLevel = String(parsed.riskLevel || '').toUpperCase();
  if (!RISK_LEVELS.has(riskLevel)) throw new Error('Executive risk level validation failed');
  let summary = sanitizeCitations(parsed.summary || whatChanged.summary, catalog);
  const summaryValidation = validateCitationCoverage(summary, catalog);
  if (!summaryValidation.valid) summary = markUnsupportedClaims(summary, summaryValidation);
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).slice(0, 7).map(value => {
    const clean = sanitizeCitations(value, catalog);
    return /^\[INFERENCE\]/.test(clean) ? clean : `[INFERENCE] ${clean}`;
  });
  const uncertaintyValidations = [];
  const uncertainties = (Array.isArray(parsed.uncertainties) ? parsed.uncertainties : []).slice(0, 7).map(value => {
    const clean = sanitizeCitations(value, catalog);
    const validation = validateCitationCoverage(clean, catalog);
    uncertaintyValidations.push(validation);
    return validation.valid ? clean : markUnsupportedClaims(clean, validation);
  });
  const developmentValid = developments.every(item => item.citationValidation.valid);
  const uncertaintyValid = uncertaintyValidations.every(item => item.valid);
  const coverageValid = summaryValidation.valid && developmentValid && uncertaintyValid;
  const citationText = [summary, ...developments.flatMap(item => [item.title, item.whyItMatters, item.businessImpact, item.action, ...item.citations.map(id => `[${id}]`)]), ...actions, ...uncertainties];
  const normalized = {
    title: sanitizeCitations(parsed.title || (language === 'ar' ? 'الإحاطة التنفيذية' : 'Executive Intelligence Brief'), catalog),
    riskLevel,
    summary,
    developments,
    actions,
    uncertainties,
    evidence: resolveEvidence(citationText.join(' '), catalog),
    evidenceStatus: coverageValid ? 'validated' : 'partial',
    citationValidation: {
      valid: coverageValid,
      status: coverageValid ? 'validated' : 'partial',
      claims: [...summaryValidation.claims, ...developments.flatMap(item => item.citationValidation.claims), ...uncertaintyValidations.flatMap(item => item.claims)],
      uncitedClaims: [...summaryValidation.uncitedClaims, ...developments.flatMap(item => item.citationValidation.uncitedClaims), ...uncertaintyValidations.flatMap(item => item.uncitedClaims)],
      mismatchedClaims: [...summaryValidation.mismatchedClaims, ...developments.flatMap(item => item.citationValidation.mismatchedClaims), ...uncertaintyValidations.flatMap(item => item.mismatchedClaims)],
    },
  };
  const combined = [normalized.title, normalized.summary, ...normalized.developments.flatMap(item => [item.title, item.whyItMatters, item.businessImpact, item.action]), ...normalized.actions, ...normalized.uncertainties].join(' ');
  if (language === 'ar' && !hasArabic(combined)) throw new Error('Arabic executive output validation failed');
  return normalized;
}

function promptFor(language, context, whatChanged, catalog) {
  const arabic = language === 'ar';
  return `You are Moraqeb's senior executive intelligence analyst. Produce ${arabic ? 'Modern Standard Arabic' : 'English'} JSON only.\n` +
    'Return exactly this schema: {"title":string,"riskLevel":"LOW|MEDIUM|HIGH|CRITICAL","summary":string,"developments":[{"title":string,"whyItMatters":string,"businessImpact":string,"action":string,"confidence":"LOW|MEDIUM|HIGH","citations":["E1"]}],"actions":[string],"uncertainties":[string]}.\n' +
    'Select at most 3 developments. Separate observed facts from interpretation in the wording. Every factual sentence in summary and every development must cite valid evidence IDs. Do not invent facts or IDs.\n' +
    `WHAT CHANGED: ${JSON.stringify(whatChanged)}\n` +
    `LIVE CONTEXT:\n${context}\n` + evidenceInstructions(catalog);
}

function translationPrompt(canonicalEnglish) {
  return `Translate the following canonical executive brief into Modern Standard Arabic. Return JSON only.\n` +
    'Translate text values only. Do not re-analyze, summarize, add, remove, merge, split, or reorder anything.\n' +
    'Preserve riskLevel, every confidence value, every citation ID, array length, and array order exactly.\n' +
    'Preserve the markers [OBSERVED], [INFERENCE], and [UNSUPPORTED] exactly when present.\n' +
    `CANONICAL ENGLISH JSON:\n${JSON.stringify(canonicalEnglish)}`;
}

function validateBilingualAlignment(en, ar) {
  if (String(en.riskLevel).toUpperCase() !== String(ar.riskLevel).toUpperCase()) {
    throw new Error('Executive bilingual alignment failed: risk level');
  }
  for (const field of ['developments', 'actions', 'uncertainties']) {
    if (!Array.isArray(en[field]) || !Array.isArray(ar[field]) || en[field].length !== ar[field].length) {
      throw new Error(`Executive bilingual alignment failed: ${field} length`);
    }
  }
  for (let index = 0; index < en.developments.length; index += 1) {
    const enItem = en.developments[index];
    const arItem = ar.developments[index];
    if (String(enItem.confidence).toUpperCase() !== String(arItem.confidence).toUpperCase()) {
      throw new Error(`Executive bilingual alignment failed: development ${index + 1} confidence`);
    }
    if (JSON.stringify(enItem.citations || []) !== JSON.stringify(arItem.citations || [])) {
      throw new Error(`Executive bilingual alignment failed: development ${index + 1} citations`);
    }
  }
}

export async function generateExecutiveBrief(provider, data, delta) {
  const catalog = buildEvidenceCatalog(data, delta);
  const context = buildIntelligenceContext(data, delta);
  const whatChanged = buildWhatChanged(data, delta);
  const enResult = await provider.complete(promptFor('en', context, whatChanged, catalog), 'Generate the canonical executive brief now.', { maxTokens: 2400, timeout: 120000 });
  const canonicalEnglish = parseJson(enResult.text);
  const en = normalizeBrief(canonicalEnglish, 'en', whatChanged, catalog);
  const arResult = await provider.complete(translationPrompt(canonicalEnglish), 'ترجم الإحاطة التنفيذية المرجعية إلى العربية دون تغيير محتواها.', { maxTokens: 2400, timeout: 120000 });
  const canonicalArabic = parseJson(arResult.text);
  validateBilingualAlignment(canonicalEnglish, canonicalArabic);
  const ar = normalizeBrief(canonicalArabic, 'ar', whatChanged, catalog);
  validateBilingualAlignment(en, ar);
  return {
    timestamp: data.meta?.timestamp || new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    provider: provider.name,
    model: enResult.model || provider.model,
    whatChanged,
    en,
    ar,
    evidence: [...new Map([...en.evidence, ...ar.evidence].map(item => [item.id, item])).values()],
    tokenUsage: {
      inputTokens: (enResult.usage?.inputTokens || 0) + (arResult.usage?.inputTokens || 0),
      outputTokens: (enResult.usage?.outputTokens || 0) + (arResult.usage?.outputTokens || 0),
    },
  };
}
