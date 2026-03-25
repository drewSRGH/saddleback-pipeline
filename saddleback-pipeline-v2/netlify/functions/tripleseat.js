// Netlify serverless function — proxies Tripleseat API calls
// API key lives here on the server, never exposed to the browser

const TS_API_KEY = '0bd78d00f51373127da99b90b1d35f8f58a69e2b';
const TS_BASE    = 'https://api.tripleseat.com/v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Which endpoint to call — passed as ?endpoint=leads or ?endpoint=events
  const endpoint = event.queryStringParameters?.endpoint || 'leads';
  const page     = event.queryStringParameters?.page || 1;
  const limit    = event.queryStringParameters?.limit || 50;

  const validEndpoints = ['leads', 'events', 'bookings', 'contacts'];
  if (!validEndpoints.includes(endpoint)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid endpoint' }) };
  }

  try {
    const url = `${TS_BASE}/${endpoint}.json?api_key=${TS_API_KEY}&page=${page}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `Tripleseat error: ${response.status}`, detail: text }),
      };
    }

    const data = await response.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Proxy error', detail: err.message }),
    };
  }
};
