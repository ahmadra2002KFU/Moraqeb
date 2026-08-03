import { assessEvidenceSet, buildEvidenceCatalog, evidenceInstructions, resolveEvidence, sanitizeCitations, validateCitationCoverage } from '../evidence/index.mjs';
import { buildIntelligenceContext } from '../context/builder.mjs';
import { buildWhatChanged } from '../delta/briefing.mjs';

const RISK_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CONFIDENCE_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
const CONFIDENCE_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

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

function normalizeBrief(parsed, language, whatChanged, catalog, requiredIds = []) {
  const validIds = new Set(catalog.map(item => item.id));
  const analytical = language === 'ar'
    ? {
        whyItMatters: '[INFERENCE] قد يؤثر ذلك في أولويات القرار القريبة.',
        businessImpact: '[INFERENCE] قد ينشئ ذلك مخاطر تشغيلية أو سوقية أو مخاطر على استمرارية الأعمال.',
        action: '[INFERENCE] راقب المصدر المذكور واطلب تأكيدا مستقلا.',
        uncertainty: '[INFERENCE] لا يزال التأكيد المستقل غير مكتمل.',
      }
    : {
        whyItMatters: '[INFERENCE] This may affect near-term decision priorities.',
        businessImpact: '[INFERENCE] This may create operating, market, or continuity exposure.',
        action: '[INFERENCE] Monitor the cited source and seek independent confirmation.',
        uncertainty: '[INFERENCE] Independent confirmation remains incomplete.',
      };
  const developments = (Array.isArray(parsed.developments) ? parsed.developments : []).slice(0, 5).map((development, index) => {
    const rawCitations = requiredIds.length ? [requiredIds[index]] : [...new Set(development.citations || [])];
    if (!rawCitations.length || rawCitations.some(id => !validIds.has(id))) {
      throw new Error('Executive citation validation failed');
    }
    const citations = rawCitations;
    const citationTags = citations.map(id => `[${id}]`).join(' ');
    const requestedConfidence = String(development.confidence || '').toUpperCase();
    if (!CONFIDENCE_LEVELS.has(requestedConfidence)) throw new Error('Executive confidence validation failed');
    const corroboration = assessEvidenceSet(citations, catalog);
    const cap = corroboration.confidenceCap;
    const confidence = CONFIDENCE_RANK[requestedConfidence] <= CONFIDENCE_RANK[cap] ? requestedConfidence : cap;
    const selectedEvidence = catalog.find(item => item.id === citations[0]);
    const modelTitle = sanitizeCitations(development.title, catalog).replace(/\[(?:OBSERVED|INFERENCE)\]\s*/gi, '').trim();
    // Canonical English observed titles are source-derived rather than model paraphrases.
    // Arabic remains a constrained translation tied to the same citation IDs.
    const cleanTitle = language === 'en'
      ? String(selectedEvidence?.title || selectedEvidence?.text || modelTitle).replace(/\s+/g, ' ').trim()
      : modelTitle;
    const title = `[OBSERVED] ${cleanTitle}`;
    const titleValidation = validateCitationCoverage(`${title} ${citationTags}`, catalog, { allowCrossLanguage: language === 'ar', crossLanguageVerified: language === 'ar' });
    if (!titleValidation.valid) {
      const error = new Error('Executive development citation validation failed');
      error.validation = {
        language,
        citations,
        coverage: titleValidation.coverage,
        unsupportedCount: titleValidation.unsupportedClaims.length,
      };
      throw error;
    }
    return {
      title,
      whyItMatters: analytical.whyItMatters,
      businessImpact: analytical.businessImpact,
      action: analytical.action,
      confidence,
      corroboration,
      citations,
      citationValidation: { ...titleValidation, valid: true, status: 'validated' },
    };
  });
  const riskLevel = String(parsed.riskLevel || '').toUpperCase();
  if (!RISK_LEVELS.has(riskLevel)) throw new Error('Executive risk level validation failed');
  if (!developments.length) throw new Error('Executive requires at least one supported development');
  const primary = developments[0];
  const summaryTitle = primary.title.replace(/\s*\[E\d+\]/g, '').replace(/[.!?؟]+\s*$/, '').trim();
  const summary = `[OBSERVED] ${summaryTitle} ${primary.citations.map(id => `[${id}]`).join(' ')}. ${primary.whyItMatters}`;
  const summaryValidation = validateCitationCoverage(summary, catalog, { allowCrossLanguage: language === 'ar', crossLanguageVerified: language === 'ar' });
  if (!summaryValidation.valid) {
    const error = new Error('Executive summary citation validation failed');
    error.validation = {
      language,
      coverage: summaryValidation.coverage,
      unsupported: summaryValidation.unsupportedClaims.map(item => ({
        kind: item.kind,
        citationIds: item.citationIds || [],
        unknownIds: item.unknownIds || [],
        hasText: Boolean(String(item.text || '').trim()),
      })),
    };
    throw error;
  }
  const actions = [...new Set(developments.map(() => analytical.action))];
  const uncertainties = [analytical.uncertainty];
  const developmentValid = developments.every(item => item.citationValidation.valid);
  const coverageValid = summaryValidation.valid && developmentValid;
  const citationText = [summary, ...developments.flatMap(item => [item.title, item.whyItMatters, item.businessImpact, item.action, ...item.citations.map(id => `[${id}]`)]), ...actions, ...uncertainties];
  const normalized = {
    title: sanitizeCitations(parsed.title || (language === 'ar' ? 'الإحاطة التنفيذية' : 'Executive Intelligence Brief'), catalog),
    riskLevel,
    summary,
    developments,
    actions,
    uncertainties,
    evidence: resolveEvidence(citationText.join(' '), catalog),
    evidenceStatus: 'validated',
    citationValidation: {
      valid: coverageValid,
      status: 'validated',
      citedIds: [...new Set([...(summaryValidation.citedIds || []), ...developments.flatMap(item => item.citations)])],
      unsupportedIds: [],
      claims: [...summaryValidation.claims, ...developments.flatMap(item => item.citationValidation.claims)],
      uncitedClaims: [],
      mismatchedClaims: [],
      unsupportedClaims: [],
      coverage: {
        totalClaims: summaryValidation.coverage.totalClaims + developments.length,
        evidenceRequired: summaryValidation.coverage.evidenceRequired + developments.length,
        supported: summaryValidation.coverage.supported + developments.length,
        rate: 1,
      },
    },
  };
  const combined = [normalized.title, normalized.summary, ...normalized.developments.flatMap(item => [item.title, item.whyItMatters, item.businessImpact, item.action]), ...normalized.actions, ...normalized.uncertainties].join(' ');
  if (language === 'ar' && !hasArabic(combined)) throw new Error('Arabic executive output validation failed');
  return normalized;
}

