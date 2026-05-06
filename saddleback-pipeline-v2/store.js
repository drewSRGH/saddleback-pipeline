// Netlify function — persistent storage using Netlify Blobs
// Stores contacts, segments, queue items so they survive browser refreshes

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const store = getStore({ name: 'saddleback-crm', consistency: 'strong' });
  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    // GET actions
    if (event.httpMethod === 'GET') {
      if (action === 'get-contacts') {
        const data = await store.get('contacts', { type: 'json' });
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { contacts: [], lastSync: null }) };
      }
      if (action === 'get-queue') {
        const data = await store.get('email-queue', { type: 'json' });
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { queue: [] }) };
      }
      if (action === 'get-stats') {
        const data = await store.get('outreach-stats', { type: 'json' });
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { sent: 0, approved: 0, skipped: 0, lastUpdated: null }) };
      }
    }

    // POST actions
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (action === 'save-contacts') {
        await store.setJSON('contacts', {
          contacts: body.contacts || [],
          lastSync: new Date().toISOString(),
          totalPages: body.totalPages || 1,
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: (body.contacts || []).length }) };
      }

      if (action === 'save-queue') {
        await store.setJSON('email-queue', { queue: body.queue || [], updatedAt: new Date().toISOString() });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'save-stats') {
        await store.setJSON('outreach-stats', { ...body, lastUpdated: new Date().toISOString() });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('Store error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
