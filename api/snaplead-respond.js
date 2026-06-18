// api/snaplead-respond.js
// Core engine: receive lead → Claude AI response → email to customer → notify business → store

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    const { business_slug, customer_name, customer_email, customer_phone, answers, source } = req.body;

    if (!business_slug || !customer_name || !customer_email) {
      return res.status(400).json({ error: 'Missing required fields: business_slug, customer_name, customer_email' });
    }

    // 1. Fetch business config
    const { data: business, error: bizErr } = await supabase
      .from('snaplead_businesses')
      .select('*')
      .eq('business_slug', business_slug)
      .single();

    if (bizErr || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Check if business is active or on trial
    if (business.status === 'cancelled' || business.status === 'paused') {
      return res.status(403).json({ error: 'This business account is not active' });
    }

    // Check trial expiry
    if (business.plan === 'trial' && new Date(business.trial_ends_at) < new Date()) {
      return res.status(403).json({ error: 'Trial has expired' });
    }

    // 2. Fetch industry template for system prompt
    const { data: template } = await supabase
      .from('snaplead_templates')
      .select('system_prompt')
      .eq('industry_key', business.industry)
      .single();

    // 3. Build the prompt
    const systemPrompt = (template?.system_prompt || '')
      .replace(/\{\{business_name\}\}/g, business.business_name)
      .replace(/\{\{industry_description\}\}/g, business.business_description || business.industry);

    // Format answers for Claude
    const questions = business.custom_questions || [];
    let answersText = '';
    if (answers && typeof answers === 'object') {
      for (const [key, value] of Object.entries(answers)) {
        const question = questions.find(q => q.id === key);
        const label = question ? question.label : key;
        answersText += `${label}: ${value}\n`;
      }
    }

    // Determine urgency from answers
    let urgency = 'medium';
    const urgencyAnswer = answers?.urgency || answers?.visit_reason || '';
    if (urgencyAnswer.toLowerCase().includes('emergency') || urgencyAnswer.toLowerCase().includes('urgent')) {
      urgency = 'emergency';
    } else if (urgencyAnswer.toLowerCase().includes('today') || urgencyAnswer.toLowerCase().includes('immediately')) {
      urgency = 'high';
    } else if (urgencyAnswer.toLowerCase().includes('just') || urgencyAnswer.toLowerCase().includes('exploring') || urgencyAnswer.toLowerCase().includes('getting quotes')) {
      urgency = 'low';
    }

    const userMessage = `New lead from ${customer_name} (${customer_email}${customer_phone ? ', ' + customer_phone : ''}).

Their responses:
${answersText}

Write a personalised response to this potential customer.`;

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
    const { data: lead, error: leadErr } = await supabase
      .from('snaplead_leads')
      .insert({
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
      })
      .select()
      .single();

    if (leadErr) {
      console.error('Lead insert error:', leadErr);
      return res.status(500).json({ error: 'Failed to store lead' });
    }

    // 6. Log the response
    await supabase.from('snaplead_responses').insert({
      lead_id: lead.id,
      business_id: business.id,
      response_time_ms: responseTimeMs,
      tokens_used: tokensUsed,
      delivery_method: 'email',
      delivered: true,
      cost_cents: Math.ceil(tokensUsed * 0.003 * 100) // approximate cost tracking
    });

    // 7. Update business lead counts
    await supabase
      .from('snaplead_businesses')
      .update({
        monthly_leads: (business.monthly_leads || 0) + 1,
        total_leads: (business.total_leads || 0) + 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', business.id);

    // 8. Send email to customer
    const customerEmailHtml = buildCustomerEmail(business.business_name, customer_name, aiText, business.logo_url);

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: `SnapLead <noreply@jovilex.com>`,
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
    console.error('SnapLead error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}


// --- Email templates ---

function buildCustomerEmail(businessName, customerName, aiResponse, logoUrl) {
  const firstName = customerName.split(' ')[0];
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:580px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border-radius:12px;padding:36px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      ${logoUrl ? `<img src="${logoUrl}" alt="${businessName}" style="height:40px;margin-bottom:24px;">` : `<div style="font-size:20px;font-weight:700;color:#111111;margin-bottom:24px;">${businessName}</div>`}
      <div style="font-size:15px;line-height:1.7;color:#1f2937;">
        ${aiResponse.split('\n').filter(p => p.trim()).map(p => `<p style="margin:0 0 16px 0;">${p}</p>`).join('')}
      </div>
    </div>
    <div style="text-align:center;padding:24px 0 0;font-size:11px;color:#9ca3af;">
      Powered by <a href="https://jovilex.com" style="color:#10B981;text-decoration:none;">SnapLead</a> · AI-powered lead response
    </div>
  </div>
</body>
</html>`;
}


function buildNotificationEmail(businessName, customerName, customerEmail, customerPhone, answers, questions, urgency, aiResponse, responseTimeMs) {
  const urgencyColors = {
    emergency: '#dc2626',
    high: '#f59e0b',
    medium: '#10B981',
    low: '#6b7280'
  };
  const urgencyLabels = {
    emergency: '🚨 EMERGENCY',
    high: '⚡ HIGH',
    medium: '● MEDIUM',
    low: '○ LOW'
  };

  let answersHtml = '';
  if (answers && typeof answers === 'object') {
    for (const [key, value] of Object.entries(answers)) {
      const question = questions.find(q => q.id === key);
      const label = question ? question.label : key;
      answersHtml += `<tr><td style="padding:8px 12px;font-size:13px;color:#6b7280;border-bottom:1px solid #f3f4f6;width:40%;">${label}</td><td style="padding:8px 12px;font-size:13px;color:#111111;font-weight:500;border-bottom:1px solid #f3f4f6;">${value}</td></tr>`;
    }
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:580px;margin:0 auto;padding:32px 20px;">
    <div style="background:#1a1a1a;border-radius:12px;padding:28px 24px;margin-bottom:16px;border:1px solid #2a2a2a;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div style="font-size:18px;font-weight:700;color:#ffffff;">New Lead</div>
        <div style="font-size:12px;font-weight:600;color:${urgencyColors[urgency]};background:${urgencyColors[urgency]}15;padding:4px 10px;border-radius:20px;">${urgencyLabels[urgency]}</div>
      </div>
      <div style="font-size:22px;font-weight:700;color:#ffffff;margin-bottom:4px;">${customerName}</div>
      <div style="font-size:14px;color:#9ca3af;margin-bottom:4px;">
        <a href="mailto:${customerEmail}" style="color:#10B981;text-decoration:none;">${customerEmail}</a>
        ${customerPhone ? ` · <a href="tel:${customerPhone}" style="color:#10B981;text-decoration:none;">${customerPhone}</a>` : ''}
      </div>
      <div style="font-size:12px;color:#6b7280;margin-top:12px;">Responded in ${(responseTimeMs / 1000).toFixed(1)}s · AI-powered</div>
    </div>

    <div style="background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #2a2a2a;">
      <div style="font-size:14px;font-weight:600;color:#10B981;margin-bottom:16px;">CUSTOMER RESPONSES</div>
      <table style="width:100%;border-collapse:collapse;">${answersHtml}</table>
    </div>

    <div style="background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #2a2a2a;">
      <div style="font-size:14px;font-weight:600;color:#10B981;margin-bottom:16px;">AI RESPONSE SENT</div>
      <div style="font-size:13px;line-height:1.7;color:#d1d5db;">
        ${aiResponse.split('\n').filter(p => p.trim()).map(p => `<p style="margin:0 0 12px 0;">${p}</p>`).join('')}
      </div>
    </div>

    <div style="text-align:center;padding:16px 0;">
      <a href="https://jovilex.com/snaplead/dashboard" style="display:inline-block;padding:12px 28px;background:#10B981;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View in Dashboard</a>
    </div>

    <div style="text-align:center;padding:16px 0 0;font-size:11px;color:#4b5563;">
      SnapLead by <a href="https://jovilex.com" style="color:#10B981;text-decoration:none;">Jovilex</a>
    </div>
  </div>
</body>
</html>`;
}
