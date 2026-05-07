// store.js — Supabase REST API backend
// Env vars needed in Netlify:
//   SUPABASE_URL = https://yourproject.supabase.co
//   SUPABASE_KEY = service_role key (NOT anon key)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function sb(path, opts = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_KEY not set in Netlify environment variables');
  return fetch(`${url}/rest/v1${path}`, {
    headers: {
      'apikey': key, 'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    method: opts.method || 'GET',
    body: opts.body,
  });
}

async function query(table, qs = '') {
  const res = await sb(`/${table}?${qs}`);
  if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function upsert(table, rows) {
  if (!rows || !rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const res = await sb(`/${table}`, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!res.ok) throw new Error(`Supabase UPSERT ${table}: ${res.status} ${await res.text()}`);
  }
}

async function patch(table, filter, data) {
  const res = await sb(`/${table}?${filter}`, {
    method: 'PATCH', prefer: 'return=minimal',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table}: ${res.status} ${await res.text()}`);
}

async function del(table, filter) {
  const res = await sb(`/${table}?${filter}`, { method: 'DELETE', prefer: 'return=minimal', headers: {'Prefer':'return=minimal'} });
  if (!res.ok) throw new Error(`Supabase DELETE ${table}: ${res.status} ${await res.text()}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = (event.queryStringParameters || {}).action;

  // Config check
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, configured: false,
        error: 'Add SUPABASE_URL and SUPABASE_KEY in Netlify → Site Configuration → Environment Variables, then redeploy.',
      })
    };
  }

  try {

    // ── GET ──────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {

      if (action === 'debug') {
        const [meta, counts] = await Promise.all([
          query('sync_metadata', 'select=key,value').catch(() => []),
          Promise.all([
            query('ts_leads',          'select=count').catch(() => [{ count: 0 }]),
            query('ts_bookings',       'select=count').catch(() => [{ count: 0 }]),
            query('ts_accounts',       'select=count').catch(() => [{ count: 0 }]),
            query('ts_contacts',       'select=count').catch(() => [{ count: 0 }]),
            query('ts_events',         'select=count').catch(() => [{ count: 0 }]),
            query('outreach_contacts', 'select=count').catch(() => [{ count: 0 }]),
            query('email_queue',       'select=count').catch(() => [{ count: 0 }]),
          ]),
        ]);
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            configured: true, supabaseConnected: true,
            syncMetadata: Object.fromEntries((meta || []).map(r => [r.key, r.value])),
            tableCounts: {
              leads:           counts[0]?.[0]?.count ?? 0,
              bookings:        counts[1]?.[0]?.count ?? 0,
              accounts:        counts[2]?.[0]?.count ?? 0,
              contacts:        counts[3]?.[0]?.count ?? 0,
              events:          counts[4]?.[0]?.count ?? 0,
              outreach:        counts[5]?.[0]?.count ?? 0,
              queue:           counts[6]?.[0]?.count ?? 0,
            },
          })
        };
      }

      if (action === 'get-metadata') {
        const rows = await query('sync_metadata', 'select=key,value');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: true, ...Object.fromEntries((rows || []).map(r => [r.key, r.value])) }) };
      }

      if (action === 'get-contacts') {
        const limit  = parseInt(event.queryStringParameters?.limit  || '3000');
        const offset = parseInt(event.queryStringParameters?.offset || '0');
        const rows = await query('outreach_contacts', `select=*&limit=${limit}&offset=${offset}&order=last_event_date.desc.nullslast`);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: rows || [] }) };
      }

      if (action === 'get-queue') {
        const rows = await query('email_queue', 'select=*&order=created_at.desc&limit=500');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ queue: rows || [] }) };
      }

      if (action === 'get-suppressed') {
        const rows = await query('suppression_list', 'select=email');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ list: (rows || []).map(r => r.email) }) };
      }

      if (action === 'get-sent-history') {
        const rows = await query('sent_history', 'select=*&order=sent_at.desc&limit=200');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ history: rows || [] }) };
      }
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (action === 'save-leads') {
        const leads = (body.leads || []).map(l => ({
          id: l.id, first_name: l.first_name, last_name: l.last_name,
          email: (l.email_address || l.email || '').toLowerCase().trim() || null,
          phone: l.phone_number || l.phone,
          company: l.company, event_date: l.event_date || null,
          event_description: l.event_description, event_style: l.event_style,
          guest_count: l.guest_count || null, location_name: l.location?.name,
          additional_information: l.additional_information,
          turned_down_at: l.turned_down_at || null, turned_down_reason: l.turned_down_reason,
          created_at: l.created_at, updated_at: l.updated_at,
          raw: l, synced_at: new Date().toISOString(),
        }));
        await upsert('ts_leads', leads);
        await upsert('sync_metadata', [{ key: 'last_leads_sync', value: new Date().toISOString() }, { key: 'total_leads', value: String(leads.length) }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: leads.length }) };
      }

      if (action === 'save-bookings') {
        const bookings = (body.bookings || []).map(b => ({
          id: b.id, name: b.name, account_id: b.account_id || null, contact_id: b.contact_id || null,
          location_name: b.location_name || b.location?.name,
          status: (b.status || '').toUpperCase(),
          start_date: b.start_date || null, end_date: b.end_date || null,
          guest_count: b.guest_count || null, total_amount: b.total_amount || null,
          description: b.description || b.name,
          created_at: b.created_at, updated_at: b.updated_at,
          raw: b, synced_at: new Date().toISOString(),
        }));
        await upsert('ts_bookings', bookings);
        await upsert('sync_metadata', [{ key: 'last_bookings_sync', value: new Date().toISOString() }, { key: 'total_bookings', value: String(bookings.length) }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: bookings.length }) };
      }

      if (action === 'save-accounts') {
        const accounts = (body.accounts || []).map(a => ({
          id: a.id, name: a.name, description: a.description,
          email: (a.email_address || a.email || '').toLowerCase().trim() || null,
          phone: a.phone_number || a.phone, website: a.website,
          created_at: a.created_at, updated_at: a.updated_at,
          raw: a, synced_at: new Date().toISOString(),
        }));
        await upsert('ts_accounts', accounts);
        await upsert('sync_metadata', [{ key: 'last_accounts_sync', value: new Date().toISOString() }, { key: 'total_accounts', value: String(accounts.length) }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: accounts.length }) };
      }

      if (action === 'save-contacts') {
        const contacts = (body.contacts || []).map(c => ({
          id: c.id, account_id: c.account_id || null,
          first_name: c.first_name, last_name: c.last_name,
          email: (c.email_address || c.email || '').toLowerCase().trim() || null,
          phone: c.phone_number || c.phone, company: c.company,
          created_at: c.created_at, updated_at: c.updated_at,
          raw: c, synced_at: new Date().toISOString(),
        }));
        await upsert('ts_contacts', contacts);
        await upsert('sync_metadata', [{ key: 'last_contacts_sync', value: new Date().toISOString() }, { key: 'total_contacts', value: String(contacts.length) }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: contacts.length }) };
      }

      if (action === 'save-events') {
        const events = (body.events || []).map(e => ({
          id: e.id, booking_id: e.booking_id || null,
          account_id: e.account_id || null, contact_id: e.contact_id || null,
          name: e.name, status: (e.status || '').toUpperCase(),
          event_start: e.event_start || null, event_end: e.event_end || null,
          guest_count: e.guest_count || null, room: e.room,
          location_name: e.location_name || e.location?.name,
          created_at: e.created_at, updated_at: e.updated_at,
          raw: e, synced_at: new Date().toISOString(),
        }));
        await upsert('ts_events', events);
        await upsert('sync_metadata', [{ key: 'last_events_sync', value: new Date().toISOString() }, { key: 'total_events', value: String(events.length) }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: events.length }) };
      }

      if (action === 'save-outreach-contacts') {
        const oc = body.contacts || [];
        await upsert('outreach_contacts', oc);
        await upsert('sync_metadata', [
          { key: 'total_outreach', value: String(oc.length) },
          { key: 'last_full_sync', value: new Date().toISOString() },
        ]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: oc.length }) };
      }

      if (action === 'bulk-save-queue') {
        await upsert('email_queue', body.queue || []);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'update-queue-item') {
        await patch('email_queue', `id=eq.${body.id}`, {
          status: body.status, subject: body.subject, body: body.body,
          risk_flags: body.risk_flags,
          approved_at: body.approved_at || null,
          updated_at: new Date().toISOString(),
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'record-sent') {
        await upsert('sent_history', [{
          contact_email: body.email, contact_name: body.name,
          campaign_id: body.campaign, subject: body.subject, body: body.body,
        }]);
        await patch('outreach_contacts', `id=eq.${encodeURIComponent(body.email)}`, {
          last_contacted_at: new Date().toISOString(), last_campaign: body.campaign,
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'suppress') {
        await upsert('suppression_list', [{ email: (body.email || '').toLowerCase(), reason: body.reason || 'manual' }]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'unsuppress') {
        await del('suppression_list', `email=eq.${encodeURIComponent((body.email || '').toLowerCase())}`);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('Store error:', err.message);
    // Clear error message — tell the user exactly what to do
    const msg = err.message.includes('SUPABASE') ? err.message : `Database error: ${err.message}`;
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: msg }) };
  }
};
