const https = require('https');
const CONSUMER_KEY    = 'JrpAFIveyQLLQE3dyQmMPlGdiJN6RiKdLf8FX8JQ';
const CONSUMER_SECRET = 'CuEe00aoUotCJqNk2KZmhgNEEg34A760xi123Tf5';
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function httpsRequest(options, body) {
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

async function getToken() {
  const payload = JSON.stringify({
    client_id:     CONSUMER_KEY,
    client_secret: CONSUMER_SECRET,
    grant_type:    'client_credentials',
  });
  const res = await httpsRequest({
    hostname: 'api.tripleseat.com',
    path:     '/oauth/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Accept':         'application/json',
    },
  }, payload);
  console.log('Token status:', res.status, '| body:', res.body.substring(0, 200));
  if (res.status !== 200) throw new Error(`Token failed ${res.status}: ${res.body}`);
  return JSON.parse(res.body).access_token;
}

async function tsGet(path, token) {
  const res = await httpsRequest({
    hostname: 'api.tripleseat.com',
    path,
    method:  'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  console.log(`GET ${path} → ${res.status}`);
  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const ep    = (event.queryStringParameters?.endpoint || 'leads');
  const limit = event.queryStringParameters?.limit || '100';

  try {
    const token = await getToken();

    // ── LEADS: fetch last 2 pages (most recent) ──────────────────────────────
    if (ep === 'leads') {
      const firstRes  = await tsGet(`/v1/leads.json?page=1&limit=${limit}`, token);
      const firstData = JSON.parse(firstRes.body);
      const totalPages = firstData.total_pages || 1;

      const pagesToFetch = [];
      if (totalPages > 1) pagesToFetch.push(totalPages - 1);
      pagesToFetch.push(totalPages);

      const allResults = [];
      for (const p of pagesToFetch) {
        const r = await tsGet(`/v1/leads.json?page=${p}&limit=${limit}`, token);
        const d = JSON.parse(r.body);
        allResults.push(...(d.results || []));
      }
      allResults.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ total_pages: totalPages, results: allResults }),
      };
    }

    // ── BOOKINGS: fetch ALL future prospect/tentative bookings ───────────────
    if (ep === 'bookings') {
      const today = new Date().toISOString().split('T')[0];

      // Page 1 to get total
      const firstRes  = await tsGet(`/v1/bookings.json?page=1&limit=${limit}`, token);
      const firstData = JSON.parse(firstRes.body);
      const totalPages = firstData.total_pages || 1;

      // Fetch last 4 pages to capture all upcoming/recent bookings
      const pagesToFetch = [];
      for (let p = Math.max(1, totalPages - 3); p <= totalPages; p++) {
        pagesToFetch.push(p);
      }

      const allResults = [];
      for (const p of pagesToFetch) {
        const r = await tsGet(`/v1/bookings.json?page=${p}&limit=${limit}`, token);
        const d = JSON.parse(r.body);
        allResults.push(...(d.results || []));
      }

      // Filter: future events, prospect or tentative status, not deleted
      const filtered = allResults.filter(b => {
        if (b.deleted_at) return false;
        if (!['PROSPECT', 'TENTATIVE'].includes(b.status)) return false;
        const startDate = b.start_date || '';
        return startDate >= today;
      });

      filtered.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ total_pages: totalPages, results: filtered }),
      };
    }

    // ── OTHER ENDPOINTS ──────────────────────────────────────────────────────
    const pathMap = {
      events:    `/v1/events/search.json?page=1&limit=${limit}&sort_direction=desc&order=updated_at`,
      contacts:  `/v1/contacts.json?page=1&limit=${limit}`,
      locations: `/v1/locations.json`,
    };
    const path = pathMap[ep];
    if (!path) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid endpoint' }) };
    const result = await tsGet(path, token);
    return { statusCode: 200, headers: CORS, body: result.body };

  } catch (err) {
    console.error('Error:', err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message, results: [] }),
    };
  }
};
