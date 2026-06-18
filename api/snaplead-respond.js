// api/snaplead-respond.js
// Core engine: receive lead → Claude AI response → email to customer → notify business → store
// Uses Supabase REST API directly — no client library needed

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

async function supabaseGet(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return resp.json();
}

async function supabaseInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  const result = await resp.json();
  return Array.isArray(result) ? result[0] : result;
}

async function supabaseUpdate(table, query, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();

  try {
    const { business_slug, customer_name, customer_email, customer_phone, answers, source } = req.body;

    if (!business_slug || !customer_name || !customer_email) {
      return res.status(400).json({ error: 'Missing required fields: business_slug, customer_name, customer_email' });
    }

    // 1. Fetch business config
    const businesses = await supabaseGet('snaplead_businesses', `business_slug=eq.${encodeURIComponent(business_slug)}&select=*&limit=1`);
    if (!businesses || businesses.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    const business = businesses[0];

    if (business.status === 'cancelled' || business.status === 'paused') {
      return res.status(403).json({ error: 'This business account is not active' });
    }
    if (business.plan === 'trial' && new Date(business.trial_ends_at) < new Date()) {
      return res.status(403).json({ error: 'Trial has expired' });
    }

    // 2. Fetch industry template for system prompt
    const templates = await supabaseGet('snaplead_templates', `industry_key=eq.${encodeURIComponent(business.industry)}&select=system_prompt&limit=1`);
    const templatePrompt = templates && templates.length > 0 ? templates[0].system_prompt : '';

    // 3. Build the prompt
    const systemPrompt = templatePrompt
      .replace(/\{\{business_name\}\}/g, business.business_name)
      .replace(/\{\{industry_description\}\}/g, business.business_description || business.industry);

    const questions = typeof business.custom_questions === 'string' ? JSON.parse(business.custom_questions) : (business.custom_questions || []);
    let answersText = '';
    if (answers && typeof answers === 'object') {
      for (const [key, value] of Object.entries(answers)) {
        const question = questions.find(q => q.id === key);
        const label = question ? question.label : key;
        answersText += `${label}: ${value}\n`;
      }
    }

    // Determine urgency
    let urgency = 'medium';
    const urgencyAnswer = answers?.urgency || answers?.visit_reason || '';
    if (typeof urgencyAnswer === 'string') {
      const lower = urgencyAnswer.toLowerCase();
      if (lower.includes('emergency') || lower.includes('urgent')) urgency = 'emergency';
      else if (lower.includes('today') || lower.includes('immediately')) urgency = 'high';
      else if (lower.includes('just') || lower.includes('exploring') || lower.includes('getting quotes')) urgency = 'low';
    }

    const userMessage = `New lead from ${customer_name} (${customer_email}${customer_phone ? ', ' + customer_phone : ''}).\n\nTheir responses:\n${answersText}\nWrite a personalised response to this potential customer.`;

    // 4. Call Claude
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const aiData = await aiResponse.json();
    const aiText = aiData.content?.[0]?.text || 'Thank you for reaching out. Our team will be in touch shortly.';
    const tokensUsed = (aiData.usage?.input_tokens || 0) + (aiData.usage?.output_tokens || 0);
    const responseTimeMs = Date.now() - startTime;

    // 5. Store the lead
    const lead = await supabaseInsert('snaplead_leads', {
      business_id: business.id,
      customer_name,
      customer_email,
      customer_phone: customer_phone || null,
      answers: answers || {},
      urgency,
      ai_response: aiText,
      response_time_ms: responseTimeMs,
      status: 'responded',
      source: source || 'standalone'
    });

    if (!lead || lead.code) {
      console.error('Lead insert error:', lead);
      return res.status(500).json({ error: 'Failed to store lead' });
    }

    // 6. Log the response
    await supabaseInsert('snaplead_responses', {
      lead_id: lead.id,
      business_id: business.id,
      response_time_ms: responseTimeMs,
      tokens_used: tokensUsed,
      delivery_method: 'email',
      delivered: true,
      cost_cents: Math.ceil(tokensUsed * 0.003 * 100)
    });

    // 7. Update business lead counts
    await supabaseUpdate('snaplead_businesses', `id=eq.${business.id}`, {
      monthly_leads: (business.monthly_leads || 0) + 1,
      total_leads: (business.total_leads || 0) + 1,
      updated_at: new Date().toISOString()
    });

    // 8. Send email to customer
    const customerEmailHtml = buildCustomerEmail(business.business_name, customer_name, aiText, business.logo_url);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: `${business.business_name} via SnapLead <noreply@jovilex.com>`,
        to: customer_email,
        subject: `Thanks for reaching out, ${customer_name.split(' ')[0]}!`,
        html: customerEmailHtml
      })
    });

    // 9. Notify business owner
    const notifyEmail = business.notification_email || business.owner_email;
    const notifyHtml = buildNotificationEmail(business.business_name, customer_name, customer_email, customer_phone, answers, questions, urgency, aiText, responseTimeMs);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'SnapLead <noreply@jovilex.com>',
        to: notifyEmail,
        subject: `${urgency === 'emergency' ? '🚨 URGENT: ' : ''}New lead: ${customer_name} — ${Object.values(answers)[0] || 'General enquiry'}`,
        html: notifyHtml
      })
    });

    // 10. Return success
    return res.status(200).json({
      success: true,
      response_time_ms: responseTimeMs,
      message: aiText,
      lead_id: lead.id
    });

  } catch (err) {
    console.error('SnapLead respond error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};


function buildCustomerEmail(businessName, customerName, aiResponse, logoUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">
<div style="background:#ffffff;border-radius:12px;padding:36px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
${logoUrl ? `<img src="${logoUrl}" alt="${businessName}" style="height:40px;margin-bottom:24px;">` : `<div style="font-size:20px;font-weight:700;color:#111111;margin-bottom:24px;">${businessName}</div>`}
<div style="font-size:15px;line-height:1.7;color:#1f2937;">
${aiResponse.split('\n').filter(p => p.trim()).map(p => `<p style="margin:0 0 16px 0;">${p}</p>`).join('')}
</div></div>
<div style="text-align:center;padding:24px 0 0;font-size:11px;color:#9ca3af;">
Powered by <a href="https://jovilex.com" style="color:#10B981;text-decoration:none;">SnapLead</a></div>
</div></body></html>`;
}

function buildNotificationEmail(businessName, customerName, customerEmail, customerPhone, answers, questions, urgency, aiResponse, responseTimeMs) {
  const urgencyColors = { emergency: '#dc2626', high: '#f59e0b', medium: '#10B981', low: '#6b7280' };
  const urgencyLabels = { emergency: '🚨 EMERGENCY', high: '⚡ HIGH', medium: '● MEDIUM', low: '○ LOW' };

  let answersHtml = '';
  if (answers && typeof answers === 'object') {
    for (const [key, value] of Object.entries(answers)) {
      const question = questions.find(q => q.id === key);
      const label = question ? question.label : key;
      answersHtml += `<tr><td style="padding:8px 12px;font-size:13px;color:#6b7280;border-bottom:1px solid #1f2937;width:40%;">${label}</td><td style="padding:8px 12px;font-size:13px;color:#ffffff;font-weight:500;border-bottom:1px solid #1f2937;">${value}</td></tr>`;
    }
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">
<div style="background:#1a1a1a;border-radius:12px;padding:28px 24px;margin-bottom:16px;border:1px solid #2a2a2a;">
<div style="margin-bottom:20px;"><div style="font-size:18px;font-weight:700;color:#ffffff;display:inline;">New Lead</div><div style="float:right;font-size:12px;font-weight:600;color:${urgencyColors[urgency]};background:${urgencyColors[urgency]}15;padding:4px 10px;border-radius:20px;">${urgencyLabels[urgency]}</div><div style="clear:both;"></div></div>
<div style="font-size:22px;font-weight:700;color:#ffffff;margin-bottom:4px;">${customerName}</div>
<div style="font-size:14px;color:#9ca3af;"><a href="mailto:${customerEmail}" style="color:#10B981;text-decoration:none;">${customerEmail}</a>${customerPhone ? ` · <a href="tel:${customerPhone}" style="color:#10B981;text-decoration:none;">${customerPhone}</a>` : ''}</div>
<div style="font-size:12px;color:#6b7280;margin-top:12px;">Responded in ${(responseTimeMs / 1000).toFixed(1)}s</div>
</div>
<div style="background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #2a2a2a;">
<div style="font-size:14px;font-weight:600;color:#10B981;margin-bottom:16px;">CUSTOMER RESPONSES</div>
<table style="width:100%;border-collapse:collapse;">${answersHtml}</table>
</div>
<div style="background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #2a2a2a;">
<div style="font-size:14px;font-weight:600;color:#10B981;margin-bottom:16px;">AI RESPONSE SENT</div>
<div style="font-size:13px;line-height:1.7;color:#d1d5db;">${aiResponse.split('\n').filter(p => p.trim()).map(p => `<p style="margin:0 0 12px 0;">${p}</p>`).join('')}</div>
</div>
<div style="text-align:center;padding:16px 0;"><a href="https://jovilex.com/snaplead/dashboard" style="display:inline-block;padding:12px 28px;background:#10B981;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View in Dashboard</a></div>
<div style="text-align:center;padding:16px 0 0;font-size:11px;color:#4b5563;">SnapLead by <a href="https://jovilex.com" style="color:#10B981;text-decoration:none;">Jovilex</a></div>
</div></body></html>`;
}
