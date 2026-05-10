// store.js — Supabase backend
// SUPABASE_URL and SUPABASE_KEY must be set in Netlify environment variables

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function safeDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) return String(s);
  try { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); } catch(e) { return null; }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('NOT_CONFIGURED');
  return { url, key };
}

async function sbFetch(url, key, path, opts = {}) {
  const cleanUrl = url.replace(/\/+$/, '');
  const res = await fetch(`${cleanUrl}/rest/v1${path}`, {
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
    throw new Error(`Supabase ${opts.method||'GET'} ${path}: ${res.status} ${text.slice(0,400)}`);
  }
  if (opts.method === 'GET' || !opts.method) return res.json();
  return { ok: true };
}

async function query(url, key, table, qs = '') {
  return sbFetch(url, key, `/${table}?${qs}`);
}

async function upsertRows(url, key, table, rows) {
  if (!rows || rows.length === 0) return;
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = (event.queryStringParameters || {}).action;

  let SB;
  try { SB = getSupabase(); } catch(e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, configured: false, error: 'SUPABASE_URL and SUPABASE_KEY are not set.' }) };
  }

  const { url, key } = SB;

  try {

    // ── GET ───────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {

      // ── TEST ENDPOINT — tells us the exact Supabase error for ts_bookings ──
      // Visit: /.netlify/functions/store?action=test-booking
      if (action === 'test-booking') {
        const results = {};

        // Test 1: bare minimum — just id and synced_at
        try {
          await sbFetch(url, key, '/ts_bookings', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{ id: 999999991, synced_at: new Date().toISOString() }]),
          });
          results.test1_id_only = 'PASS';
        } catch(e) { results.test1_id_only = 'FAIL: ' + e.message; }

        // Test 2: id + name + raw + synced_at
        try {
          await sbFetch(url, key, '/ts_bookings', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{ id: 999999992, name: 'TEST', raw: { test: true }, synced_at: new Date().toISOString() }]),
          });
          results.test2_with_name_raw = 'PASS';
        } catch(e) { results.test2_with_name_raw = 'FAIL: ' + e.message; }

        // Test 3: full realistic row
        try {
          await sbFetch(url, key, '/ts_bookings', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{
              id: 999999993, name: 'TEST FULL', account_id: null, contact_id: null,
              location_name: 'Test', status: 'TENTATIVE', start_date: '2026-01-01',
              end_date: '2026-01-01', guest_count: 50, total_amount: null,
              description: 'test', created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(), raw: { test: true },
              synced_at: new Date().toISOString(),
            }]),
          });
          results.test3_full_row = 'PASS';
        } catch(e) { results.test3_full_row = 'FAIL: ' + e.message; }

        // Clean up test rows
        try { await sbFetch(url, key, '/ts_bookings?id=gte.999999991&id=lte.999999993', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } }); } catch(e) {}

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results, message: 'Check which tests passed and which failed' }) };
      }

      if (action === 'debug') {
        let metaRows = [], tableCounts = {};
        try { metaRows = await query(url, key, 'sync_metadata', 'select=key,value&order=key.asc'); } catch(e) { metaRows = [{ key: 'error', value: e.message }]; }
        try {
          const tables = ['ts_leads','ts_bookings','ts_accounts','ts_contacts','ts_events','outreach_contacts','email_queue'];
          const results = await Promise.all(tables.map(t =>
            sbFetch(url, key, `/${t}?select=count`, { headers: { 'Prefer': 'count=exact', 'Range': '0-0' } })
              .then(r => Array.isArray(r) ? r[0]?.count : 0).catch(() => 'error')
          ));
          tables.forEach((t, i) => tableCounts[t] = results[i]);
        } catch(e) { tableCounts.error = e.message; }
        const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: true, supabaseConnected: true, syncMetadata: meta, tableCounts }) };
      }

      if (action === 'get-metadata') {
        const rows = await query(url, key, 'sync_metadata', 'select=key,value');
        const meta = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: true, loadedFrom: 'supabase', ...meta }) };
      }

      if (action === 'get-contacts') {
        const limit  = Math.min(parseInt(event.queryStringParameters?.limit || '5000'), 10000);
        const offset = parseInt(event.queryStringParameters?.offset || '0');
        const rows = await query(url, key, 'outreach_contacts', `select=*&limit=${limit}&offset=${offset}&order=last_event_date.desc.nullslast`);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: rows || [], count: rows?.length || 0 }) };
      }

      if (action === 'get-queue') {
        const rows = await query(url, key, 'email_queue', 'select=*&order=created_at.desc&limit=500');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ queue: rows || [] }) };
      }

      if (action === 'get-suppressed') {
        const rows = await query(url, key, 'suppression_list', 'select=email');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ list: (rows || []).map(r => r.email) }) };
      }

      if (action === 'get-table') {
        const table   = event.queryStringParameters?.table;
        const qs      = event.queryStringParameters?.qs || 'select=*&limit=1000';
        const allowed = ['ts_bookings','ts_accounts','ts_contacts','ts_leads','ts_events','outreach_contacts'];
        if (!table || !allowed.includes(table)) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid table: ' + table }) };
        }
        const rows = await query(url, key, table, decodeURIComponent(qs));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ rows: rows || [], count: rows?.length || 0 }) };
      }

      if (action === 'get-sent-history') {
        const rows = await query(url, key, 'sent_history', 'select=*&order=sent_at.desc&limit=200');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ history: rows || [] }) };
      }
    }

    // ── POST ──────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (action === 'save-leads') {
        const items = (body.leads || []).map(l => ({
          id: l.id, first_name: l.first_name || null, last_name: l.last_name || null,
          email: (l.email_address || '').toLowerCase().trim() || null,
          phone: l.phone_number || null, company: l.company || null,
          event_date: l.event_date || null, event_description: l.event_description || null,
          event_style: l.event_style || null, guest_count: l.guest_count || null,
          location_name: l.location?.name || null,
          additional_information: l.additional_information || null,
          turned_down_at: l.turned_down_at || null, turned_down_reason: l.turned_down_reason || null,
          created_at: safeDate(l.created_at), updated_at: safeDate(l.updated_at),
          raw: l, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_leads', items);
        await setMeta(url, key, { last_leads_sync: new Date().toISOString(), total_leads: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      if (action === 'save-bookings') {
        const items = (body.bookings || []).map(b => ({
          id: b.id, name: b.name || null,
          account_id: b.account_id || null, contact_id: b.contact_id || null,
          location_name: b.location_name || b.location?.name || null,
          status: (b.status || '').toUpperCase() || null,
          start_date: b.start_date || null, end_date: b.end_date || null,
          guest_count: b.guest_count || null, total_amount: b.total_amount || null,
          description: b.description || b.name || null,
          created_at: safeDate(b.created_at), updated_at: safeDate(b.updated_at),
          raw: b, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_bookings', items);
        await setMeta(url, key, { last_bookings_sync: new Date().toISOString(), total_bookings: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      if (action === 'save-accounts') {
        const items = (body.accounts || []).map(a => ({
          id: a.id, name: a.name || 'Unknown', description: a.description || null,
          email: (a.email_address || a.email || '').toLowerCase().trim() || null,
          phone: a.phone_number || a.phone || null, website: a.website || null,
          created_at: safeDate(a.created_at), updated_at: safeDate(a.updated_at), raw: a,
        }));
        await upsertRows(url, key, 'ts_accounts', items);
        await setMeta(url, key, { last_accounts_sync: new Date().toISOString(), total_accounts: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      if (action === 'save-contacts') {
        const items = (body.contacts || []).map(c => ({
          id: c.id, account_id: c.account_id || null,
          first_name: c.first_name || null, last_name: c.last_name || null,
          email: (c.email_address || c.email || '').toLowerCase().trim() || null,
          phone: c.phone_number || c.phone || null, company: c.company || null,
          created_at: safeDate(c.created_at), updated_at: safeDate(c.updated_at), raw: c,
        }));
        await upsertRows(url, key, 'ts_contacts', items);
        await setMeta(url, key, { last_contacts_sync: new Date().toISOString(), total_contacts: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      if (action === 'save-events') {
        const items = (body.events || []).map(e => ({
          id: e.id, booking_id: e.booking_id || null,
          account_id: e.account_id || null, contact_id: e.contact_id || null,
          name: e.name || null,
          status: (e.status || e.event_status || e.booking_status || '').toString().toUpperCase().trim() || null,
          event_start: e.event_start_iso8601 || (e.start_date ? e.start_date : null),
          event_end:   e.event_end_iso8601   || (e.end_date   ? e.end_date   : null),
          guest_count: e.guest_count || null,
          room: (e.rooms && e.rooms[0]?.name) || e.room || null,
          location_name: e.location?.name || null,
          created_at: safeDate(e.created_at) || new Date().toISOString(),
          updated_at: safeDate(e.updated_at) || new Date().toISOString(),
          raw: e, synced_at: new Date().toISOString(),
        }));
        await upsertRows(url, key, 'ts_events', items);
        await setMeta(url, key, { last_events_sync: new Date().toISOString(), total_events: items.length });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: items.length }) };
      }

      if (action === 'save-sync-checkpoint') {
        await setMeta(url, key, {
          last_full_sync: new Date().toISOString(),
          total_events:   body.total_events   || 0,
          total_bookings: body.total_bookings || 0,
          total_contacts: body.total_contacts || 0,
          total_accounts: body.total_accounts || 0,
          total_leads:    body.total_leads    || 0,
          total_outreach: body.total_events   || body.total_bookings || 0,
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'save-outreach-contacts') {
        const items = body.contacts || [];
        if (items.length === 0) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: 0 }) };
        const clean = items.filter(c => c.id && c.id.trim && c.id.trim() !== '' && c.id.includes('@'));
        if (clean.length === 0) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'No valid contacts (id must be email)' }) };
        await upsertRows(url, key, 'outreach_contacts', clean);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: clean.length }) };
      }

      if (action === 'save-queue-item') {
        await upsertRows(url, key, 'email_queue', [body]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'bulk-save-queue') {
        if ((body.queue || []).length > 0) await upsertRows(url, key, 'email_queue', body.queue);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'update-queue-item') {
        await sbFetch(url, key, `/email_queue?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: body.status, subject: body.subject, body: body.body, risk_flags: body.risk_flags || [], approved_at: body.approved_at || null, sent_at: body.sent_at || null, updated_at: new Date().toISOString() }),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'record-sent') {
        await upsertRows(url, key, 'sent_history', [{ contact_email: body.email, contact_name: body.name, campaign_id: body.campaign, subject: body.subject, body: body.body }]);
        try {
          await sbFetch(url, key, `/outreach_contacts?id=eq.${encodeURIComponent(body.email)}`, { method: 'PATCH', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ last_contacted_at: new Date().toISOString(), last_campaign: body.campaign }) });
        } catch(e) { console.warn('Could not update last_contacted_at:', e.message); }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'suppress') {
        await upsertRows(url, key, 'suppression_list', [{ email: (body.email || '').toLowerCase(), reason: body.reason || 'manual' }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'unsuppress') {
        await sbFetch(url, key, `/suppression_list?email=eq.${encodeURIComponent((body.email || '').toLowerCase())}`, { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }


      // ── CAMPAIGNS ──────────────────────────────────────────────────────────
      // body may be out of scope here (campaigns block is outside GET/POST blocks)
      const campBody = (event.httpMethod === 'POST' && event.body) ? (() => { try { return JSON.parse(event.body); } catch(e) { return {}; } })() : {};

      if (action === 'get-campaigns') {
        const campaigns = await query(url, key, 'campaigns', 'select=*&order=created_at.desc');
        const list = campaigns || [];
        const withStats = await Promise.all(list.map(async (camp) => {
          try {
            const contacts = await query(url, key, 'campaign_contacts', `select=status&campaign_id=eq.${camp.id}&limit=5000`);
            const all = contacts || [];
            return { ...camp,
              total:    all.length,
              drafted:  all.filter(x => x.status === 'drafted').length,
              approved: all.filter(x => x.status === 'approved').length,
              sent:     all.filter(x => x.status === 'sent').length,
            };
          } catch(e) { return { ...camp, total:0, drafted:0, approved:0, sent:0 }; }
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ campaigns: withStats }) };
      }

      if (action === 'save-campaign') {
        const row = {
          name:       campBody.name || 'Untitled Campaign',
          angle:      campBody.angle || null,
          target:     campBody.target || 'all',
          status:     'active',
          updated_at: new Date().toISOString(),
        };
        if (campBody.id) {
          await sbFetch(url, key, `/campaigns?id=eq.${campBody.id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(row),
          });
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: campBody.id }) };
        } else {
          const result = await sbFetch(url, key, '/campaigns', {
            method: 'POST', prefer: 'return=representation',
            headers: { 'Prefer': 'return=representation' },
            body: JSON.stringify([row]),
          });
          const created = Array.isArray(result) ? result[0] : result;
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: created.id }) };
        }
      }

      if (action === 'delete-campaign') {
        await sbFetch(url, key, `/campaign_contacts?campaign_id=eq.${campBody.id}`, {
          method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' },
        });
        await sbFetch(url, key, `/campaigns?id=eq.${campBody.id}`, {
          method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' },
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'add-campaign-contacts') {
        const rows = (campBody.contacts || []).map(c => ({
          campaign_id:   campBody.campaign_id,
          event_id:      c.event_id || null,
          contact_email: c.email || null,
          contact_name:  c.name || null,
          company:       c.company || null,
          event_history: c.event_history || null,
          status:        'pending',
          created_at:    new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        }));
        if (!rows.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, added: 0 }) };
        // Batch insert
        for (let i = 0; i < rows.length; i += 100) {
          await sbFetch(url, key, '/campaign_contacts', {
            method: 'POST', prefer: 'return=minimal',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(rows.slice(i, i + 100)),
          });
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, added: rows.length }) };
      }

      if (action === 'get-campaign-contacts') {
        const cid = event.queryStringParameters?.campaign_id;
        const offset = parseInt(event.queryStringParameters?.offset || '0');
        const limit  = parseInt(event.queryStringParameters?.limit  || '500');
        const status = event.queryStringParameters?.status || '';
        let qs = `campaign_id=eq.${cid}&order=created_at.asc&limit=${limit}&offset=${offset}`;
        if (status) qs += `&status=eq.${status}`;
        const rows = await query(url, key, 'campaign_contacts', qs);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: rows || [] }) };
      }

      if (action === 'update-campaign-contact') {
        const patch = {
          subject:     campBody.subject     || null,
          body:        campBody.body        || null,
          status:      campBody.status      || 'pending',
          approved_at: campBody.approved_at || null,
          sent_at:     campBody.sent_at     || null,
          updated_at:  new Date().toISOString(),
        };
        await sbFetch(url, key, `/campaign_contacts?id=eq.${campBody.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify(patch),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'remove-campaign-contact') {
        await sbFetch(url, key, `/campaign_contacts?id=eq.${campBody.id}`, {
          method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' },
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'bulk-approve-campaign') {
        await sbFetch(url, key, `/campaign_contacts?campaign_id=eq.${campBody.campaign_id}&status=eq.drafted`, {
          method: 'PATCH', prefer: 'return=minimal',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch(err) {
    console.error(`[store] ${action} error:`, err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message, action }),
    };
  }
};
