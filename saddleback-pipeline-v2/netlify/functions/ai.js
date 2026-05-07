// ai.js — Claude email generation with strict anti-hallucination guardrails
// Model: claude-sonnet-4-6 (current as of May 2026)
// Post-processes output to remove em dashes (AI tell)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── APPROVED FACTS — only these may appear in emails ─────────────────────────
const FACTS = `
APPROVED SADDLEBACK FACTS (use ONLY these — nothing else):
- Business: Saddleback Restaurant Group / Saddleback Catering
- City: Lansing, Michigan
- Catering contact: Ryan Piotrowski, Catering Director, (517) 214-9024
- Website: https://www.saddleback.catering/
- What we do: BBQ catering for events in the Lansing area
- Event types we serve: corporate lunches, office meals, team meetings, employee appreciation, company events, weddings, receptions, graduation parties, birthday parties, holiday parties, school events, church gatherings, nonprofit events, large gatherings, sports watch parties, tailgates
- Call to action: reply to this email, visit saddleback.catering, or call (517) 214-9024
- Sign-off: Ryan | Saddleback Catering | (517) 214-9024

NEVER MENTION (not approved — will get flagged):
- Any specific food, dish, menu item, protein, side, or drink
- Pricing, packages, minimums, or cost estimates
- Dietary accommodations (vegetarian, vegan, gluten-free, halal, etc.) unless in customer's own data
- Specific delivery ranges or geographic promises
- Staff names other than Ryan
- Any claim of being "award-winning", "best", or similar unless verified
- Anything about the restaurant dining room — this is catering only
- Promises about availability on specific dates
`.trim();

const CAMPAIGN_CONTEXT = {
  anniversary:   'Their event anniversary falls within the next 90 days. Reference the timing naturally, like "this time of year" or "coming up on a year." Suggest they might want to do something similar.',
  msu:           'This is a Michigan State University contact. You can reference MSU, East Lansing, or Spartan events naturally. Good for staff lunches, department meals, or graduation.',
  'gone-quiet':  'They have not been in touch for a while. Keep it very brief and low-pressure. Make replying easy. No guilt, no urgency.',
  'high-value':  'They had or requested a large event. Be professional. Acknowledge we can handle groups of that size.',
  corporate:     'This is a business or organization. Focus on making team meals and company events easy and reliable.',
  graduation:    'Graduation season is approaching. If they had a grad event before, acknowledge it. If not, plant the seed.',
  holiday:       'Holiday season is approaching. Office parties and staff appreciation meals book up early.',
  'no-booking':  'They reached out before but never confirmed. Keep it warm and easy. No pressure.',
  wedding:       'Wedding or reception contact. Be warm.',
  'office-lunch':'Regular corporate lunch or team meal contact.',
  default:       'General outreach. Be warm, direct, and helpful.',
};

