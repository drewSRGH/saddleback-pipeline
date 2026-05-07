// ai.js — Claude email generation with strict anti-hallucination guardrails
// Only uses approved Saddleback facts + actual contact data. Never invents details.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── APPROVED SADDLEBACK FACTS ─────────────────────────────────────────────────
// ONLY these facts may appear in AI-generated emails.
// Do not add anything here that isn't verified and approved.
const SADDLEBACK_FACTS = `
APPROVED FACTS ABOUT SADDLEBACK RESTAURANT GROUP (use ONLY these):
- Business name: Saddleback Restaurant Group / Saddleback Catering
- Location: Lansing, Michigan
- Catering contact: Ryan Piotrowski, Catering Director
- Phone: (517) 214-9024
- Website: https://www.saddleback.catering/
- Catering types we serve: corporate events, office lunches, team meals, employee appreciation, company meetings, weddings, receptions, graduation parties, birthday parties, holiday parties, school events, church events, nonprofit events, large gatherings, sports events, watch parties
- General description: Saddleback is a BBQ catering operation based in Lansing, MI
- Catering styles available: drop-off, pickup, on-site full service (do not promise a specific style unless it's in the customer's inquiry data)
- Call to action options: reply to this email, visit saddleback.catering, call (517) 214-9024
- Signing off: Ryan | Saddleback Catering | (517) 214-9024

THINGS YOU MUST NEVER MENTION (even if they seem obvious):
- Specific menu items (do not name any food, dish, side, protein, or drink)
- Pricing or packages or minimums
- Specific dietary accommodations (vegetarian, vegan, gluten-free, etc.) unless in the customer's actual data
- Delivery promises or geographic coverage
- Specific dates of availability
- Staff names other than Ryan
- Awards or accolades unless verified
- Anything about the restaurant dining experience (this email is about catering only)
`;

// ── CAMPAIGN TALKING POINTS ───────────────────────────────────────────────────
const CAMPAIGN_CONTEXT = {
  'anniversary':  'Their event anniversary is coming up. Reference the timing naturally — "around this time of year" or "it\'s coming up on a year since." Suggest they might want to do something similar again.',
  'msu':          'This is an MSU/Michigan State contact. You can reference Michigan State University, East Lansing, campus life, or Spartan events naturally. Good for staff lunches, department meals, game day gatherings, or graduation.',
  'gone-quiet':   'They haven\'t been in touch for a while. Keep it brief and low-pressure. Make it easy to respond. Don\'t guilt them. Just check in and remind them we\'re here.',
  'high-value':   'They had or requested a large event. Be professional. Acknowledge we can handle large groups.',
  'corporate':    'This is a business or organization. Focus on convenience, reliability, and the ability to feed teams well for meetings, lunches, or company events.',
  'graduation':   'Graduation season is approaching. If they booked a grad party before, acknowledge it. If not, plant the seed for celebrating.',
  'holiday':      'Holiday season is approaching. Office holiday parties and staff appreciation meals book up fast.',
  'no-booking':   'They reached out but never confirmed. Be warm, not pushy. Things change — timing, budget. Make it easy to re-engage.',
  'wedding':      'This is a wedding or reception contact. Be warm and congratulatory in tone.',
  'office-lunch': 'This is a corporate lunch or team meal contact. Focus on easy, reliable catering for regular team needs.',
  'default':      'This is a general outreach to a past contact. Be warm and useful, not generic.',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables. Go to Site Configuration → Environment Variables.' })
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { contact, campaign, accountStatus } = body;
  if (!contact) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing contact' }) };

  // Build the strictly-constrained prompt
  const prompt = buildPrompt(contact, campaign, accountStatus);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const responseText = await res.text();
    if (!res.ok) {
      let detail = responseText;
      try { detail = JSON.parse(responseText).error?.message || responseText; } catch(e) {}
      console.error(`Anthropic ${res.status}:`, detail.slice(0, 200));
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `Anthropic API error ${res.status}: ${detail}` }) };
    }

    const data = JSON.parse(responseText);
    const text = data.content?.map(b => b.text || '').join('') || '';

    // Parse structured output
    let subject = '', emailBody = '', riskFlags = [];
    const lines = text.split('\n');
    let section = '';

    for (const line of lines) {
      if (line.toUpperCase().startsWith('SUBJECT:')) { subject = line.replace(/^SUBJECT:\s*/i, '').trim(); section=''; }
      else if (line.toUpperCase().startsWith('BODY:') || line.toUpperCase() === 'BODY') { section='body'; }
      else if (line.toUpperCase().startsWith('RISK_FLAGS:') || line.toUpperCase() === 'RISK_FLAGS:') { section='risk'; }
      else if (section === 'body') emailBody += (emailBody?'\n':'')+line;
      else if (section === 'risk' && line.trim()) riskFlags.push(line.trim().replace(/^[-*]\s*/,''));
    }

    // Fallback: if no structured parse, treat whole thing as body after subject
    if (!emailBody && !subject) {
      const firstLine = lines[0];
      if (firstLine.toUpperCase().startsWith('SUBJECT:')) {
        subject = firstLine.replace(/^SUBJECT:\s*/i,'').trim();
        emailBody = lines.slice(1).filter(l=>l.trim()).join('\n').trim();
      } else {
        subject = `Following up — ${contact.first_name||'there'}`;
        emailBody = text.trim();
      }
    }

    // Auto-detect risk flags if model didn't provide them
    if (!riskFlags.length) {
      const checkBody = emailBody.toLowerCase();
      const riskyPhrases = ['vegetarian','vegan','gluten','allergen','dairy','menu item','pulled pork','brisket','chicken','ribs','mac and cheese','coleslaw','beans','salad','dessert','price','pricing','package','minimum','available','delivery','guaranteed','promise','award','best in'];
      riskFlags = riskyPhrases.filter(p => checkBody.includes(p)).map(p => `Possible hallucination: "${p}" mentioned — verify this is in approved facts`);
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ subject, body: emailBody, riskFlags })
    };

  } catch (err) {
    console.error('AI function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Function error: ${err.message}` }) };
  }
};