function promptFor(language, context, whatChanged, catalog, requiredIds) {
  const arabic = language === 'ar';
  return `You are Moraqeb's senior executive intelligence analyst. Produce ${arabic ? 'Modern Standard Arabic' : 'English'} JSON only.\n` +
    'Return exactly this schema: {"title":string,"riskLevel":"LOW|MEDIUM|HIGH|CRITICAL","summary":string,"developments":[{"title":string,"whyItMatters":string,"businessImpact":string,"action":string,"confidence":"LOW|MEDIUM|HIGH","citations":["E1"]}],"actions":[string],"uncertainties":[string]}.\n' +
    `Produce exactly ${requiredIds.length} developments in this exact order, with citations arrays exactly ${JSON.stringify(requiredIds.map(id => [id]))}. Do not use any other evidence ID. Summary must contain exactly two sentences: first [OBSERVED] with one narrowly scoped factual proposition and its [E#] citation before punctuation; second [INFERENCE] starting exactly "This may" with no new factual details. For every development, whyItMatters and businessImpact must start "[INFERENCE] This may"; action must start "[INFERENCE] Monitor". Every top-level action must start "[INFERENCE] Monitor" and every uncertainty must start "[INFERENCE] Uncertainty remains". Development title must be one concise observed proposition supported by its citations array. Analytical fields must contain no new facts, source numbers, dates, actors, or locations. Never emit [UNSUPPORTED]. Do not invent facts or IDs. Do not sum overlapping FIRMS regional counts or attribute FIRMS anomalies to military activity.\n` +
    `WHAT CHANGED: ${JSON.stringify(whatChanged)}\n` +
    `LIVE CONTEXT:\n${context}\n` + evidenceInstructions(catalog);
}

