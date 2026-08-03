import { createHash } from 'crypto';

export function immutableArchiveFilename(artifact, timestampBase) {
  const version = String(artifact?.generation?.promptVersion || 'unversioned').replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16);
  return `${timestampBase}--${version}--${digest}.json`;
}

function languageQuality(language = {}, requireValidationMetadata = false) {
  const status = String(language.evidenceStatus || '').toLowerCase();
  const validation = language.citationValidation || {};
  const serialized = JSON.stringify({
    title: language.title,
    summary: language.summary,
    content: language.content,
    developments: language.developments,
    actions: language.actions,
    uncertainties: language.uncertainties,
  });
  const unsupportedClaims = Array.isArray(validation.unsupportedClaims) ? validation.unsupportedClaims : [];
  const unsupportedIds = Array.isArray(validation.unsupportedIds) ? validation.unsupportedIds : [];
  const coverage = validation.coverage || {};
  const completeCoverage = coverage.rate == null || coverage.rate === 1;
  const citedIds = [...new Set(Array.isArray(validation.citedIds) ? validation.citedIds : [])].sort();
  const resolvedIds = [...new Set(Array.isArray(language.evidence) ? language.evidence.map(item => item?.id).filter(Boolean) : [])].sort();
  const hasCompleteMetadata = !requireValidationMetadata || (
    Number(coverage.evidenceRequired) > 0
    && Number(coverage.supported) === Number(coverage.evidenceRequired)
    && coverage.rate === 1
    && citedIds.length > 0
    && JSON.stringify(citedIds) === JSON.stringify(resolvedIds)
  );
  return {
    publishable: status === 'validated'
      && validation.valid === true
      && unsupportedClaims.length === 0
      && unsupportedIds.length === 0
      && completeCoverage
      && hasCompleteMetadata
      && !serialized.includes('[UNSUPPORTED]'),
    status,
    validationValid: validation.valid === true,
    completeCoverage,
    hasCompleteMetadata,
    containsUnsupported: serialized.includes('[UNSUPPORTED]'),
    unsupportedClaims: unsupportedClaims.length,
    unsupportedIds: unsupportedIds.length,
  };
}

function lineageQuality(artifact = {}) {
  const generation = artifact.generation || {};
  return {
    schema: artifact.schemaVersion === 'moraqeb.generated.v2',
    promptVersion: /^evidence-v\d+$/.test(String(generation.promptVersion || '')),
    jobId: typeof generation.jobId === 'string' && generation.jobId.length > 0,
    snapshotId: /^sweep_[A-Za-z0-9_]+$/.test(String(generation.snapshotId || '')),
    inputHash: /^[a-f0-9]{64}$/i.test(String(generation.inputHash || '')),
  };
}

/**
 * Fail closed before mutating latest.json. Archives may still retain a rejected
 * candidate for diagnosis, but public latest pointers only contain validated output.
 */
export function assertArtifactPublishable(artifact, type = 'generation', options = {}) {
  const en = languageQuality(artifact?.en, Boolean(options.requireLineage));
  const ar = languageQuality(artifact?.ar, Boolean(options.requireLineage));
  const lineage = lineageQuality(artifact);
  const lineageValid = !options.requireLineage || Object.values(lineage).every(Boolean);
  if (!en.publishable || !ar.publishable || !lineageValid) {
    const error = new Error(`${type} artifact failed publication quality gate`);
    error.code = 'ARTIFACT_QUALITY_GATE';
    error.details = { en, ar, lineage, lineageRequired: Boolean(options.requireLineage) };
    throw error;
  }
  return true;
}

export function isArtifactPublishable(artifact, options = {}) {
  try {
    assertArtifactPublishable(artifact, 'generation', options);
    return true;
  } catch {
    return false;
  }
}

function generationTime(artifact = {}) {
  const raw = artifact.generation?.scheduledFor || artifact.generatedAt || artifact.timestamp;
  const value = Date.parse(raw || '');
  return Number.isFinite(value) ? value : null;
}

/** Prevent retries and archive recovery from rolling latest.json backwards. */
export function assertCandidateNotOlder(candidate, current, type = 'generation') {
  if (!current) return true;
  const candidateJob = candidate?.generation?.jobId || candidate?.generationJobId;
  const currentJob = current?.generation?.jobId || current?.generationJobId;
  if (candidateJob && currentJob && candidateJob === currentJob) return true;
  const candidateTime = generationTime(candidate);
  const currentTime = generationTime(current);
  const version = artifact => Number(String(artifact?.generation?.promptVersion || '').match(/^evidence-v(\d+)$/)?.[1] || 0);
  const validVersionUpgrade = candidateTime != null && currentTime != null
    && candidateTime === currentTime && version(candidate) > version(current);
  if (candidateTime == null || currentTime == null || (candidateTime <= currentTime && !validVersionUpgrade)) {
    const error = new Error(`${type} candidate is not newer than current latest`);
    error.code = 'ARTIFACT_STALE_CANDIDATE';
    throw error;
  }
  return true;
}