function buildPrompt(c, campaign, accountStatus) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
  const eventDate = c.event_date ? new Date(c.event_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null;
  const campaignCtx = CAMPAIGN_CONTEXT[campaign] || CAMPAIGN_CONTEXT.default;

  // Build ONLY the facts we actually have from their record
  const contactFacts = [
    `Contact name: ${name}`,
    c.company ? `Company/organization: ${c.company}` : null,
    c.event_description ? `Their event type/description: ${c.event_description}` : null,
    eventDate ? `Their event date: ${eventDate}` : null,
    c.guest_count ? `Guest count: ${c.guest_count}` : null,
    c.location?.name ? `Requested location: ${c.location.name}` : null,
    c.event_style ? `Service style requested: ${c.event_style}` : null,
    c.additional_information ? `Notes from their inquiry (use carefully — do not repeat verbatim): ${String(c.additional_information).slice(0, 250)}` : null,
  ].filter(Boolean).join('\n');

  return `You are Ryan, Catering Director at Saddleback Restaurant Group. You are writing a short outreach email to a past contact.

═══════════════════════════════════════════
STRICT RULES — READ BEFORE WRITING ANYTHING
═══════════════════════════════════════════
1. ONLY use facts from the "APPROVED BUSINESS FACTS" and "CONTACT DATA" sections below.
2. DO NOT invent or assume any menu items, food names, dishes, sides, or drinks.
3. DO NOT mention pricing, packages, or minimums.
4. DO NOT mention dietary accommodations (vegetarian, vegan, gluten-free, etc.) unless the contact's own inquiry data mentions it.
5. DO NOT make promises about availability, delivery, or coverage areas.
6. DO NOT fabricate past conversations or preferences not found in the contact data.
7. If you don't have a specific detail, write AROUND it. Say "we'd love to help you plan" instead of guessing specifics.
8. Keep it SHORT: 2-3 paragraphs maximum.
9. Sound like a real local business person, not a marketing email.
10. DO NOT use: "I hope this email finds you well", "exciting opportunity", "don't hesitate", "world-class", "award-winning" unless verified.

═══════════════════════════════════════════
APPROVED BUSINESS FACTS
═══════════════════════════════════════════
${SADDLEBACK_FACTS}

═══════════════════════════════════════════
CONTACT DATA (from Tripleseat — use only what is listed here)
═══════════════════════════════════════════
${contactFacts || 'No specific event data available for this contact.'}

═══════════════════════════════════════════
CAMPAIGN REASON FOR THIS EMAIL
═══════════════════════════════════════════
${campaignCtx}

═══════════════════════════════════════════
REQUIRED OUTPUT FORMAT
═══════════════════════════════════════════
Return EXACTLY this structure:

SUBJECT: [subject line here]

BODY:
[email body — 2-3 short paragraphs — no salutation like "Dear" — start naturally]

RISK_FLAGS:
[List any phrases you used that might need human verification. If none, write "none"]`;
}
