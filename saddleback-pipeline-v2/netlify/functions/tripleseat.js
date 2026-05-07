// tripleseat.js — Fetches from ALL relevant Tripleseat endpoints
// Endpoints: leads, bookings, events, accounts, contacts
// Uses OAuth 2.0 client_credentials (Consumer Key + Secret → Bearer token)

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

// ── HTTPS helper ──────────────────────────────────────────────────────────────
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

// ── Get OAuth 2.0 bearer token ────────────────────────────────────────────────
let cachedToken = null, tokenExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const payload = JSON.stringify({ client_id: CONSUMER_KEY, client_secret: CONSUMER_SECRET, grant_type: 'client_credentials' });
  const res = await httpsReq({
    hostname: TS_HOST, path: '/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Accept': 'application/json' }
  }, payload);
  if (res.status !== 200) throw new Error(`Token failed ${res.status}: ${res.body.slice(0,200)}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 50 * 60 * 1000; // 50min
  return cachedToken;
}

// ── Tripleseat GET ────────────────────────────────────────────────────────────
async function tsGet(path, token) {
  const res = await httpsReq({
    hostname: TS_HOST, path, method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  if (res.status === 401) { cachedToken = null; throw new Error('Token expired — retry'); }
  return { status: res.status, body: res.body };
}

// ── Valid endpoints and their response key ────────────────────────────────────
const ENDPOINTS = {
  leads:     { path: '/v1/leads.json',              key: 'results' },
  bookings:  { path: '/v1/bookings/search.json',    key: 'results' },
  events:    { path: '/v1/events/search.json',      key: 'results' },
  accounts:  { path: '/v1/accounts.json',           key: 'results' },
  contacts:  { path: '/v1/contacts.json',           key: 'results' },
  locations: { path: '/v1/locations.json',          key: 'locations' },
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params   = event.queryStringParameters || {};
  const endpoint = params.endpoint || 'leads';
  const page     = params.page    || '1';
  const limit    = params.limit   || '100';

  if (!ENDPOINTS[endpoint]) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown endpoint: ' + endpoint }) };
  }

  try {
    const token = await getToken();
    const cfg   = ENDPOINTS[endpoint];

    // Build query string — different endpoints have different param names
    let qs = `page=${page}&limit=${limit}`;
    if (endpoint === 'bookings' || endpoint === 'events') {
      qs += '&sort_direction=desc&order=updated_at';
    }

    const path = `${cfg.path}?${qs}`;
    const res  = await tsGet(path, token);

    if (res.status !== 200) {
      console.error(`TS ${endpoint} ${res.status}:`, res.body.slice(0, 300));
      return {
        statusCode: res.status, headers: CORS,
        body: JSON.stringify({ error: `Tripleseat ${res.status}`, detail: res.body.slice(0, 300), results: [], total_pages: 0 })
      };
    }

    const data = JSON.parse(res.body);

    // Normalize response — Tripleseat sometimes wraps items in their own key
    // e.g. { leads: [{lead: {...}}, ...] } or { results: [...] }
    let items = data[cfg.key] || data[endpoint] || data.results || data || [];

    // Unwrap nested objects: [{lead: {...}}] → [{...}]
    items = items.map(item => {
      const singular = endpoint.replace(/s$/, ''); // leads→lead, bookings→booking
      return item[singular] || item;
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        results:     items,
        total_pages: data.total_pages || 1,
        total_count: data.total_count || items.length,
        endpoint,
        page: parseInt(page),
      })
    };

  } catch (err) {
    console.error('Tripleseat function error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, results: [], total_pages: 0 }) };
  }
};
