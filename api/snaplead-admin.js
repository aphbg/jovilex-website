// api/snaplead-admin.js
// Partner management admin API

const { setCORS, supabaseGet, supabaseInsert, supabaseUpdate, sanitize, isValidEmail } = require('./_utils');

const ADMIN_PASSWORD = 'snaplead2026';

module.exports = async function handler(req, res) {
  setCORS(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, password } = req.body;

  // Simple password auth
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  try {
    // ---- LIST PARTNERS ----
    if (action === 'list_partners') {
      const partners = await supabaseGet('snaplead_partners', 'select=*&order=created_at.desc');

      // Get attribution stats for each partner
      const enriched = [];
      for (const p of (partners || [])) {
        const clients = await supabaseGet(
          'snaplead_businesses',
          `referred_by=eq.${encodeURIComponent(p.code)}&select=id,business_name,plan,status,created_at`
        );
        const clientList = clients || [];
        const paid = clientList.filter(c => c.status === 'active' && c.plan !== 'trial');
        const trials = clientList.filter(c => c.plan === 'trial' || c.status === 'trial');

        const PRICES = { starter: 199, growth: 499, scale: 999 };
        const rate = p.commission_rate / 100;
        const monthlyCommission = paid.reduce((sum, c) => sum + (PRICES[c.plan] || 0) * rate, 0);

        enriched.push({
          ...p,
          total_clients: clientList.length,
          paid_clients: paid.length,
          trial_clients: trials.length,
          monthly_commission: monthlyCommission,
          clients: clientList
        });
      }

      return res.status(200).json({ success: true, partners: enriched });
    }

    // ---- CREATE PARTNER ----
    if (action === 'create_partner') {
      const { name, email, code, territory, phone, notes, commission_rate } = req.body;

      if (!name || !email || !code || !territory) {
        return res.status(400).json({ error: 'Name, email, code, and territory are required' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      // Check code uniqueness
      const existing = await supabaseGet('snaplead_partners', `code=eq.${encodeURIComponent(code)}&select=id&limit=1`);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'This partner code already exists' });
      }

      const partner = await supabaseInsert('snaplead_partners', {
        name: sanitize(name),
        email: sanitize(email).toLowerCase(),
        code: sanitize(code).toLowerCase().replace(/[^a-z0-9-]/g, ''),
        territory: sanitize(territory),
        phone: phone ? sanitize(phone) : null,
        notes: notes ? sanitize(notes) : null,
        commission_rate: commission_rate || 15.00,
        status: 'active'
      });

      if (!partner || partner.code) {
        return res.status(500).json({ error: 'Failed to create partner' });
      }

      // Send welcome email via Resend
      const partnerCode = partner.code || sanitize(code).toLowerCase().replace(/[^a-z0-9-]/g, '');
      const signupLink = `https://snaplead.jovilex.com/signup?ref=${partnerCode}`;
      const dashboardLink = `https://snaplead.jovilex.com/partner?code=${partnerCode}`;
      const commRate = commission_rate || 15;

      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
          },
          body: JSON.stringify({
            from: 'SnapLead <noreply@jovilex.com>',
            to: [sanitize(email).toLowerCase()],
            subject: `Welcome to SnapLead — You're now a Market Partner`,
            html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 16px;">
<div style="background:#111111;border-radius:12px;overflow:hidden;">
  <div style="padding:32px 28px;">
    <div style="margin-bottom:24px;">
      <span style="font-size:20px;font-weight:800;color:#ffffff;">Snap</span><span style="font-size:20px;font-weight:800;color:#10B981;">Lead</span>
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;">Welcome aboard, ${sanitize(name).split(' ')[0]}</h1>
    <p style="font-size:14px;color:#9ca3af;margin:0 0 28px;line-height:1.6;">You're now a SnapLead Market Partner for <strong style="color:#ffffff;">${sanitize(territory)}</strong>. Everything you need to get started is below.</p>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your referral code</div>
      <div style="font-size:24px;font-weight:800;color:#ffffff;font-family:monospace;letter-spacing:2px;">${partnerCode}</div>
    </div>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your signup link</div>
      <p style="font-size:13px;color:#9ca3af;margin:0 0 8px;line-height:1.5;">Share this with businesses. Every signup through this link is permanently attributed to you.</p>
      <a href="${signupLink}" style="display:block;font-size:13px;color:#10B981;word-break:break-all;text-decoration:none;">${signupLink}</a>
    </div>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your partner dashboard</div>
      <p style="font-size:13px;color:#9ca3af;margin:0 0 8px;line-height:1.5;">Track your attributed clients, their plan status, and your commission in real time.</p>
      <a href="${dashboardLink}" style="display:block;font-size:13px;color:#10B981;word-break:break-all;text-decoration:none;">${dashboardLink}</a>
    </div>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Commission structure</div>
      <div style="display:flex;gap:16px;">
        <div style="flex:1;text-align:center;"><div style="font-size:28px;font-weight:800;color:#ffffff;">${commRate}%</div><div style="font-size:11px;color:#6b7280;">recurring commission</div></div>
        <div style="flex:1;text-align:center;"><div style="font-size:28px;font-weight:800;color:#ffffff;">20%</div><div style="font-size:11px;color:#6b7280;">at 10+ active clients</div></div>
      </div>
      <p style="font-size:12px;color:#6b7280;margin:12px 0 0;line-height:1.5;">Commission is earned on paid subscriptions only, calculated monthly, and paid within 15 business days of month-end. Plans range from $199/mo to $999/mo.</p>
    </div>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Quick start — how to get your first client</div>
      <div style="margin-bottom:10px;"><span style="display:inline-block;width:22px;height:22px;background:#10B981;color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;margin-right:8px;">1</span><span style="font-size:13px;color:#d1d5db;">Identify a local business (dental, home services, law firm, med spa, or any service business)</span></div>
      <div style="margin-bottom:10px;"><span style="display:inline-block;width:22px;height:22px;background:#10B981;color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;margin-right:8px;">2</span><span style="font-size:13px;color:#d1d5db;">Pull up the demo on your phone — show them the AI response in real time</span></div>
      <div style="margin-bottom:10px;"><span style="display:inline-block;width:22px;height:22px;background:#10B981;color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;margin-right:8px;">3</span><span style="font-size:13px;color:#d1d5db;">Send them your signup link — 14-day free trial, no card required</span></div>
      <div><span style="display:inline-block;width:22px;height:22px;background:#10B981;color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;margin-right:8px;">4</span><span style="font-size:13px;color:#d1d5db;">Check your partner dashboard — their signup appears instantly</span></div>
    </div>

    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;">
      <div style="font-size:11px;font-weight:600;color:#10B981;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Demo pages — bookmark these on your phone</div>
      <p style="margin:0 0 6px;"><a href="https://snaplead.jovilex.com/for/dental" style="font-size:13px;color:#10B981;text-decoration:none;">snaplead.jovilex.com/for/dental</a> <span style="font-size:11px;color:#6b7280;">— dental practices</span></p>
      <p style="margin:0 0 6px;"><a href="https://snaplead.jovilex.com/for/home-services" style="font-size:13px;color:#10B981;text-decoration:none;">snaplead.jovilex.com/for/home-services</a> <span style="font-size:11px;color:#6b7280;">— contractors</span></p>
      <p style="margin:0 0 6px;"><a href="https://snaplead.jovilex.com/for/legal" style="font-size:13px;color:#10B981;text-decoration:none;">snaplead.jovilex.com/for/legal</a> <span style="font-size:11px;color:#6b7280;">— law firms</span></p>
      <p style="margin:0;"><a href="https://snaplead.jovilex.com/for/medspa" style="font-size:13px;color:#10B981;text-decoration:none;">snaplead.jovilex.com/for/medspa</a> <span style="font-size:11px;color:#6b7280;">— med spas</span></p>
    </div>
  </div>
  <div style="padding:16px 28px;border-top:1px solid #2a2a2a;">
    <p style="font-size:12px;color:#6b7280;margin:0;line-height:1.5;">Questions? Reply to this email. We're here to help you succeed.</p>
  </div>
</div>
<div style="text-align:center;padding:20px;">
  <p style="font-size:11px;color:#9ca3af;margin:0;">SnapLead by Jovilex &middot; Komir Holdings</p>
</div>
</div>
</body></html>`
          })
        });
      } catch (emailErr) {
        console.error('Partner welcome email error:', emailErr);
        // Don't fail the create — partner is already saved
      }

      return res.status(200).json({ success: true, partner });
    }

    // ---- UPDATE PARTNER ----
    if (action === 'update_partner') {
      const { partner_id, updates } = req.body;
      if (!partner_id || !updates) {
        return res.status(400).json({ error: 'partner_id and updates required' });
      }

      const allowed = ['name', 'email', 'territory', 'phone', 'notes', 'commission_rate', 'status'];
      const clean = {};
      for (const key of allowed) {
        if (updates[key] !== undefined) {
          clean[key] = typeof updates[key] === 'string' ? sanitize(updates[key]) : updates[key];
        }
      }
      clean.updated_at = new Date().toISOString();

      const result = await supabaseUpdate('snaplead_partners', `id=eq.${partner_id}`, clean);
      if (!result || result.code) {
        return res.status(500).json({ error: 'Failed to update partner' });
      }

      return res.status(200).json({ success: true, partner: result });
    }

    // ---- DELETE PARTNER ----
    if (action === 'delete_partner') {
      const { partner_id } = req.body;
      if (!partner_id) return res.status(400).json({ error: 'partner_id required' });

      // Soft delete — just suspend
      const result = await supabaseUpdate('snaplead_partners', `id=eq.${partner_id}`, {
        status: 'suspended',
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('snaplead-admin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
