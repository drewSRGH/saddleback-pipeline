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

  const ep    = (event.queryStringParameters?.endpoint || 'events');
  const page  = event.queryStringParameters?.page  || '1';
  const limit = event.queryStringParameters?.limit || '100';

  try {
    const token = await getToken();

    // Use the correct search endpoints per Tripleseat docs
    const pathMap = {
      events:    `/v1/events/search.json?page=${page}&limit=${limit}&sort_direction=desc&order=updated_at`,
      leads:     `/v1/leads.json?page=${page}&limit=${limit}`,
      bookings:  `/v1/bookings/search.json?page=${page}&limit=${limit}`,
      contacts:  `/v1/contacts.json?page=${page}&limit=${limit}`,
      locations: `/v1/locations.json`,
    };

    const path = pathMap[ep];
    if (!path) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid endpoint' }) };

    const result = await tsGet(path, token);
    return { statusCode: 200, headers: CORS, body: result.body };

  } catch (err) {
    console.error('Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, events: [], leads: [] }),
    };
  }
};
