import { buildEvidenceCatalog } from '../evidence/index.mjs';

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

function evidenceForSignal(signal, catalog) {
  const directUrl = signal.item?.url;
  if (directUrl) {
    const exact = catalog.find(item => item.url === directUrl);
    if (exact) return [exact];
  }
  const key = signal.key || '';
  if (key.startsWith('tg_')) {
    const target = String(signal.item?.text || signal.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!target) return [];
    const exact = catalog.find(item => item.type === 'social' && (() => {
      const observation = String(item.observation || '').toLowerCase().replace(/\s+/g, ' ').trim();
      return observation === target || observation.includes(target) || target.includes(observation);
    })());
    return exact ? [exact] : [];
  }
  const type = key.includes('thermal') ? 'thermal'
      : key.includes('air') ? 'air'
        : ['vix', 'hy_spread', '10y2y', 'unemployment', 'fed_funds', '10y_yield', 'usd_index', 'mortgage'].includes(key) ? 'economic'
          : ['wti', 'brent', 'natgas'].includes(key) ? 'energy'
            : key.includes('conflict') ? 'conflict' : null;
  return type ? catalog.filter(item => item.type === type).slice(0, 3) : [];
}

function normalizeSignal(signal, category, catalog) {
  const rawTitle = signal.label || signal.text || signal.item?.text || signal.reason || signal.key || 'Material change';
  return {
    category,
    key: signal.key || null,
    title: String(rawTitle).slice(0, 220),
    from: signal.from ?? signal.previous ?? null,
    to: signal.to ?? signal.current ?? null,
    change: signal.change ?? null,
    pctChange: signal.pctChange ?? null,
    direction: signal.direction || (category === 'deescalated' ? 'down' : category === 'escalated' ? 'up' : 'new'),
    severity: signal.severity || (category === 'new' ? 'high' : 'moderate'),
    evidence: evidenceForSignal(signal, catalog),
  };
}

function normalizeUnique(signals, category, catalog) {
  const unique = new Map();
  for (const signal of signals || []) {
    const normalized = normalizeSignal(signal, category, catalog);
    const id = normalized.key || `${category}|${normalized.title}|${normalized.from}|${normalized.to}`;
    if (!unique.has(id)) unique.set(id, normalized);
  }
  return [...unique.values()];
}

/** Build a deterministic briefing of material changes since the previous sweep. */
export function buildWhatChanged(data = {}, delta = null) {
  const generatedAt = data.meta?.timestamp || delta?.timestamp || new Date().toISOString();
  if (!delta?.summary || !delta?.signals) {
    return {
      generatedAt,
      previous: null,
      hasChanges: false,
      direction: 'baseline',
      counts: { total: 0, critical: 0, new: 0, escalated: 0, deescalated: 0, unchanged: 0 },
      summary: 'No prior comparable sweep is available; this run establishes the baseline.',
      new: [], escalated: [], deescalated: [], topChanges: [], evidence: [],
    };
  }

  const catalog = buildEvidenceCatalog(data, delta);
  const fresh = normalizeUnique(delta.signals.new, 'new', catalog);
  const escalated = normalizeUnique(delta.signals.escalated, 'escalated', catalog);
  const deescalated = normalizeUnique(delta.signals.deescalated, 'deescalated', catalog);
  const topChanges = [...fresh, ...escalated, ...deescalated]
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))
    .slice(0, 10);
  const evidence = [];
  const seen = new Set();
  for (const change of topChanges) {
    for (const item of change.evidence) {
      if (!seen.has(item.id)) { seen.add(item.id); evidence.push(item); }
    }
  }
  const allChanges = [...fresh, ...escalated, ...deescalated];
  const total = allChanges.length;
  const critical = allChanges.filter(change => change.severity === 'critical').length;

  return {
    generatedAt,
    previous: delta.previous || null,
    hasChanges: total > 0,
    direction: delta.summary.direction || 'mixed',
    counts: {
      total,
      critical,
      new: fresh.length,
      escalated: escalated.length,
      deescalated: deescalated.length,
      unchanged: delta.summary.signalBreakdown?.unchanged || delta.signals.unchanged?.length || 0,
    },
    summary: total > 0
      ? `${total} material changes detected since the previous sweep, including ${critical} critical change${critical === 1 ? '' : 's'}; overall direction is ${delta.summary.direction || 'mixed'}.`
      : 'No material changes crossed configured thresholds since the previous sweep.',
    new: fresh,
    escalated,
    deescalated,
    topChanges,
    evidence,
  };
}
