// /api/audit.js
// Jovilex Automated Audit — Serverless API Route
// Environment variables: ANTHROPIC_API_KEY, RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, AUDIT_NOTIFY_EMAIL

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, business, offering, revenue, industry, email, answers } = req.body;

  if (!name || !business || !email || !answers) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const answerSummary = Object.entries(answers)
      .map(([qId, { label }]) => `${qId}: ${label}`)
      .join('\n');

    // ── 1. Call Claude ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        system: `You are a senior business consultant generating a personalised audit report for Jovilex, a global AI-powered services firm. You operate at the standard of McKinsey, Bain, or a world-class strategy firm — but you write like a sharp operator, not an academic.

You are auditing a specific business. Use the business name, industry, offering type, and revenue range throughout your analysis. Address the business as the subject and the person as the reader. Example: "FleetBridge is currently relying on word of mouth" not "You are relying on word of mouth."

The questionnaire covers ten diagnostic areas. Cross-reference answers to find the real problem, not just the surface symptoms. For example: if someone has multiple channels but no conversion process, the problem is not discovery — it is the gap between interest and payment. If someone has invested in tools but operations still run in their head, the problem is not the tools — it is the lack of a system connecting them. If someone tried hiring but the bottleneck is still delivery, the hire was not the right hire or was not managed.

Respond ONLY with valid JSON (no markdown, no backticks, no preamble):

{
  "score": <number 5-50>,
  "headline": "<one sentence about this specific business — use the business name>",
  "areas": {
    "brand": { "score": <1-10>, "name": "Brand & Digital Presence", "analysis": "<2-3 sentences referencing their specific online presence and discovery answers>", "gap": "<the specific gap for this business>", "impact": "<revenue impact calibrated to their revenue range and industry>" },
    "acquisition": { "score": <1-10>, "name": "Customer Acquisition", "analysis": "<2-3 sentences — cross-reference discovery channels with conversion process>", "gap": "<gap>", "impact": "<impact>" },
    "operations": { "score": <1-10>, "name": "Operations & Systems", "analysis": "<2-3 sentences — cross-reference operations tools with admin time and what they have tried>", "gap": "<gap>", "impact": "<impact>" },
    "revenue": { "score": <1-10>, "name": "Revenue Infrastructure", "analysis": "<2-3 sentences — cross-reference payment handling with conversion process>", "gap": "<gap>", "impact": "<impact>" },
    "growth": { "score": <1-10>, "name": "Team & Leadership", "analysis": "<2-3 sentences — cross-reference founder dependency with bottleneck and what they have tried>", "gap": "<gap>", "impact": "<impact>" }
  },
  "topGaps": ["<gap 1>", "<gap 2>", "<gap 3>"],
  "weakestAreaKey": "<key from areas with lowest score>",
  "recommendation": "<one specific, actionable first move for their weakest area — 2-3 sentences, referencing their business name and industry>",
  "closingLine": "<a motivating one-liner specific to this business>"
}

Scoring:
- 1-3: Critical gap, actively losing money
- 4-5: Below where it should be, clear fix available
- 6-7: Functional but not optimised
- 8-9: Strong, minor refinements
- 10: Operating at a high level

Be honest. Do not inflate. The overall score is the sum of the five area scores.

Revenue impact estimates must be calibrated to their actual revenue range and industry. A pre-revenue business gets time-based estimates. A $50k+/mo business gets percentage and dollar estimates. Be specific — not "significant improvement" but "recovering 10-15 hours per week" or "converting even 2% more interest would add $X/month at your current volume."

Tone: A senior partner who has seen a hundred businesses like this one and knows exactly what to fix first. Direct. Confident. Warm. No jargon. No filler. Every sentence earns its place.`,
        messages: [{
          role: 'user',
          content: `Audit for ${business}

Person: ${name}
Business: ${business}
Offering: ${offering || 'Not specified'}
Revenue: ${revenue || 'Not specified'}
Industry: ${industry || 'Not specified'}

