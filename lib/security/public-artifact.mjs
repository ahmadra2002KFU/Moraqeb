const PUBLIC_PROVIDER_ERROR = 'The AI provider request failed. Please try again.';
const PROVIDER_FAILURE = /\b(?:OmniRoute|OpenAI|MiniMax|Mistral|OpenRouter|LLM)\s+(?:API\s+)?(?:error|failed|failure|\d{3})\b|\bupstream\b.{0,80}\b(?:error|failed|body|request|token)\b|\brequest[_ -]?id\b/i;
const SECRET_VALUE = /\b(?:api[_-]?key|token|password|authorization|secret)\s*[=:]\s*[^\s,;)}\]]+/ig;

function sanitizeString(value) {
  if (PROVIDER_FAILURE.test(value)) return PUBLIC_PROVIDER_ERROR;
  return value.replace(SECRET_VALUE, '$1=[REDACTED]');
}

export function sanitizePublicArtifact(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizePublicArtifact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePublicArtifact(item)]));
}

export { PUBLIC_PROVIDER_ERROR };
