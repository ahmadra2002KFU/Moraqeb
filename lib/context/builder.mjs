// Moraqeb Intelligence Context Builder
// Compacts V2 sweep data into a rich text context string for LLM prompts (chat, voice, blog)

/**
 * Build a comprehensive intelligence context string from the current sweep data.
 * More detailed than compactSweepForLLM in ideas.mjs — includes all source summaries.
 * Organized by priority tiers for focused LLM analysis.
 * @param {object} v2Data - Synthesized dashboard data
 * @param {object|null} deltaData - Delta changes from previous sweep
 * @returns {string} Context string (~8-15KB)
 */
export function buildIntelligenceContext(v2Data, deltaData) {
  if (!v2Data) return 'No intelligence data available yet. The first sweep has not completed.';

  const sections = [];
  const ts = v2Data.meta?.timestamp || 'unknown collection time';
  sections.push(`=== MORAQEB INTELLIGENCE SNAPSHOT ===`);
  sections.push(`Timestamp: ${ts}`);
  sections.push(`Sources usable: ${v2Data.meta?.sourcesUsable ?? v2Data.meta?.sourcesOk ?? 0}/${v2Data.meta?.sourcesQueried || 0}; degraded: ${v2Data.meta?.sourcesDegraded || 0}; failed: ${v2Data.meta?.sourcesFailed || 0}`);
  sections.push('');
  sections.push('PRIORITY: Focus analysis on TIER 1 signals. Use TIER 2 for supporting evidence. Reference TIER 3 only when noteworthy.');
  sections.push('');

  // ========== TIER 1: CRITICAL SIGNALS ==========
  sections.push('=== TIER 1: CRITICAL SIGNALS ===');

  // Economic indicators (FRED)
  if (v2Data.fred?.length) {
    sections.push('--- ECONOMIC INDICATORS (FRED) ---');
    const keyIds = ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US', 'CPIAUCSL', 'UNRATE'];
    const key = v2Data.fred.filter(f => keyIds.includes(f.id));
    for (const f of key) {
      const change = f.momChange ? ` (change: ${f.momChange > 0 ? '+' : ''}${f.momChange})` : '';
      sections.push(`  ${f.id}: ${f.value}${change} [observed ${f.date || 'unknown'}]`);
    }
    // Yield curve status
    const t10y2y = v2Data.fred.find(f => f.id === 'T10Y2Y');
    if (t10y2y) {
      sections.push(`  Yield Curve: ${parseFloat(t10y2y.value) < 0 ? 'INVERTED' : 'NORMAL'} (${t10y2y.value})`);
    }
    sections.push('');
  }

  // Conflict (ACLED)
  if (v2Data.acled) {
    sections.push('--- CONFLICT (ACLED) ---');
    if (v2Data.acled.available === false) {
      sections.push(`  UNAVAILABLE/DEGRADED — status: ${v2Data.acled.status || 'unknown'}. Do not interpret zero values as zero conflict.`);
    } else {
      sections.push(`  Total events (7-day): ${v2Data.acled.totalEvents || 0}`);
      sections.push(`  Fatalities: ${v2Data.acled.totalFatalities || 0}`);
      if (v2Data.acled.deadliestEvents?.length) {
        sections.push('  Deadliest events:');
        for (const e of v2Data.acled.deadliestEvents.slice(0, 5)) {
          sections.push(`    - ${e.country}: ${e.type} — ${e.fatalities} killed [observed ${e.date || 'unknown'}]`);
        }
      }
    }
    sections.push('');
  }

  // Thermal / Fire detections
  if (v2Data.thermal?.length) {
    const hotRegions = v2Data.thermal.filter(t => t.det > 5);
    if (hotRegions.length) {
      sections.push('--- THERMAL DETECTIONS (NASA FIRMS) ---');
      sections.push('  IMPORTANT: Regional coverage boxes overlap (for example, Iran is inside Middle East). Do not sum regional counts or describe them as unique global detections. FIRMS detects thermal anomalies; it does not establish military cause.');
      for (const t of hotRegions) {
        sections.push(`  ${t.region}: ${t.det} detections (${t.hc} high-confidence)`);
      }
      sections.push('');
    }
  }

  // Nuclear — only fresh readings may be classified as current anomalies.
  if (v2Data.nuke?.length) {
    const anomalies = v2Data.nuke.filter(n => n.anom && !n.stale);
    if (anomalies.length) {
      sections.push('--- NUCLEAR ANOMALIES ---');
      for (const n of anomalies) {
        sections.push(`  ${n.site}: ${n.cpm} CPM (fresh anomaly; observed ${n.lastReading || 'unknown'})`);
      }
      sections.push('');
    }
    const stale = v2Data.nuke.filter(n => n.stale);
    if (stale.length) {
      sections.push('--- STALE RADIATION READINGS (EXCLUDED FROM CURRENT ANOMALIES) ---');
      for (const n of stale) {
        sections.push(`  ${n.site}: ${n.cpm ?? 'n/a'} CPM; last observed ${n.lastReading || 'unknown'} — do not treat as current`);
      }
      sections.push('');
    }
  }

  // Delta (changes since last sweep)
  if (deltaData?.summary) {
    sections.push('--- CHANGES SINCE LAST SWEEP ---');
    sections.push(`  Direction: ${deltaData.summary.direction?.toUpperCase() || 'UNKNOWN'}`);
    sections.push(`  Total changes: ${deltaData.summary.totalChanges}, Critical: ${deltaData.summary.criticalChanges}`);
    if (deltaData.signals?.escalated?.length) {
      sections.push('  Escalated:');
      for (const s of deltaData.signals.escalated) {
        sections.push(`    - ${s.label}: ${s.from} → ${s.to} (${(s.pctChange || 0) > 0 ? '+' : ''}${(s.pctChange || 0).toFixed(1)}%)`);
      }
    }
    if (deltaData.signals?.new?.length) {
      sections.push('  New signals:');
      for (const s of deltaData.signals.new) {
        sections.push(`    - ${s.label || s.text?.substring(0, 100)}`);
      }
    }
    sections.push('');
  }

  // ========== TIER 2: IMPORTANT SIGNALS ==========
  sections.push('=== TIER 2: IMPORTANT SIGNALS ===');

  // Energy
  if (v2Data.energy) {
    sections.push('--- ENERGY ---');
    sections.push(`  WTI Crude: $${v2Data.energy.wti || '--'}`);
    sections.push(`  Brent Crude: $${v2Data.energy.brent || '--'}`);
    sections.push(`  Natural Gas: $${v2Data.energy.natgas || '--'}`);
    if (v2Data.energy.crudeStocks) sections.push(`  Crude Stocks: ${v2Data.energy.crudeStocks} bbl`);
    sections.push('');
  }

  // Markets (Yahoo Finance)
  const marketRows = v2Data.markets && !Array.isArray(v2Data.markets)
    ? [...(v2Data.markets.indexes || []), ...(v2Data.markets.rates || []), ...(v2Data.markets.commodities || []), ...(v2Data.markets.crypto || [])]
    : (v2Data.markets || []);
  if (marketRows.length) {
    sections.push('--- MARKETS ---');
    for (const m of marketRows.slice(0, 15)) {
      const change = m.changePct ? ` (${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(2)}%)` : '';
      sections.push(`  ${m.symbol}: $${m.price}${change}`);
    }
    sections.push('');
  }

  // OSINT / Telegram
  if (v2Data.tg) {
    sections.push('--- OSINT SIGNALS (TELEGRAM) ---');
    sections.push(`  Total posts: ${v2Data.tg.posts || 0}, Urgent: ${v2Data.tg.urgent?.length || 0}`);
    if (v2Data.tg.urgent?.length) {
      sections.push('  Top urgent signals:');
      for (const p of v2Data.tg.urgent.slice(0, 8)) {
        sections.push(`    - [UNTRUSTED EXTERNAL TEXT] ${(p.text || '').substring(0, 200)} [END EXTERNAL TEXT] [observed ${p.date || 'unknown'}]`);
      }
    }
    sections.push('');
  }

  // Air Activity
  if (v2Data.air?.length) {
    sections.push('--- AIR ACTIVITY ---');
    for (const a of v2Data.air) {
      const mil = a.mil ? `, military: ${a.mil}` : '';
      sections.push(`  ${a.region}: ${a.total} aircraft${mil}`);
    }
    sections.push('');
  }

  // ========== TIER 3: SUPPLEMENTARY ==========
  sections.push('=== TIER 3: SUPPLEMENTARY ===');

  // WHO Health — only if alerts present
  if (v2Data.who?.length) {
    sections.push('--- HEALTH ALERTS (WHO) ---');
    for (const w of v2Data.who.slice(0, 5)) {
      sections.push(`  - ${w.title}`);
    }
    sections.push('');
  }

  // Defense contracts — top 3 (reduced from 5)
  if (v2Data.defense?.length) {
    sections.push('--- DEFENSE CONTRACTS ---');
    for (const d of v2Data.defense.slice(0, 3)) {
      sections.push(`  - $${((d.amount || 0) / 1e6).toFixed(0)}M to ${d.recipient}: ${(d.desc || d.description || '').substring(0, 100)}`);
    }
    sections.push('');
  }

  // Space
  if (v2Data.space) {
    sections.push('--- SPACE ---');
    if (v2Data.space.recentLaunches?.length) sections.push(`  Recent launches: ${v2Data.space.recentLaunches.slice(0, 5).map(item => item.name).join(', ')}`);
    if (v2Data.space.militarySats) sections.push(`  Military satellites tracked: ${v2Data.space.militarySats}`);
    sections.push('');
  }

  // News feed — top 7 (reduced from 10)
  if (v2Data.news?.length) {
    sections.push('--- TOP NEWS ---');
    for (const n of v2Data.news.slice(0, 7)) {
      sections.push(`  - [${n.source || 'unknown'}] ${n.title}`);
    }
    sections.push('');
  }

  // Trade ideas
  if (v2Data.ideas?.length) {
    sections.push('--- CURRENT TRADE IDEAS ---');
    for (const idea of v2Data.ideas) {
      sections.push(`  ${idea.type}: ${idea.title} (${idea.ticker || 'N/A'}) — confidence: ${idea.confidence}`);
      if (idea.rationale) sections.push(`    Rationale: ${idea.rationale}`);
    }
    sections.push('');
  }

  // Labor (BLS)
  if (v2Data.bls?.length) {
    sections.push('--- LABOR MARKET (BLS) ---');
    for (const b of v2Data.bls) {
      sections.push(`  ${b.id}: ${b.value}`);
    }
    sections.push('');
  }

  // Treasury
  if (v2Data.treasury) {
    sections.push(`--- TREASURY ---`);
    sections.push(`  Total National Debt: $${v2Data.treasury.totalDebt ?? 'unknown'}`);
    sections.push('');
  }

  // Supply Chain
  if (v2Data.gscpi) {
    sections.push(`--- SUPPLY CHAIN ---`);
    sections.push(`  GSCPI: ${v2Data.gscpi.value} (${v2Data.gscpi.interpretation})`);
    sections.push('');
  }

  return sections.join('\n');
}