// ── Remove em dashes from text ────────────────────────────────────────────────
function removeEmDashes(text) {
  if (!text) return text;
  return text
    .replace(/\s*—\s*/g, ', ')   // em dash with spaces → comma
    .replace(/—/g, ', ')          // bare em dash → comma
    .replace(/\s*–\s*/g, ', ')   // en dash with spaces → comma
    .replace(/–/g, ', ')          // bare en dash → comma
    .replace(/,\s*,/g, ',')       // clean up double commas
    .replace(/\s+,/g, ',');       // clean up space-before-comma
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return {
    statusCode: 500, headers: CORS,
    body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables.' })
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { contact, campaign } = body;
  if (!contact) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing contact' }) };

  const prompt = buildPrompt(contact, campaign);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try { detail = JSON.parse(raw).error?.message || raw; } catch(e) {}
      console.error(`Anthropic ${res.status}:`, detail.slice(0, 200));
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `Anthropic ${res.status}: ${detail}` }) };
    }

    const data   = JSON.parse(raw);
    const text   = data.content?.map(b => b.text || '').join('') || '';
    const lines  = text.split('\n');

    // Parse structured output
    let subject = '', emailBody = '', riskFlags = [];
    let section = '';
    for (const line of lines) {
      const u = line.toUpperCase().trimStart();
      if (u.startsWith('SUBJECT:')) { subject = line.replace(/^SUBJECT:\s*/i, '').trim(); section = ''; }
      else if (u === 'BODY:' || u.startsWith('BODY:')) { section = 'body'; if (u !== 'BODY:') emailBody = line.replace(/^BODY:\s*/i, '').trim(); }
      else if (u === 'RISK_FLAGS:' || u.startsWith('RISK_FLAGS:')) { section = 'risk'; }
      else if (section === 'body') emailBody += (emailBody ? '\n' : '') + line;
      else if (section === 'risk' && line.trim() && line.trim() !== 'none') riskFlags.push(line.trim().replace(/^[-*]\s*/, ''));
    }

    // Fallback if parsing failed
    if (!emailBody) {
      subject = subject || lines[0]?.replace(/^SUBJECT:\s*/i, '').trim() || `Following up`;
      emailBody = lines.slice(1).filter(l => l.trim()).join('\n').trim() || text;
    }

    // Post-process: remove em dashes
    subject   = removeEmDashes(subject);
    emailBody = removeEmDashes(emailBody);

    // Auto-detect risk flags if not provided
    if (!riskFlags.length) {
      const check = emailBody.toLowerCase();
      const risky = ['vegetarian','vegan','gluten','dairy','allergen','pulled pork','brisket','chicken','ribs','mac','slaw','beans','salad','dessert','pricing','package','minimum','award','best in'];
      riskFlags = risky.filter(p => check.includes(p)).map(p => `"${p}" mentioned — not in approved facts`);
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ subject, body: emailBody, riskFlags })
    };

  } catch (err) {
    console.error('AI error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

function buildPrompt(c, campaign) {
  const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
  const evDate   = c.last_event_date || c.event_date
    ? new Date(c.last_event_date || c.event_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : null;
  const ctx      = CAMPAIGN_CONTEXT[campaign] || CAMPAIGN_CONTEXT.default;
  const status   = c.account_status || c._status || '';
  const bStatus  = c.last_booking_status || '';

  const contactData = [
    `Name: ${name}`,
    (c.company) ? `Company/org: ${c.company}` : null,
    evDate ? `Past event date: ${evDate}` : null,
    (c.event_description || c.last_event_description) ? `Event type: ${c.event_description || c.last_event_description}` : null,
    c.guest_count ? `Guest count: ${c.guest_count}` : null,
    c.location_name ? `Location: ${c.location_name}` : null,
    (c.event_style || c.last_event_style) ? `Service style: ${c.event_style || c.last_event_style}` : null,
    bStatus ? `Tripleseat booking status: ${bStatus}` : null,
    c.additional_information ? `Their inquiry notes (use carefully, do not quote directly): ${String(c.additional_information).slice(0, 200)}` : null,
  ].filter(Boolean).join('\n');

  return `You are Ryan, Catering Director at Saddleback Restaurant Group. Write a short outreach email.

RULES — READ ALL OF THESE BEFORE WRITING:
1. Use ONLY facts from APPROVED FACTS and CONTACT DATA below. Nothing else.
2. Do NOT name any food, dish, menu item, protein, side, drink, or ingredient.
3. Do NOT mention pricing, packages, minimums, or cost.
4. Do NOT mention dietary accommodations unless the contact's own data mentions it.
5. Do NOT make promises about dates, availability, delivery, or coverage.
6. Do NOT invent past conversations or preferences.
7. Do NOT use em dashes (—) anywhere. Use commas, periods, or short sentences instead.
8. If you lack a specific detail, stay general: "happy to talk through options" not a made-up detail.
9. Sound like a real local business person. Not polished. Not corporate. Not fake-friendly.
10. 2 to 3 short paragraphs. No more.
11. Do NOT start with "I hope" or "I wanted to reach out" or "Just checking in."

APPROVED FACTS:
${FACTS}

CONTACT DATA (from Tripleseat — use only what is listed):
${contactData || 'No specific event data available.'}

CAMPAIGN REASON:
${ctx}

OUTPUT FORMAT (required):
SUBJECT: [subject line — no em dashes]

BODY:
[2-3 short paragraphs — start naturally, no "Dear", no em dashes]

RISK_FLAGS:
[List any phrases that need human review. Write "none" if clean.]`;
}
