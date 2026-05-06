// Netlify function — simple in-memory store with no external dependencies
// Uses Netlify's built-in process.env for lightweight key-value storage
// For full persistence, upgrade to a database later

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Simple in-memory cache — persists for the lifetime of the Netlify function instance
// Not permanent across deploys, but avoids the @netlify/blobs dependency
let cache = { contacts: null, queue: null, lastSync: null };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = event.queryStringParameters?.action;

  try {
    if (event.httpMethod === 'GET') {
      if (action === 'get-contacts') {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify(cache.contacts || { contacts: [], lastSync: null })
        };
      }
      if (action === 'get-queue') {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify(cache.queue || { queue: [] })
        };
      }
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (action === 'save-contacts') {
        cache.contacts = { contacts: body.contacts || [], lastSync: new Date().toISOString() };
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: body.contacts?.length || 0 }) };
      }
      if (action === 'save-queue') {
        cache.queue = { queue: body.queue || [] };
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
