// store.js — Netlify Blobs backend storage
// No external dependencies needed — @netlify/blobs is built into Netlify's runtime
// Stores contacts in chunks of 500 to avoid payload size limits

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

const CHUNK_SIZE = 500; // contacts per chunk

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = (event.queryStringParameters || {}).action;

  // Dynamically require blobs — available in all Netlify function runtimes
  let blobs;
  try {
    blobs = require('@netlify/blobs');
  } catch (e) {
    // Fallback: return empty data if blobs not available
    console.error('Netlify Blobs not available:', e.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Netlify Blobs not available — contacts stored locally only', contacts: [], queue: [], metadata: {} })
    };
  }

  const store = blobs.getStore({ name: 'saddleback-crm' });

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {

      if (action === 'get-metadata') {
        const meta = await store.get('metadata', { type: 'json' }).catch(() => null);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(meta || { lastSync: null, totalContacts: 0, totalChunks: 0 }) };
      }

      if (action === 'get-contacts') {
        const meta = await store.get('metadata', { type: 'json' }).catch(() => null);
        if (!meta || !meta.totalChunks) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: [], lastSync: null, totalContacts: 0 }) };
        }
        // Load all chunks in parallel
        const chunkPromises = Array.from({ length: meta.totalChunks }, (_, i) =>
          store.get(`contacts-chunk-${i}`, { type: 'json' }).catch(() => [])
        );
        const chunks = await Promise.all(chunkPromises);
        const contacts = chunks.flat().filter(Boolean);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts, lastSync: meta.lastSync, totalContacts: contacts.length }) };
      }

      if (action === 'get-queue') {
        const data = await store.get('email-queue', { type: 'json' }).catch(() => null);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { queue: [] }) };
      }

      if (action === 'get-contacted') {
        const data = await store.get('contacted-history', { type: 'json' }).catch(() => null);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || {}) };
      }
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (action === 'save-contacts') {
        const contacts = body.contacts || [];
        const totalChunks = Math.ceil(contacts.length / CHUNK_SIZE);

        // Save chunks in parallel batches of 10
        for (let batch = 0; batch < totalChunks; batch += 10) {
          const batchChunks = Array.from({ length: Math.min(10, totalChunks - batch) }, (_, i) => {
            const chunkIdx = batch + i;
            const chunk = contacts.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);
            return store.set(`contacts-chunk-${chunkIdx}`, JSON.stringify(chunk));
          });
          await Promise.all(batchChunks);
        }

        // Save metadata
        const metadata = {
          lastSync: new Date().toISOString(),
          totalContacts: contacts.length,
          totalChunks,
          version: 2,
        };
        await store.set('metadata', JSON.stringify(metadata));

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: contacts.length, chunks: totalChunks }) };
      }

      if (action === 'save-queue') {
        await store.set('email-queue', JSON.stringify({ queue: body.queue || [], updatedAt: new Date().toISOString() }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'save-contacted') {
        await store.set('contacted-history', JSON.stringify(body));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
      if (action === 'clear-contacts') {
        const meta = await store.get('metadata', { type: 'json' }).catch(() => null);
        if (meta && meta.totalChunks) {
          const deletes = Array.from({ length: meta.totalChunks }, (_, i) => store.delete(`contacts-chunk-${i}`).catch(() => {}));
          await Promise.all(deletes);
        }
        await store.delete('metadata').catch(() => {});
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('Store error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