Questionnaire answers:
${answerSummary}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', errText);
      throw new Error('Claude API failed');
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content
      .map(block => block.text || '')
      .filter(Boolean)
      .join('');

    const cleanText = rawText.replace(/```json\s*|```\s*/g, '').trim();
    const audit = JSON.parse(cleanText);

    // ── 2. Store in Supabase ──
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/audit_leads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            name,
            email,
            business_name: business,
            offering,
            revenue_range: revenue,
            industry,
            answers,
            score: audit.score,
            headline: audit.headline,
            area_scores: audit.areas,
            top_gaps: audit.topGaps,
            weakest_area: audit.areas[audit.weakestAreaKey]?.name || null,
            weakest_score: audit.areas[audit.weakestAreaKey]?.score || null,
            recommendation: audit.recommendation,
            status: 'new'
          })
        });
      } catch (dbErr) {
        console.error('Supabase write error:', dbErr);
      }
    }

    // ── 3. Send report email ──
    if (process.env.RESEND_API_KEY) {
      const emailHtml = buildReportEmail(audit, name, business);
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Jovilex <noreply@jovilex.com>',
          to: [email],
          subject: `${business} — Your Business Audit — ${audit.score}/50`,
          html: emailHtml
        })
      });
    }

    // ── 4. Notify Ken ──
    const notifyEmail = process.env.AUDIT_NOTIFY_EMAIL;
    if (process.env.RESEND_API_KEY && notifyEmail) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Jovilex Audit <noreply@jovilex.com>',
          to: [notifyEmail],
          subject: `New Audit Lead: ${business} — ${name} (${audit.score}/50)`,
          html: buildLeadNotification(audit, name, business, offering, revenue, industry, email, answers)
        })
      });
    }

    // ── 5. Return teaser ──
    const weakArea = audit.areas[audit.weakestAreaKey];
    return res.status(200).json({
      score: audit.score,
      weakestArea: weakArea?.name || 'Operations & Systems',
      weakestScore: weakArea?.score || 4,
      recommendation: `<strong>Recommendation:</strong> ${audit.recommendation}`
    });

  } catch (error) {
    console.error('Audit API error:', error);
    return res.status(500).json({ error: 'Failed to generate audit' });
  }
}


