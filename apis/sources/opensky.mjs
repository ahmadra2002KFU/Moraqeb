// OpenSky Network — Real-time flight tracking
// Free for research. 4,000 API credits/day (no auth), 8,000 with account.
// Tracks all aircraft with ADS-B transponders including many military.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://opensky-network.org/api';

// Get all current flights (global state vector)
export async function getAllFlights() {
  return safeFetch(`${BASE}/states/all`, { timeout: 30000 });
}

// Get flights in a bounding box (lat/lon)
export async function getFlightsInArea(lamin, lomin, lamax, lomax) {
  const params = new URLSearchParams({
    lamin: String(lamin),
    lomin: String(lomin),
    lamax: String(lamax),
    lomax: String(lomax),
  });
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000 });
}

// Get flights by specific aircraft (ICAO24 hex codes)
export async function getFlightsByIcao(icao24List) {
  const icao = Array.isArray(icao24List) ? icao24List : [icao24List];
  const params = icao.map(i => `icao24=${i}`).join('&');
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000 });
}

// Get departures from an airport in a time range
export async function getDepartures(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/departure?${params}`);
}

// Get arrivals at an airport
export async function getArrivals(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/arrival?${params}`);
}

// Key hotspot regions for monitoring
const HOTSPOTS = {
  middleEast: { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  taiwan: { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  ukraine: { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine Region' },
  baltics: { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea: { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula: { lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  caribbean: { lamin: 18, lomin: -90, lamax: 30, lomax: -72, label: 'Caribbean' },
  gulfOfGuinea: { lamin: -2, lomin: -5, lamax: 8, lomax: 10, label: 'Gulf of Guinea' },
  capeRoute: { lamin: -38, lomin: 12, lamax: -28, lomax: 24, label: 'Cape Route' },
  hornOfAfrica: { lamin: 5, lomin: 40, lamax: 15, lomax: 55, label: 'Horn of Africa' },
};

function stateInBox(state, box) {
  const longitude = Number(state?.[5]);
  const latitude = Number(state?.[6]);
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && latitude >= box.lamin && latitude <= box.lamax
    && longitude >= box.lomin && longitude <= box.lomax;
}

export function regionalizeStates(states = []) {
  return Object.entries(HOTSPOTS).map(([key, box]) => {
    const regional = states.filter(state => stateInBox(state, box));
    return {
      region: box.label,
      key,
      totalAircraft: regional.length,
      byCountry: regional.reduce((acc, state) => {
        const country = state[2] || 'Unknown';
        acc[country] = (acc[country] || 0) + 1;
        return acc;
      }, {}),
      noCallsign: regional.filter(state => !state[1]?.trim()).length,
      highAltitude: regional.filter(state => Number(state[7]) > 12000).length,
    };
  });
}

// Briefing — check hotspot regions for flight activity
export async function briefing() {
  // One global state-vector request avoids exhausting anonymous credits with a
  // burst of overlapping regional requests. Regionalization is deterministic.
  const response = await getAllFlights();
  if (response?.error || !Array.isArray(response?.states)) {
    return {
      source: 'OpenSky',
      timestamp: new Date().toISOString(),
      status: 'unavailable',
      error: response?.error || 'OpenSky state vectors unavailable',
      hotspots: [],
    };
  }
  const results = regionalizeStates(response.states);
  const observedAt = Number.isFinite(Number(response.time))
    ? new Date(Number(response.time) * 1000).toISOString()
    : null;
  return {
    source: 'OpenSky',
    timestamp: new Date().toISOString(),
    observedAt,
    status: 'active',
    requestCount: 1,
    hotspots: results,
  };
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
