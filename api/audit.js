// /api/audit.js
// ─── Jovilex Automated Audit — Serverless API Route ───
// Receives questionnaire answers, generates AI-powered audit via Claude,
// stores lead in Supabase, emails full report via Resend, returns teaser to frontend.
//
// Environment variables required:
//   ANTHROPIC_API_KEY      — Anthropic API key for Claude
//   RESEND_API_KEY         — Resend API key (already configured for noreply@jovilex.com)
//   SUPABASE_URL           — Jovilex Supabase project URL
//   SUPABASE_SERVICE_KEY   — Supabase service role key (for server-side writes)
//   AUDIT_NOTIFY_EMAIL     — Email to receive lead notifications
//   WEB3FORMS_KEY          — (optional) Web3Forms access key for backup lead capture

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, answers } = req.body;

  if (!name || !email || !answers) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // ── 1. Format answers for Claude ──
    const answerSummary = Object.entries(answers)
      .map(([qId, { label }]) => `${qId}: ${label}`)
      .join('\n');

    // ── 2. Call Claude to generate the audit ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: `You are Jovilex's business audit AI. Jovilex is a global AI-powered services firm that builds digital products, business architecture, AI systems, and human performance infrastructure — at speed conventional firms cannot match.

You are generating a personalised business audit based on a questionnaire. Be specific, actionable, and genuinely useful. Never be generic. Reference their actual answers in your analysis.

Respond ONLY with valid JSON (no markdown, no backticks, no preamble). The JSON structure:

{
  "score": <number 5-50, the overall score>,
  "headline": "<one sentence summary of their situation>",
  "areas": {
    "brand": { "score": <1-10>, "name": "Brand & Digital Presence", "analysis": "<2-3 sentences specific to their answers>", "gap": "<the specific gap>", "impact": "<estimated revenue impact of fixing this>" },
    "acquisition": { "score": <1-10>, "name": "Customer Acquisition", "analysis": "<2-3 sentences>", "gap": "<gap>", "impact": "<impact>" },
    "operations": { "score": <1-10>, "name": "Operations & Systems", "analysis": "<2-3 sentences>", "gap": "<gap>", "impact": "<impact>" },
    "revenue": { "score": <1-10>, "name": "Revenue Infrastructure", "analysis": "<2-3 sentences>", "gap": "<gap>", "impact": "<impact>" },
    "growth": { "score": <1-10>, "name": "Team & Leadership", "analysis": "<2-3 sentences about founder dependency, team capability, delegation maturity, and human capital>", "gap": "<gap>", "impact": "<impact>" }
  },
  "topGaps": ["<gap 1>", "<gap 2>", "<gap 3>"],
  "weakestAreaKey": "<the key from areas with the lowest score>",
  "recommendation": "<one specific, actionable recommendation for their weakest area — 2-3 sentences>",
  "closingLine": "<a motivating one-liner specific to their situation>"
}

Scoring guide:
- 1-3: Critical gap, actively losing money or opportunity
- 4-5: Below where it needs to be, clear fix available
- 6-7: Functional but not optimised
- 8-9: Strong, minor refinements
- 10: Operating at high level

Be honest. A business with no website, manual payments, and no customer acquisition system should score in the 15-25 range. A well-run business with some gaps might be 30-40. Do not inflate scores.

The overall score is the sum of the five area scores.

For revenue impact estimates, be realistic and specific. Reference percentages or time savings. Example: "Fixing this could recover 10-15 hours per week currently lost to manual processes" or "A professional website converting at even 2% would mean 5-10 new enquiries per month from existing traffic."