function buildReportEmail(audit, name, business) {
  const areaRows = Object.values(audit.areas).map(area => {
    const pct = area.score * 10;
    const color = area.score <= 4 ? '#FF7A2E' : area.score <= 6 ? '#F59E0B' : '#10B981';
    return `
    <tr><td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;font-weight:600;color:#FFFFFF;padding-bottom:4px;">
          ${area.name}<span style="float:right;color:${color};font-size:14px;">${area.score}/10</span>
        </td></tr>
        <tr><td style="padding-bottom:8px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#1F2937;border-radius:3px;height:6px;">
              <div style="background:${color};width:${pct}%;height:6px;border-radius:3px;"></div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:#9CA3AF;line-height:1.5;">${area.analysis}</td></tr>
        <tr><td style="padding-top:8px;">
          <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#FF7A2E;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;">Gap:</span>
          <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#D1D5DB;margin-left:6px;">${area.gap}</span>
        </td></tr>
        <tr><td style="padding-top:4px;">
          <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#10B981;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;">Impact:</span>
          <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#D1D5DB;margin-left:6px;">${area.impact}</span>
        </td></tr>
      </table>
    </td></tr>`;
  }).join('');

  const gapsList = audit.topGaps.map((gap, i) =>
    `<tr><td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:#FFFFFF;padding:6px 0;line-height:1.5;"><span style="color:#FF7A2E;font-weight:600;">${i + 1}.</span> ${gap}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111111;"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

<tr><td style="text-align:center;padding-bottom:32px;">
  <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-weight:800;font-size:24px;">
    <span style="color:#FFFFFF;">Jovi</span><span style="color:#10B981;">lex</span>
  </span><br>
  <span style="font-size:11px;color:#6B7280;letter-spacing:1.5px;text-transform:uppercase;">Business Audit Report</span>
</td></tr>

<tr><td style="text-align:center;padding-bottom:24px;">
  <div style="display:inline-block;background:#1A1A1A;border:2px solid #1F2937;border-radius:16px;padding:24px 40px;">
    <span style="font-size:48px;font-weight:800;color:${audit.score <= 20 ? '#FF7A2E' : audit.score <= 35 ? '#F59E0B' : '#10B981'};">${audit.score}</span>
    <span style="font-size:18px;color:#6B7280;font-weight:300;">/50</span><br>
    <span style="font-size:13px;color:#9CA3AF;">${audit.headline}</span>
  </div>
</td></tr>

<tr><td style="font-size:16px;color:#D1D5DB;line-height:1.6;padding:0 4px 24px;">
  ${name}, here is the full audit for <strong style="color:#FFFFFF;">${business}</strong>. Below are scores across five areas, the gaps identified, and what fixing each one could mean for your revenue.
</td></tr>

<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A1A1A;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
      <span style="font-size:12px;color:#10B981;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Score Breakdown</span>
    </td></tr>
    ${areaRows}
  </table>
</td></tr>

<tr><td style="padding-top:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A1A1A;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
      <span style="font-size:12px;color:#FF7A2E;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Top 3 Gaps to Close</span>
    </td></tr>
    <tr><td style="padding:16px 20px;"><table cellpadding="0" cellspacing="0" border="0">${gapsList}</table></td></tr>
  </table>
</td></tr>

<tr><td style="padding-top:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);border-radius:12px;">
    <tr><td style="padding:20px;">
      <span style="font-size:12px;color:#10B981;font-weight:600;letter-spacing:1px;text-transform:uppercase;">What to do first</span>
      <p style="font-size:15px;color:#D1D5DB;line-height:1.6;margin:8px 0 0;">${audit.recommendation}</p>
    </td></tr>
  </table>
</td></tr>

<tr><td style="text-align:center;padding:32px 0;">
  <a href="https://jovilex.com/contact" style="display:inline-block;background:#FF7A2E;color:#111111;font-weight:600;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;">
    Let's fix this — get in touch
  </a><br>
  <a href="https://jovilex.com" style="font-size:13px;color:#6B7280;text-decoration:none;display:inline-block;padding-top:12px;">jovilex.com</a>
</td></tr>

<tr><td style="text-align:center;font-size:14px;color:#9CA3AF;line-height:1.5;padding-bottom:24px;font-style:italic;">
  "${audit.closingLine}"
</td></tr>

<tr><td style="text-align:center;border-top:1px solid #1F2937;padding-top:20px;">
  <span style="font-size:11px;color:#6B7280;">Jovilex · Global Digital Services & Business Architecture · jovilex.com</span>
</td></tr>

</table></td></tr></table></body></html>`;
}


function buildLeadNotification(audit, name, business, offering, revenue, industry, email, answers) {
  const answerLines = Object.entries(answers)
    .map(([qId, { label }]) => `<strong>${qId}:</strong> ${label}`)
    .join('<br>');

  const areaLines = Object.values(audit.areas)
    .map(a => `${a.name}: ${a.score}/10`)
    .join('<br>');

  return `<!DOCTYPE html><html>
<body style="margin:0;padding:24px;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;color:#D1D5DB;">
  <h2 style="color:#10B981;font-size:18px;">New Audit Lead</h2>
  <p><strong style="color:#FFFFFF;">Name:</strong> ${name}<br>
  <strong style="color:#FFFFFF;">Business:</strong> ${business}<br>
  <strong style="color:#FFFFFF;">Email:</strong> ${email}<br>
  <strong style="color:#FFFFFF;">Offering:</strong> ${offering || 'Not specified'}<br>
  <strong style="color:#FFFFFF;">Revenue:</strong> ${revenue || 'Not specified'}<br>
  <strong style="color:#FFFFFF;">Industry:</strong> ${industry || 'Not specified'}<br>
  <strong style="color:#FFFFFF;">Score:</strong> ${audit.score}/50</p>
  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Area Scores</h3>
  <p style="font-size:14px;line-height:1.8;">${areaLines}</p>
  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Top Gaps</h3>
  <p style="font-size:14px;line-height:1.8;">${audit.topGaps.join('<br>')}</p>
  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Their Answers</h3>
  <p style="font-size:13px;line-height:1.8;">${answerLines}</p>
  <p style="margin-top:24px;font-size:12px;color:#6B7280;">Jovilex Audit System</p>
</body></html>`;
}
