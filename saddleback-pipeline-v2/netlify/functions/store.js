// store.js — Netlify KV / Blobs persistence
// Uses @netlify/blobs which is available as a built-in in Netlify's Node 18+ runtime
// If blobs fail, gracefully returns empty data with a clear error

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

const CHUNK_SIZE = 300; // contacts per blob chunk — smaller = more reliable

async function getStore() {
  // Netlify Blobs is available natively in Netlify functions
  // It requires NETLIFY_BLOBS_CONTEXT env var which Netlify injects automatically
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'saddleback-crm', consistency: 'strong' });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = (event.queryStringParameters || {}).action;

  let store;
  try {
    store = await getStore();
  } catch (importErr) {
    // Netlify Blobs not available in this environment
    console.error('Blobs import error:', importErr.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        blobsAvailable: false,
        error: 'Netlify Blobs not available: ' + importErr.message,
        contacts: [], queue: [], metadata: { totalContacts: 0, totalChunks: 0, lastSync: null }
      })
    };
  }

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {

      if (action === 'debug') {
        // Debug endpoint — shows storage status
        let meta = null, blobsList = null;
        try { meta = await store.get('metadata', { type: 'json' }); } catch(e) {}
        try { const l = await store.list(); blobsList = l.blobs?.map(b=>b.key) || []; } catch(e) {}
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            blobsAvailable: true,
            metadata: meta || 'not found',
            blobKeys: blobsList || 'could not list',
            environment: {
              hasContext: !!process.env.NETLIFY_BLOBS_CONTEXT,
              siteId: process.env.SITE_ID || 'not set',
              nodeVersion: process.version,
            }
          })
        };
      }

      if (action === 'get-metadata') {
        let meta = null;
        try { meta = await store.get('metadata', { type: 'json' }); } catch(e) {}
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify(meta || { totalContacts: 0, totalChunks: 0, lastSync: null, blobsAvailable: true })
        };
      }

      if (action === 'get-contacts') {
        let meta = null;
        try { meta = await store.get('metadata', { type: 'json' }); } catch(e) {}

        if (!meta || !meta.totalChunks || meta.totalChunks === 0) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: [], lastSync: null, totalContacts: 0 }) };
        }

        // Load all chunks in parallel
        const chunkPromises = Array.from({ length: meta.totalChunks }, (_, i) =>
          store.get(`contacts-chunk-${i}`, { type: 'json' }).catch(() => [])
        );
        const chunks = await Promise.all(chunkPromises);
        const contacts = chunks.flat().filter(Boolean);

        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ contacts, lastSync: meta.lastSync, totalContacts: contacts.length })
        };
      }

      if (action === 'get-queue') {
        let data = null;
        try { data = await store.get('email-queue', { type: 'json' }); } catch(e) {}
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { queue: [] }) };
      }

      if (action === 'get-contacted') {
        let data = null;
        try { data = await store.get('contacted-history', { type: 'json' }); } catch(e) {}
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || {}) };
      }

      if (action === 'get-suppressed') {
        let data = null;
        try { data = await store.get('suppressed', { type: 'json' }); } catch(e) {}
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data || { list: [] }) };
      }
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (action === 'save-contacts') {
        const contacts = body.contacts || [];
        const totalChunks = Math.ceil(contacts.length / CHUNK_SIZE) || 1;

        // Save in batches of 5 concurrent writes
        for (let batch = 0; batch < totalChunks; batch += 5) {
          const writes = [];
          for (let i = batch; i < Math.min(batch + 5, totalChunks); i++) {
            const chunk = contacts.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            writes.push(store.set(`contacts-chunk-${i}`, JSON.stringify(chunk)));
          }
          await Promise.all(writes);
        }

        const metadata = {
          lastSync: new Date().toISOString(),
          totalContacts: contacts.length,
          totalChunks,
          version: 3,
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

      if (action === 'save-suppressed') {
        await store.set('suppressed', JSON.stringify({ list: body.list || [], updatedAt: new Date().toISOString() }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('Store handler error:', err);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | ') })
    };
  }
};