Tone: Direct, confident, warm. Like a sharp consultant who sees the full picture and tells the truth. No jargon. No fluff. The person reading this should feel like someone finally understood their business and told them exactly what to do.`,
        messages: [{
          role: 'user',
          content: `Business audit questionnaire answers for ${name}:\n\n${answerSummary}`
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

    // Parse JSON (strip any accidental markdown fences)
    const cleanText = rawText.replace(/```json\s*|```\s*/g, '').trim();
    const audit = JSON.parse(cleanText);

    // ── 3. Store lead in Supabase ──
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
        // Don't fail the whole request if DB write fails
      }
    }

    // ── 4. Send full report email via Resend ──
    if (process.env.RESEND_API_KEY) {
      const emailHtml = buildReportEmail(audit, name);

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Jovilex <noreply@jovilex.com>',
          to: [email],
          subject: `Your Business Audit: ${audit.score}/50 — ${audit.headline}`,
          html: emailHtml
        })
      });
    }

    // ── 5. Notify Ken of new lead ──
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
          subject: `New Audit Lead: ${name} (${audit.score}/50)`,
          html: buildLeadNotification(audit, name, email, answers)
        })
      });
    }

    // ── 6. Web3Forms backup (optional) ──
    if (process.env.WEB3FORMS_KEY) {
      fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key: process.env.WEB3FORMS_KEY,
          subject: `Audit Lead: ${name} — ${audit.score}/50`,
          from_name: 'Jovilex Audit',
          name,
          email,
          score: audit.score,
          weakest_area: audit.areas[audit.weakestAreaKey]?.name || 'Unknown',
          answers: JSON.stringify(answers, null, 2)
        })
      }).catch(err => console.error('Web3Forms error:', err));
    }

    // ── 7. Return teaser to frontend ──
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


// ─── Email Templates ───

function buildReportEmail(audit, name) {
  const areaRows = Object.values(audit.areas).map(area => {
    const pct = area.score * 10;
    const color = area.score <= 4 ? '#FF7A2E' : area.score <= 6 ? '#F59E0B' : '#10B981';
    return `
    <tr>
      <td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;font-weight:600;color:#FFFFFF;padding-bottom:4px;">
              ${area.name}
              <span style="float:right;color:${color};font-size:14px;">${area.score}/10</span>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#1F2937;border-radius:3px;height:6px;">
                    <div style="background:${color};width:${pct}%;height:6px;border-radius:3px;"></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:#9CA3AF;line-height:1.5;">
              ${area.analysis}
            </td>
          </tr>
          <tr>
            <td style="padding-top:8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#FF7A2E;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;padding-right:8px;">Gap:</td>
                  <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#D1D5DB;">${area.gap}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:4px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#10B981;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;padding-right:8px;">Impact:</td>
                  <td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#D1D5DB;">${area.impact}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const gapsList = audit.topGaps.map((gap, i) =>
    `<tr><td style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:#FFFFFF;padding:6px 0;line-height:1.5;"><span style="color:#FF7A2E;font-weight:600;">${i + 1}.</span> ${gap}</td></tr>`
  ).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111111;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

          <!-- Header -->
          <tr>
            <td style="text-align:center;padding-bottom:32px;">
              <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-weight:800;font-size:24px;">
                <span style="color:#FFFFFF;">Jovi</span><span style="color:#10B981;">lex</span>
              </span>
              <br>
              <span style="font-size:11px;color:#6B7280;letter-spacing:1.5px;text-transform:uppercase;">Business Audit Report</span>
            </td>
          </tr>

          <!-- Score -->
          <tr>
            <td style="text-align:center;padding-bottom:24px;">
              <div style="display:inline-block;background:#1A1A1A;border:2px solid #1F2937;border-radius:16px;padding:24px 40px;">
                <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:48px;font-weight:800;color:${audit.score <= 20 ? '#FF7A2E' : audit.score <= 35 ? '#F59E0B' : '#10B981'};">${audit.score}</span>
                <span style="font-size:18px;color:#6B7280;font-weight:300;">/50</span>
                <br>
                <span style="font-size:13px;color:#9CA3AF;">${audit.headline}</span>
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="font-size:16px;color:#D1D5DB;line-height:1.6;padding:0 4px 24px;">
              ${name}, here is your full business audit. Below are your scores across five areas, the gaps we identified, and what fixing each one could mean for your revenue.
            </td>
          </tr>

          <!-- Area Scores -->
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A1A1A;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
                    <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#10B981;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Score Breakdown</span>
                  </td>
                </tr>
                ${areaRows}
              </table>
            </td>
          </tr>

          <!-- Top 3 Gaps -->
          <tr>
            <td style="padding-top:24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A1A1A;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #1F2937;">
                    <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#FF7A2E;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Top 3 Gaps to Close</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      ${gapsList}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Key Recommendation -->
          <tr>
            <td style="padding-top:24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);border-radius:12px;">
                <tr>
                  <td style="padding:20px;">
                    <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#10B981;font-weight:600;letter-spacing:1px;text-transform:uppercase;">What to do first</span>
                    <p style="font-size:15px;color:#D1D5DB;line-height:1.6;margin:8px 0 0;">${audit.recommendation}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="text-align:center;padding:32px 0;">
              <a href="https://jovilex.com" style="display:inline-block;background:#FF7A2E;color:#111111;font-family:'Helvetica Neue',Arial,sans-serif;font-weight:600;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                Want us to close these gaps? Let's talk.
              </a>
              <br>
              <a href="https://jovilex.com" style="font-size:13px;color:#6B7280;text-decoration:none;display:inline-block;padding-top:12px;">jovilex.com</a>
            </td>
          </tr>

          <!-- Closing -->
          <tr>
            <td style="text-align:center;font-size:14px;color:#9CA3AF;line-height:1.5;padding-bottom:24px;font-style:italic;">
              "${audit.closingLine}"
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="text-align:center;border-top:1px solid #1F2937;padding-top:20px;">
              <span style="font-size:11px;color:#6B7280;">
                Jovilex · Global Digital Services & Business Architecture<br>
                Jovilex · jovilex.com
              </span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}


function buildLeadNotification(audit, name, email, answers) {
  const answerLines = Object.entries(answers)
    .map(([qId, { label }]) => `<strong>${qId}:</strong> ${label}`)
    .join('<br>');

  const areaLines = Object.values(audit.areas)
    .map(a => `${a.name}: ${a.score}/10`)
    .join('<br>');

  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;color:#D1D5DB;">
  <h2 style="color:#10B981;font-size:18px;">New Audit Lead</h2>
  <p><strong style="color:#FFFFFF;">Name:</strong> ${name}<br>
  <strong style="color:#FFFFFF;">Email:</strong> ${email}<br>
  <strong style="color:#FFFFFF;">Score:</strong> ${audit.score}/50</p>

  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Area Scores</h3>
  <p style="font-size:14px;line-height:1.8;">${areaLines}</p>

  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Top Gaps</h3>
  <p style="font-size:14px;line-height:1.8;">${audit.topGaps.join('<br>')}</p>

  <h3 style="color:#FF7A2E;font-size:14px;margin-top:20px;">Their Answers</h3>
  <p style="font-size:13px;line-height:1.8;">${answerLines}</p>

  <p style="margin-top:24px;font-size:12px;color:#6B7280;">Jovilex Audit System · Automated notification</p>
</body>
</html>`;
}