function selectExecutiveEvidence(catalog) {
  const typePriority = { government: 0, market: 1, news: 2, thermal_unique: 3, air: 4, radiation: 5, space: 6 };
  const ranked = catalog
    .filter(item => item.supportKind === 'direct' && item.sourceFamily !== 'social-osint' && ['fresh', 'aging'].includes(item.freshness))
    .sort((a, b) => (typePriority[a.type] ?? 20) - (typePriority[b.type] ?? 20));
  const selected = [];
  const families = new Set();
  for (const record of ranked) {
    if (families.has(record.sourceFamily)) continue;
    selected.push(record);
    families.add(record.sourceFamily);
    if (selected.length === 2) break;
  }
  if (!selected.length) throw new Error('Executive generation has no fresh direct evidence');
  return selected;
}

function alphaToken(index) {
  let value = Number(index) + 1;
  let token = '';
  while (value > 0) {
    value -= 1;
    token = String.fromCharCode(65 + (value % 26)) + token;
    value = Math.floor(value / 26);
  }
  return `__MORAQEB_NUM_${token}__`;
}

function protectNumericTokens(value) {
  const replacements = new Map();
  const transform = input => {
    if (Array.isArray(input)) return input.map(transform);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, transform(item)]));
    if (typeof input !== 'string') return input;
    return input.replace(/E\d+|\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi, match => {
      if (/^E\d+$/i.test(match)) return match;
      const token = alphaToken(replacements.size);
      replacements.set(token, match);
      return token;
    });
  };
  return { value: transform(value), replacements };
}

function restoreNumericTokens(value, replacements) {
  const transform = input => {
    if (Array.isArray(input)) return input.map(transform);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, transform(item)]));
    if (typeof input !== 'string') return input;
    let output = input;
    for (const [token, number] of replacements) output = output.split(token).join(number);
    return output;
  };
  return transform(value);
}

function alignTranslatedNumbers(canonical, translated) {
  if (Array.isArray(canonical)) {
    if (!Array.isArray(translated) || canonical.length !== translated.length) throw new Error('Executive bilingual alignment failed: array length');
    return canonical.map((item, index) => alignTranslatedNumbers(item, translated[index]));
  }
  if (canonical && typeof canonical === 'object') {
    if (!translated || typeof translated !== 'object' || Array.isArray(translated)) throw new Error('Executive bilingual alignment failed: object shape');
    return Object.fromEntries(Object.keys(translated).map(key => [key, key in canonical ? alignTranslatedNumbers(canonical[key], translated[key]) : translated[key]]));
  }
  if (typeof canonical !== 'string' || typeof translated !== 'string') return translated;
  const numericTokens = value => [...value.matchAll(/E\d+|\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi)]
    .map(match => match[0]).filter(token => !/^E\d+$/i.test(token));
  const expected = numericTokens(canonical);
  const actual = numericTokens(translated);
  if (expected.length !== actual.length) throw new Error('Executive bilingual alignment failed: numeric token count');
  let index = 0;
  return translated.replace(/E\d+|\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi, token => {
    if (/^E\d+$/i.test(token)) return token;
    return expected[index++];
  });
}

