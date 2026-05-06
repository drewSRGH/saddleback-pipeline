// Netlify function — Claude API proxy
// Fixes: correct model name, proper error handling, campaign-aware prompts

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable is not set in Netlify. Go to Site Configuration → Environment Variables and add it.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { contact, campaign } = body;
  if (!contact) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing contact in request body' }) };

  const prompt = buildPrompt(contact, campaign);

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
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error(`Anthropic API error ${res.status}:`, responseText);
      let detail = responseText;
      try { detail = JSON.parse(responseText).error?.message || responseText; } catch(e) {}
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ error: `Anthropic API error ${res.status}: ${detail}` })
      };
    }

    const data = JSON.parse(responseText);
    const text = data.content?.map(b => b.text || '').join('') || '';

    // Parse SUBJECT: line from response
    const lines = text.split('\n');
    let subject = `Following up — ${contact.first_name || 'there'}`;
    let emailBody = text;
    if (lines[0].toUpperCase().startsWith('SUBJECT:')) {
      subject = lines[0].replace(/^SUBJECT:\s*/i, '').trim();
      emailBody = lines.slice(1).filter(l=>l.trim()).join('\n').trim();
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ subject, body: emailBody }) };

  } catch (err) {
    console.error('AI function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Function error: ${err.message}` }) };
  }
};

// ── CAMPAIGN-AWARE PROMPT BUILDER ─────────────────────────────────────────────
function buildPrompt(c, campaign) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
  const eventDate = c.event_date ? new Date(c.event_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null;

  // Campaign context
  const campaignCtx = {
    'gone-quiet':    `This person inquired ${c._daysSinceEvent||'a while'} ago but we haven't heard back. Write a brief, low-pressure check-in. Make it easy to respond.`,
    'anniversary':   `Their event anniversary is coming up. They may do this event annually. Reference the timing naturally — "this time of year" or "coming up on a year since".`,
    'corporate':     `This is a corporate contact at ${c.company||'a company'}. Focus on how Saddleback can make their team meals, lunch meetings, or company events easy and impressive.`,
    'no-booking':    `They submitted a lead but never confirmed. Something may have changed — budget, timing, or they just got busy. Keep it warm and easy, not pushy.`,
    'high-value':    `Large event with ${c.guest_count||'many'} guests. These are high-priority. Be professional and specific about our ability to handle large groups.`,
    'msu':           `MSU contact. Reference Michigan State, Sparty, East Lansing — show we know the territory. Could be for a game day, department lunch, event, or graduation.`,
    'graduation':    `Graduation season is coming up. If they've booked a grad party before, mention it. If not, plant the seed for celebrating their graduate.`,
    'holiday':       `Holiday season is approaching. Office holiday parties, end-of-year team celebrations, family gatherings — these fill up fast.`,
    'default':       `General outreach to a past catering contact. Be warm and useful, not generic.`
  };

  const ctx = campaign ? (campaignCtx[campaign] || campaignCtx.default) : campaignCtx.default;

  return `You are Ryan, Catering Director at Saddleback Restaurant Group in Lansing, Michigan — award-winning BBQ catering for corporate events, weddings, graduations, holiday parties, and celebrations of all kinds.

Write a SHORT, personal outreach email. Sound like a real person, not a marketing department.

CONTACT INFO:
- Name: ${name}
${c.company ? `- Company: ${c.company}` : ''}
${c.email_address ? `- Email: ${c.email_address}` : ''}
${c.event_description ? `- Past event: ${c.event_description}` : ''}
${eventDate ? `- Event date: ${eventDate}` : ''}
${c.guest_count ? `- Guest count: ${c.guest_count}` : ''}
${c.location?.name ? `- Location: ${c.location.name}` : ''}
${c.additional_information ? `- Notes from their inquiry: ${String(c.additional_information).slice(0,200)}` : ''}
${c.company_domain && !['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com'].includes(c.company_domain) ? `- Email domain: ${c.company_domain}` : ''}

CAMPAIGN CONTEXT: ${ctx}

RULES:
- Max 3 short paragraphs
- Reference something specific about their event or situation if possible
- One clear, easy call to action at the end (reply to this email, schedule a call, etc.)
- No corporate buzzwords, no "I hope this email finds you well", no "exciting opportunity"
- Sign off as: Ryan | Saddleback Catering | (517) 214-9024

FORMAT (required):
SUBJECT: [subject line here]
[blank line]
[email body only — no "Dear" prefix, just start naturally]`;
}
