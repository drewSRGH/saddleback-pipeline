// store.js — Supabase backend
// SUPABASE_URL and SUPABASE_KEY must be set in Netlify environment variables

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Supabase helpers ──────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('NOT_CONFIGURED');
  return { url, key };
}

async function sbFetch(url, key, path, opts = {}) {
  const res = await fetch(`${url}/rest/v1${path}`, {
    method: opts.method || 'GET',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || (opts.method === 'GET' ? 'count=none' : 'return=minimal'),
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${opts.method||'GET'} ${path}: ${res.status} ${text.slice(0,200)}`);
  }
  if (opts.method === 'GET' || !opts.method) return res.json();
  return { ok: true };
}

async function query(url, key, table, qs = '') {
  return sbFetch(url, key, `/${table}?${qs}`);
}

async function upsertRows(url, key, table, rows) {
  if (!rows || rows.length === 0) return;
  // Batch in groups of 150 to stay well under payload limits
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150);
    await sbFetch(url, key, `/${table}`, {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
  }
}

async function setMeta(url, key, pairs) {
  const rows = Object.entries(pairs).map(([k, v]) => ({ key: k, value: String(v || ''), updated_at: new Date().toISOString() }));
  await upsertRows(url, key, 'sync_metadata', rows);
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = (event.queryStringParameters || {}).action;

  // Always check config first
  let SB;
  try {
    SB = getSupabase();
  } catch (e) {
    // Not configured — return clear message for every action
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, configured: false,
        error: 'SUPABASE_URL and SUPABASE_KEY are not set. Add them in Netlify → Site Configuration → Environment Variables, then trigger a redeploy.',
        supabaseUrlPresent: !!process.env.SUPABASE_URL,
        supabaseKeyPresent: !!process.env.SUPABASE_KEY,
      })
    };
  }

  const { url, key } = SB;

  try {

    // ── GET ──────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {

      // ── DEBUG ──
      if (action === 'debug') {
        let metaRows = [], tableCounts = {};
        try { metaRows = await query(url, key, 'sync_metadata', 'select=key,value&order=key.asc'); } catch(e) { metaRows = [{key:'error', value:e.message}]; }
        try {
          const tables = ['ts_leads','ts_bookings','ts_accounts','ts_contacts','ts_events','outreach_contacts','email_queue'];
          const results = await Promise.all(tables.map(t =>
            sbFetch(url, key, `/${t}?select=count`, { headers: { 'Prefer': 'count=exact', 'Range': '0-0' } })
              .then(r => Array.isArray(r) ? r[0]?.count : 0)
              .catch(() => 'error')
          ));
          tables.forEach((t,i) => tableCounts[t] = results[i]);
        } catch(e) { tableCounts.error = e.message; }
        const meta = Object.fromEntries(metaRows.map(r=>[r.key,r.value]));
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            configured: true,
            supabaseConnected: true,
            supabaseUrl: url.replace(/^https:\/\//, '').split('.')[0] + '.supabase.co (redacted)',
            syncMetadata: meta,
            tableCounts,
            loadedFrom: 'supabase',
            readyToLoad: !!(meta.total_outreach && meta.total_outreach !== '0' && meta.last_full_sync),
          })
        };
      }

      // ── GET METADATA ── (called on every page load)
      if (action === 'get-metadata') {
        const rows = await query(url, key, 'sync_metadata', 'select=key,value');
        const meta = Object.fromEntries((rows||[]).map(r=>[r.key,r.value]));
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            configured: true,
            loadedFrom: 'supabase',
            ...meta,
          })
        };
      }

      // ── GET CONTACTS ── (the main page-load query)
      if (action === 'get-contacts') {
        const limit  = Math.min(parseInt(event.queryStringParameters?.limit  || '5000'), 10000);
        const offset = parseInt(event.queryStringParameters?.offset || '0');
        const rows = await query(url, key, 'outreach_contacts',
          `select=*&limit=${limit}&offset=${offset}&order=last_event_date.desc.nullslast`
        );
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ contacts: rows || [], count: rows?.length || 0, loadedFrom: 'supabase' })
        };
      }

      if (action === 'get-queue') {
        const rows = await query(url, key, 'email_queue', 'select=*&order=created_at.desc&limit=500');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ queue: rows || [] }) };
      }

      if (action === 'get-suppressed') {
        const rows = await query(url, key, 'suppression_list', 'select=email');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ list: (rows||[]).map(r=>r.email) }) };
      }

      if (action === 'get-sent-history') {
        const rows = await query(url, key, 'sent_history', 'select=*&order=sent_at.desc&limit=200');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ history: rows || [] }) };
      }
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // ── SAVE LEADS ──
      if (action === 'save-leads') {
        const items = (body.leads || []).map(l => ({
          id: l.id,
          first_name: l.first_name, last_name: l.last_name,
          email: (l.email_address || '').toLowerCase().trim() || null,
          phone: l.phone_number,
          company: l.company || null,
          event_date: l.event_date || null,
          event_description: l.event_description || null,
          event_style: l.event_style || null,
          guest_count: l.guest_count || null,
          location_name: l.location?.name || null,
          additional_information: l.additional_information || null,
          turned_down_at: l.turned_down_at || null,
          turned_down_reason: l.turned_down_reason || null,
          created_at: l.created_at, updated_at: l.updated_at,
          raw: l, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_leads', items);
        await setMeta(url, key, { last_leads_sync: new Date().toISOString(), total_leads: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      // ── SAVE BOOKINGS ──
      if (action === 'save-bookings') {
        const items = (body.bookings || []).map(b => ({
          id: b.id, name: b.name,
          account_id: b.account_id || null, contact_id: b.contact_id || null,
          location_name: b.location_name || b.location?.name || null,
          status: (b.status || '').toUpperCase() || null,
          start_date: b.start_date || null, end_date: b.end_date || null,
          guest_count: b.guest_count || null,
          total_amount: b.total_amount || null,
          description: b.description || b.name || null,
          created_at: b.created_at, updated_at: b.updated_at,
          raw: b, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_bookings', items);
        await setMeta(url, key, { last_bookings_sync: new Date().toISOString(), total_bookings: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      // ── SAVE ACCOUNTS ──
      if (action === 'save-accounts') {
        const items = (body.accounts || []).map(a => ({
          id: a.id, name: a.name || 'Unknown',
          description: a.description || null,
          email: (a.email_address || a.email || '').toLowerCase().trim() || null,
          phone: a.phone_number || a.phone || null,
          website: a.website || null,
          created_at: a.created_at, updated_at: a.updated_at,
          raw: a, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_accounts', items);
        await setMeta(url, key, { last_accounts_sync: new Date().toISOString(), total_accounts: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      // ── SAVE CONTACTS ──
      if (action === 'save-contacts') {
        const items = (body.contacts || []).map(c => ({
          id: c.id, account_id: c.account_id || null,
          first_name: c.first_name || null, last_name: c.last_name || null,
          email: (c.email_address || c.email || '').toLowerCase().trim() || null,
          phone: c.phone_number || c.phone || null,
          company: c.company || null,
          created_at: c.created_at, updated_at: c.updated_at,
          raw: c, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_contacts', items);
        await setMeta(url, key, { last_contacts_sync: new Date().toISOString(), total_contacts: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      // ── SAVE OUTREACH CONTACTS (deduped profiles) ──
      // This is the critical table. Saved last, sets total_outreach and last_full_sync.
      if (action === 'save-outreach-contacts') {
        const items = body.contacts || [];
        if (items.length === 0) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: 0, warning: 'Empty contacts array' }) };
        }
        // Clean items — ensure no null primary keys
        const clean = items.filter(c => c.id && c.id.trim && c.id.trim() !== '' && c.id.includes('@'));
        if (clean.length === 0) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'No valid contacts (id must be a non-empty email address)' }) };
        }
        await upsertRows(url, key, 'outreach_contacts', clean);
        // This is the flag that tells page load "data exists"
        await setMeta(url, key, {
          total_outreach: clean.length,
          last_full_sync: new Date().toISOString(),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: clean.length }) };
      }

      // ── QUEUE OPERATIONS ──
      if (action === 'save-queue-item') {
        await upsertRows(url, key, 'email_queue', [body]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'bulk-save-queue') {
        if ((body.queue||[]).length > 0) await upsertRows(url, key, 'email_queue', body.queue);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'update-queue-item') {
        await sbFetch(url, key, `/email_queue?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', prefer: 'return=minimal',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            status: body.status,
            subject: body.subject,
            body: body.body,
            risk_flags: body.risk_flags || [],
            approved_at: body.approved_at || null,
            sent_at: body.sent_at || null,
            updated_at: new Date().toISOString(),
          }),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'record-sent') {
        await upsertRows(url, key, 'sent_history', [{
          contact_email: body.email, contact_name: body.name,
          campaign_id: body.campaign, subject: body.subject, body: body.body,
        }]);
        try {
          await sbFetch(url, key, `/outreach_contacts?id=eq.${encodeURIComponent(body.email)}`, {
            method: 'PATCH', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ last_contacted_at: new Date().toISOString(), last_campaign: body.campaign }),
          });
        } catch(e) { console.warn('Could not update last_contacted_at:', e.message); }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'suppress') {
        await upsertRows(url, key, 'suppression_list', [{ email: (body.email||'').toLowerCase(), reason: body.reason||'manual' }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'unsuppress') {
        await sbFetch(url, key, `/suppression_list?email=eq.${encodeURIComponent((body.email||'').toLowerCase())}`, { method: 'DELETE', prefer: 'return=minimal', headers: {'Prefer':'return=minimal'} });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error(`[store] ${action} error:`, err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: err.message,
        action,
        hint: err.message.includes('NOT_CONFIGURED') ? 'Set SUPABASE_URL and SUPABASE_KEY in Netlify environment variables' :
              err.message.includes('42P01') ? 'Table does not exist — run the SQL schema in Supabase' :
              err.message.includes('23502') ? 'NULL constraint violation — a required field is missing' :
              'Check Netlify function logs for details',
      })
    };
  }
};