function translationPrompt(canonicalEnglish) {
  return `Translate the following canonical executive brief into Modern Standard Arabic. Return JSON only.\n` +
    'Translate text values only. Do not re-analyze, summarize, add, remove, merge, split, or reorder anything.\n' +
    'Preserve riskLevel, every confidence value, every citation ID, array length, and array order exactly. Copy every numeric token, decimal separator, percentage, date, and currency string character-for-character using the original ASCII digits. Do not spell out or localize numbers.\n' +
    'Preserve the markers [OBSERVED], [INFERENCE], and [UNSUPPORTED] exactly when present.\n' +
    `CANONICAL ENGLISH JSON:\n${JSON.stringify(canonicalEnglish)}`;
}

function validateBilingualAlignment(en, ar) {
  const numbers = value => JSON.stringify(value).replace(/E\d+/g, '').match(/\d+(?:[.,]\d+)*(?:%|bp|bps)?/gi) || [];
  const enNumbers = numbers(en);
  const arNumbers = numbers(ar);
  if (JSON.stringify(enNumbers) !== JSON.stringify(arNumbers)) {
    const error = new Error('Executive bilingual alignment failed: numeric values');
    error.validation = { enNumbers, arNumbers };
    throw error;
  }
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
  const executiveEvidence = selectExecutiveEvidence(catalog);
  const requiredIds = executiveEvidence.map(item => item.id);
  const context = buildIntelligenceContext(data, delta);
  const whatChanged = buildWhatChanged(data, delta);
  const enResult = await provider.complete(promptFor('en', context, whatChanged, executiveEvidence, requiredIds), 'Generate the canonical executive brief now.', { maxTokens: 2400, timeout: 120000 });
  const canonicalEnglish = parseJson(enResult.text);
  if (!Array.isArray(canonicalEnglish.developments) || canonicalEnglish.developments.length !== requiredIds.length) {
    throw new Error('Executive development count validation failed');
  }
  const en = normalizeBrief(canonicalEnglish, 'en', whatChanged, catalog, requiredIds);
  const canonicalForTranslation = structuredClone(canonicalEnglish);
  canonicalForTranslation.developments = canonicalForTranslation.developments.map((item, index) => ({
    ...item,
    title: en.developments[index].title,
    citations: requiredIds[index] ? [requiredIds[index]] : [],
  }));
  const protectedCanonical = protectNumericTokens(canonicalForTranslation);
  const arResult = await provider.complete(translationPrompt(protectedCanonical.value), 'ترجم الإحاطة التنفيذية المرجعية إلى العربية دون تغيير محتواها.', { maxTokens: 2400, timeout: 120000 });
  const protectedArabic = parseJson(arResult.text);
  const restoredArabic = restoreNumericTokens(protectedArabic, protectedCanonical.replacements);
  const canonicalArabic = alignTranslatedNumbers(canonicalForTranslation, restoredArabic);
  validateBilingualAlignment(canonicalForTranslation, canonicalArabic);
  const ar = normalizeBrief(canonicalArabic, 'ar', whatChanged, catalog, requiredIds);
  validateBilingualAlignment(en, ar);
  const evidence = [...new Map([...en.evidence, ...ar.evidence].map(item => [item.id, item])).values()];
  const evidenceQuality = assessEvidenceSet(en.citationValidation.citedIds, catalog);
  return {
    timestamp: data.meta?.timestamp || new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    provider: provider.name,
    model: enResult.model || provider.model,
    whatChanged,
    en,
    ar,
    evidence,
    evidenceQuality,
    tokenUsage: {
      inputTokens: (enResult.usage?.inputTokens || 0) + (arResult.usage?.inputTokens || 0),
      outputTokens: (enResult.usage?.outputTokens || 0) + (arResult.usage?.outputTokens || 0),
    },
  };
}
