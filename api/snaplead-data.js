// api/snaplead-data.js
// Dashboard data: leads list, stats, update lead status

const {
  requireAuth, setCORS,
  supabaseGet, supabaseGetWithCount, supabaseUpdate
} = require('./_utils');

module.exports = async function handler(req, res) {
  setCORS(res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const auth = requireAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const businessId = auth.payload.id;
  const action = req.query.action || (req.body && req.body.action);

  try {
    // ---- LEADS LIST ----
    if (action === 'leads') {
      const page = parseInt(req.query.page || '1');
      const limit = 20;
      const offset = (page - 1) * limit;
      const status = req.query.status;

      let query = `business_id=eq.${businessId}&order=created_at.desc&offset=${offset}&limit=${limit}&select=*`;
      if (status && status !== 'all') {
        query += `&status=eq.${status}`;
      }

      const { data: leads, total } = await supabaseGetWithCount('snaplead_leads', query);

      return res.status(200).json({
        leads,
        total,
        page,
        pages: Math.ceil(total / limit) || 1
      });
    }

    // ---- STATS ----
    if (action === 'stats') {
      const allLeads = await supabaseGet('snaplead_leads', `business_id=eq.${businessId}&select=status,created_at`);
      const leadsList = Array.isArray(allLeads) ? allLeads : [];
      const totalLeads = leadsList.length;

      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthLeads = leadsList.filter(l => new Date(l.created_at) >= monthStart).length;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayLeads = leadsList.filter(l => new Date(l.created_at) >= todayStart).length;

      const responses = await supabaseGet('snaplead_responses', `business_id=eq.${businessId}&select=response_time_ms`);
      const responsesList = Array.isArray(responses) ? responses : [];
      const avgResponseMs = responsesList.length > 0
        ? responsesList.reduce((sum, r) => sum + r.response_time_ms, 0) / responsesList.length
        : 0;

      const statusCounts = {};
      leadsList.forEach(l => {
        statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
      });

      const converted = (statusCounts.booked || 0) + (statusCounts.won || 0);
      const conversionRate = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : '0.0';

      return res.status(200).json({
        total_leads: totalLeads,
        month_leads: monthLeads,
        today_leads: todayLeads,
        avg_response_ms: Math.round(avgResponseMs),
        avg_response_seconds: (avgResponseMs / 1000).toFixed(1),
        status_breakdown: statusCounts,
        conversion_rate: conversionRate
      });
    }

    // ---- UPDATE LEAD STATUS ----
    if (action === 'update_lead') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { lead_id, status, notes, estimated_value } = req.body;
      if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

      const updates = {};
      if (status) updates.status = status;
      if (notes !== undefined) updates.notes = notes;
      if (estimated_value !== undefined) updates.estimated_value = estimated_value;

      const result = await supabaseUpdate('snaplead_leads', `id=eq.${lead_id}&business_id=eq.${businessId}`, updates);
      if (!result || result.code) return res.status(500).json({ error: 'Failed to update lead' });

      return res.status(200).json({ success: true, lead: result });
    }

    return res.status(400).json({ error: 'Invalid action. Use: leads, stats, update_lead' });
  } catch (err) {
    console.error('snaplead-data error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
