// tripleseat.js — Saddleback SRG Tripleseat API proxy
// STATUS FIELD: lives on Events (event.status = TENTATIVE/DEFINITE/CLOSED/PROSPECT/LOST)
// CORRECT ENDPOINTS:
//   Bookings: GET /v1/bookings.json        (container — links to account/contact)
//   Events:   GET /v1/events.json          (has status field — TENTATIVE/DEFINITE/etc)
//   Accounts: GET /v1/accounts.json
//   Contacts: GET /v1/contacts.json
//   Leads:    GET /v1/leads.json           (pre-conversion inquiries)

const https = require('https');

const CONSUMER_KEY    = 'JrpAFIveyQLLQE3dyQmMPlGdiJN6RiKdLf8FX8JQ';
const CONSUMER_SECRET = 'CuEe00aoUotCJqNk2KZmhgNEEg34A760xi123Tf5';
const TS_HOST         = 'api.tripleseat.com';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let cachedToken = null, tokenExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const payload = JSON.stringify({
    client_id: CONSUMER_KEY,
    client_secret: CONSUMER_SECRET,
    grant_type: 'client_credentials',
  });
  const res = await httpsReq({
    hostname: TS_HOST, path: '/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Accept': 'application/json' },
  }, payload);
  if (res.status !== 200) throw new Error(`Token failed ${res.status}: ${res.body.slice(0, 200)}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function tsGet(path, token) {
  const res = await httpsReq({
    hostname: TS_HOST, path, method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (res.status === 401) { cachedToken = null; throw new Error('Token expired'); }
  return res;
}

// ── Endpoint config ───────────────────────────────────────────────────────────
// NOTE: Status (TENTATIVE/DEFINITE/CLOSED/PROSPECT/LOST) lives on EVENTS not bookings
const ENDPOINTS = {
  leads:     { path: '/v1/leads.json',     wrap: 'lead' },
  bookings:  { path: '/v1/bookings.json',  wrap: 'booking' },   // container — no status
  events:    { path: '/v1/events.json',    wrap: 'event' },     // HAS status field
  accounts:  { path: '/v1/accounts.json',  wrap: 'account' },
  contacts:  { path: '/v1/contacts.json',  wrap: 'contact' },
  locations: { path: '/v1/locations.json', wrap: 'location' },
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params   = event.queryStringParameters || {};
  const endpoint = params.endpoint || 'leads';
  const page     = parseInt(params.page  || '1');
  const limit    = parseInt(params.limit || '100');

  if (!ENDPOINTS[endpoint]) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown endpoint: ' + endpoint, results: [], total_pages: 0 }) };
  }

  try {
    const token = await getToken();
    const cfg   = ENDPOINTS[endpoint];

    // Build query string
    let qs = `page=${page}&limit=${limit}`;
    if (endpoint === 'events') {
      // Sort events by updated_at desc to get most recently changed first
      qs += '&sort_direction=desc&order=updated_at';
    }

    const fullPath = `${cfg.path}?${qs}`;
    const res = await tsGet(fullPath, token);

    if (res.status !== 200) {
      console.error(`TS ${endpoint} HTTP ${res.status}:`, res.body.slice(0, 300));
      return {
        statusCode: res.status, headers: CORS,
        body: JSON.stringify({
          error: `Tripleseat ${endpoint} returned ${res.status}`,
          detail: res.body.slice(0, 300),
          results: [], total_pages: 0, total_count: 0,
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(res.body);
    } catch(e) {
      throw new Error(`JSON parse failed for ${endpoint}: ${res.body.slice(0, 100)}`);
    }

    // Tripleseat returns arrays of wrapped objects: [{lead: {...}}, ...]
    // Or sometimes a direct array of objects, or nested under endpoint key
    let items = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (Array.isArray(data.results)) {
      items = data.results;
    } else if (Array.isArray(data[endpoint])) {
      items = data[endpoint];
    } else {
      // Try common patterns
      const keys = Object.keys(data);
      for (const k of keys) {
        if (Array.isArray(data[k]) && data[k].length > 0) { items = data[k]; break; }
      }
    }

    // Unwrap: [{event: {...}}] → [{...}]
    // But only unwrap if the wrap key exists — don't unwrap already-flat objects
    items = items.map(item => {
      if (item && typeof item === 'object' && cfg.wrap && item[cfg.wrap]) {
        return item[cfg.wrap];
      }
      return item;
    });

    // For events: log a sample status to confirm field exists
    if (endpoint === 'events' && items.length > 0) {
      const sample = items[0];
      console.log(`[events] sample status fields:`, {
        status: sample.status,
        booking_status: sample.booking_status,
        event_status: sample.event_status,
        id: sample.id,
      });
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        results:     items,
        total_pages: data.total_pages || 1,
        total_count: data.total_count || items.length,
        endpoint,
        page,
      }),
    };

  } catch (err) {
    console.error(`[tripleseat] ${endpoint} error:`, err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message, results: [], total_pages: 0, total_count: 0 }),
    };
  }
};
