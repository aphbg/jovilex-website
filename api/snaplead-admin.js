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
