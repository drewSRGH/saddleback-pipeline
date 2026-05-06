// Netlify function — proxies Claude API calls from the browser
// This is needed because the Anthropic API key cannot be exposed in browser JS

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Get API key from Netlify environment variable
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { prompt, contact } = body;

    if (!prompt && !contact) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing prompt or contact' }) };
    }

    // Build the email generation prompt if contact is passed directly
    const userPrompt = prompt || buildPrompt(contact);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 700,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Anthropic error:', res.status, err);
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `Anthropic API error: ${res.status}`, detail: err }) };
    }

    const data = await res.json();
    const text = data.content?.map(b => b.text || '').join('') || '';

    // Parse subject line if present
    const lines = text.split('\n');
    let subject = '';
    let emailBody = text;
    if (lines[0].toUpperCase().startsWith('SUBJECT:')) {
      subject = lines[0].replace(/^SUBJECT:\s*/i, '').trim();
      emailBody = lines.slice(2).join('\n').trim();
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ subject, body: emailBody, raw: text }),
    };
  } catch (err) {
    console.error('AI function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

function buildPrompt(c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
  const tags = c._tags || [];
  const monthsSince = c.updated_at ? Math.round((Date.now() - new Date(c.updated_at)) / 2592000000) : null;
  const eventDate = c.event_date ? new Date(c.event_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null;

  let context = '';
  if (tags.includes('anniversary')) context = `Their event anniversary is coming up — they booked around this time of year before. Reference that timing naturally.`;
  else if (tags.includes('gone-quiet-18mo')) context = `They haven't been in touch for over 18 months. Keep it brief and light — easy to re-engage, no pressure.`;
  else if (tags.includes('gone-quiet-12mo')) context = `About a year has passed since their last activity. A warm check-in is appropriate.`;
  else if (tags.includes('gone-quiet-6mo')) context = `6 months since their last activity. Perfect time for a gentle re-engagement.`;
  else if (tags.includes('no-booking')) context = `They inquired but never confirmed a booking. This is a second-chance outreach — be warm, not pushy.`;
  else if (tags.includes('corporate')) context = `Corporate account — focus on convenience, reliability, and feeding large groups well.`;
  else if (tags.includes('repeat')) context = `Repeat customer — acknowledge the relationship, make them feel valued.`;
  else context = `General outreach to a past catering contact.`;

  return `You are Ryan, Catering Director at Saddleback Restaurant Group in Lansing, Michigan — award-winning BBQ catering.

Write a SHORT, personal outreach email. Make it feel like Ryan actually remembers this person.

Contact: ${name}
${c.company ? `Company: ${c.company}` : ''}
${c.email_address ? `Email: ${c.email_address}` : ''}
${c.event_description ? `Past event: ${c.event_description}` : ''}
${eventDate ? `Event date: ${eventDate}` : ''}
${c.guest_count ? `Guest count: ${c.guest_count}` : ''}
${c.location?.name ? `Location: ${c.location.name}` : ''}
${c.additional_information ? `Notes: ${String(c.additional_information).slice(0, 200)}` : ''}
${monthsSince ? `Months since last contact: ${monthsSince}` : ''}

Context: ${context}

Rules:
- 3 short paragraphs max — keep it human, not marketing-y
- Reference something specific about their event or situation
- One clear easy call to action at the end
- Sign as Ryan, Saddleback Catering, (517) 214-9024
- First line MUST be: SUBJECT: [subject line here]
- Then blank line, then email body only`;
}
