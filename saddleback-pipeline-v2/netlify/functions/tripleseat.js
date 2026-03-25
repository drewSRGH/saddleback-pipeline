const crypto = require('crypto');
const https  = require('https');
const url    = require('url');

// ── Tripleseat OAuth 1.0 credentials ─────────────────────────────────────────
const CONSUMER_KEY    = 'JrpAFIveyQLLQE3dyQmMPlGdiJN6RiKdLf8FX8JQ';
const CONSUMER_SECRET = 'CuEe00aoUotCJqNk2KZmhgNEEg34A760xi123Tf5';
const TS_BASE         = 'https://api.tripleseat.com/v1';

// ── CORS headers ──────────────────────────────────────────────────────────────
const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── OAuth 1.0 signature generator ────────────────────────────────────────────
function buildOAuthHeader(method, baseUrl, params = {}) {
  const oauthParams = {
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_version:          '1.0',
  };

  // Merge all params for signature
  const allParams = { ...params, ...oauthParams };

  // Sort and encode params
  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  // Build signature base string
  const sigBase = [
    method.toUpperCase(),
    encodeURIComponent(baseUrl),
    encodeURIComponent(sortedParams),
  ].join('&');

  // Sign with HMAC-SHA1
  const signingKey = `${encodeURIComponent(CONSUMER_SECRET)}&`;
  const signature  = crypto
    .createHmac('sha1', signingKey)
    .update(sigBase)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  // Build Authorization header
  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return headerValue;
}

// ── Simple HTTPS GET ──────────────────────────────────────────────────────────
function httpsGet(fullUrl, authHeader) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(fullUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers: {
        'Authorization': authHeader,
        'Accept':        'application/json',
        'User-Agent':    'SaddlebackCateringPipeline/1.0',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Lambda handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const endpoint = event.queryStringParameters?.endpoint || 'events';
  const page     = event.queryStringParameters?.page     || '1';
  const limit    = event.queryStringParameters?.limit    || '50';

  const allowed = ['leads', 'events', 'bookings', 'contacts', 'locations', 'rooms'];
  if (!allowed.includes(endpoint)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid endpoint' }) };
  }

  // Build URL + query params
  const queryParams = { page, limit };
  const queryString = Object.keys(queryParams)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');
  const fullUrl  = `${TS_BASE}/${endpoint}.json?${queryString}`;
  const baseUrl  = `${TS_BASE}/${endpoint}.json`;

  try {
    const authHeader = buildOAuthHeader('GET', baseUrl, queryParams);
    const result     = await httpsGet(fullUrl, authHeader);

    if (result.status !== 200) {
      // Log the error body for debugging in Netlify function logs
      console.error(`Tripleseat ${endpoint} returned ${result.status}:`, result.body);
      return {
        statusCode: result.status,
        headers: HEADERS,
        body: JSON.stringify({ error: `Tripleseat error ${result.status}`, detail: result.body }),
      };
    }

    return { statusCode: 200, headers: HEADERS, body: result.body };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Proxy error', detail: err.message }),
    };
  }
};
