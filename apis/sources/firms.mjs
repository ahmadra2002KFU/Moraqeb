// NASA FIRMS — Fire Information for Resource Management System
// Detects active fires/thermal anomalies globally within 3 hours of satellite pass.
// Detects active fires and thermal anomalies; cause requires independent corroboration.

import '../utils/env.mjs';

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_PRODUCT = 'VIIRS_SNPP_NRT';

// Parse FIRMS CSV response into structured data
function parseCSV(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = rawText.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim(); });
    return obj;
  });
}

// Fetch fires in a bounding box
async function fetchFires(opts = {}) {
  const {
    west = -180, south = -90, east = 180, north = 90,
    days = 1,
    source = FIRMS_PRODUCT,
  } = opts;

  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return { error: 'No FIRMS_MAP_KEY' };

  const url = `${FIRMS_BASE}/${key}/${source}/${west},${south},${east},${north}/${days}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Crucix/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    return parseCSV(text);
  } catch (e) {
    clearTimeout(timer);
    return { error: e.message };
  }
}

// Key conflict/hotspot zones
const HOTSPOTS = {
  middleEast: { west: 30, south: 12, east: 65, north: 42, label: 'Middle East' },
  ukraine: { west: 22, south: 44, east: 41, north: 53, label: 'Ukraine' },
  iran: { west: 44, south: 25, east: 63, north: 40, label: 'Iran' },
  sudanHorn: { west: 21, south: 2, east: 52, north: 23, label: 'Sudan / Horn of Africa' },
  myanmar: { west: 92, south: 9, east: 102, north: 29, label: 'Myanmar' },
  southAsia: { west: 60, south: 5, east: 98, north: 37, label: 'South Asia' },
};

export function latestFirmsObservationTime(fires = []) {
  let latest = null;
  for (const fire of fires) {
    const date = String(fire?.acq_date || '');
    const time = String(fire?.acq_time || '').padStart(4, '0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(time)) continue;
    const observed = new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    if (!Number.isNaN(observed.getTime()) && (!latest || observed > latest)) latest = observed;
  }
  return latest ? latest.toISOString() : null;
}

function firmsDetectionKey(fire = {}, product = FIRMS_PRODUCT) {
  const rawLatitude = String(fire.latitude ?? '').trim();
  const rawLongitude = String(fire.longitude ?? '').trim();
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  const date = String(fire.acq_date || '');
  const time = String(fire.acq_time || '').padStart(4, '0');
  if (!rawLatitude || !rawLongitude || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(time)) return null;
  return [
    product, fire.satellite || '', fire.instrument || '', date, time,
    latitude.toFixed(5), longitude.toFixed(5),
  ].join('|');
}

/** Deduplicate identical satellite observations fetched through overlapping boxes. */
export function deduplicateFirmsDetections(regionalResults = []) {
  const unique = new Map();
  let memberships = 0;
  let invalidDetections = 0;
  for (const result of regionalResults) {
    if (!Array.isArray(result.fires)) continue;
    for (const fire of result.fires) {
      memberships += 1;
      const product = result.product || FIRMS_PRODUCT;
      const key = firmsDetectionKey(fire, product);
      if (!key) { invalidDetections += 1; continue; }
      if (!unique.has(key)) unique.set(key, { ...fire, observationId: key, product, duplicateCopies: 0, regions: new Set() });
      else unique.get(key).duplicateCopies += 1;
      unique.get(key).regions.add(result.label);
    }
  }
  const detections = [...unique.values()].map(item => ({ ...item, regions: [...item.regions].sort() }));
  return {
    totalDetections: detections.length,
    observationIds: detections.map(item => item.observationId).sort(),
    highConfidenceObservationIds: detections.filter(item => item.confidence === 'h' || item.confidence === 'high').map(item => item.observationId).sort(),
    duplicateMemberships: Math.max(0, memberships - invalidDetections - detections.length),
    invalidDetections,
    highConfidence: detections.filter(item => item.confidence === 'h' || item.confidence === 'high').length,
    nightDetections: detections.filter(item => item.daynight === 'N').length,
    highIntensity: detections.filter(item => Number(item.frp) > 10).length,
    observedAt: latestFirmsObservationTime(detections),
    method: 'product+satellite+instrument+acquisition-time+coordinate-5dp',
    regionsOverlap: true,
    detections,
  };
}

export function filterFirmsObservationWindow(fires = [], collectedAt = new Date().toISOString()) {
  const reference = Date.parse(collectedAt);
  if (!Number.isFinite(reference)) return [];
  const lower = reference - (24 * 60 * 60 * 1000);
  const upper = reference + (5 * 60 * 1000);
  return fires.filter(fire => {
    const observed = Date.parse(latestFirmsObservationTime([fire]) || '');
    return Number.isFinite(observed) && observed > lower && observed <= upper;
  });
}

// Analyze thermal detections without assigning cause
function analyzeFires(fires, regionLabel) {
  if (!Array.isArray(fires) || fires.length === 0) {
    return { region: regionLabel, totalDetections: 0, highConfidence: 0, highIntensity: [], summary: 'No detections' };
  }

  const highConf = fires.filter(f => f.confidence === 'h' || f.confidence === 'high');
  const nomConf = fires.filter(f => f.confidence === 'n' || f.confidence === 'nominal');

  // High-intensity thermal detections (FRP > 10 MW); cause is not established.
  const highIntensity = fires
    .filter(f => parseFloat(f.frp) > 10)
    .map(f => ({
      lat: parseFloat(f.latitude),
      lon: parseFloat(f.longitude),
      brightness: parseFloat(f.bright_ti4),
      frp: parseFloat(f.frp),
      date: f.acq_date,
      time: f.acq_time,
      confidence: f.confidence,
      daynight: f.daynight,
    }))
    .sort((a, b) => b.frp - a.frp)
    .slice(0, 15);

  // Night detections are an observation characteristic, not a cause indicator.
  const nightFires = fires.filter(f => f.daynight === 'N');

  return {
    region: regionLabel,
    observedAt: latestFirmsObservationTime(fires),
    totalDetections: fires.length,
    highConfidence: highConf.length,
    nominalConfidence: nomConf.length,
    nightDetections: nightFires.length,
    highIntensity,
    avgFRP: fires.reduce((sum, f) => sum + (parseFloat(f.frp) || 0), 0) / fires.length,
  };
}

// Briefing
export async function briefing() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    return {
      source: 'NASA FIRMS',
      timestamp: new Date().toISOString(),
      status: 'no_key',
      message: 'Set FIRMS_MAP_KEY for satellite thermal-anomaly detection. Free at https://firms.modaps.eosdis.nasa.gov/api/area/',
    };
  }

  // Fetch two calendar days to cover the API boundary, then deterministically
  // restrict analytical metrics to the latest rolling 24-hour window.
  const entries = Object.entries(HOTSPOTS);
  const collectedAt = new Date().toISOString();
  const rawResults = await Promise.all(
    entries.map(async ([key, box]) => {
      const fires = await fetchFires({ ...box, days: 2, source: FIRMS_PRODUCT });
      return { key, label: box.label, product: FIRMS_PRODUCT, fires };
    })
  );
  const failedRegions = rawResults
    .filter(result => result.fires?.error)
    .map(result => ({ key: result.key, region: result.label }));
  const windowedResults = rawResults.map(result => ({
    ...result,
    fires: Array.isArray(result.fires)
      ? filterFirmsObservationWindow(result.fires, collectedAt)
      : result.fires,
  }));
  const hotspots = windowedResults.map(result => {
    if (result.fires?.error) return { region: result.label, error: result.fires.error };
    return analyzeFires(result.fires, result.label);
  });
  const deduplicatedRaw = deduplicateFirmsDetections(windowedResults);
  const { detections: _detections, ...deduplicatedMetrics } = deduplicatedRaw;
  const completeCoverage = failedRegions.length === 0;
  const deduplicated = {
    ...deduplicatedMetrics,
    ...(completeCoverage ? {} : {
      partialDetections: deduplicatedMetrics.totalDetections,
      totalDetections: null,
    }),
    product: FIRMS_PRODUCT,
    windowHours: 24,
    coverage: {
      complete: completeCoverage,
      queriedRegions: entries.length,
      failedRegions,
    },
  };

  // Generate signals
  const signals = [];
  for (const h of hotspots) {
    if (h.highIntensity?.length > 5) {
      signals.push(`HIGH-INTENSITY THERMAL ANOMALIES in ${h.region}: ${h.highIntensity.length} displayed above 10MW FRP; cause unverified`);
    }
    if (h.nightDetections > 20) {
      signals.push(`ELEVATED NIGHT THERMAL ACTIVITY in ${h.region}: ${h.nightDetections} detections; cause unverified`);
    }
  }

  return {
    source: 'NASA FIRMS',
    timestamp: collectedAt,
    status: completeCoverage ? 'active' : failedRegions.length === entries.length ? 'unavailable' : 'partial',
    hotspots,
    deduplicated,
    signals,
  };
}

if (process.argv[1]?.endsWith('firms.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
