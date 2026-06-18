// api/snaplead-data.js
// Dashboard data: leads list, stats, analytics
// Uses Supabase REST API directly — no client library needed

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function supabaseGet(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const countHeader = resp.headers.get('content-range');
  const data = await resp.json();
  let total = null;
  if (countHeader) {
    const match = countHeader.match(/\/(\d+)/);
    if (match) total = parseInt(match[1]);
  }
  return { data, total };
}

async function supabaseUpdate(table, query, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const payload = verifyToken(authHeader.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  const businessId = payload.id;
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

      // Use Prefer header for count
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/snaplead_leads?${query}`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'count=exact'
        }
      });

      const countHeader = resp.headers.get('content-range');
      const leads = await resp.json();
      let total = 0;
      if (countHeader) {
        const match = countHeader.match(/\/(\d+|\*)/);
        if (match && match[1] !== '*') total = parseInt(match[1]);
      }

      return res.status(200).json({
        leads: Array.isArray(leads) ? leads : [],
        total,
        page,
        pages: Math.ceil(total / limit) || 1
      });
    }

    // ---- STATS ----
    if (action === 'stats') {
      // Total leads
      const allLeadsResp = await fetch(`${SUPABASE_URL}/rest/v1/snaplead_leads?business_id=eq.${businessId}&select=status,created_at`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const allLeads = await allLeadsResp.json();
      const totalLeads = Array.isArray(allLeads) ? allLeads.length : 0;

      // This month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthLeads = Array.isArray(allLeads) ? allLeads.filter(l => new Date(l.created_at) >= monthStart).length : 0;

      // Today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayLeads = Array.isArray(allLeads) ? allLeads.filter(l => new Date(l.created_at) >= todayStart).length : 0;

      // Average response time
      const responsesResp = await fetch(`${SUPABASE_URL}/rest/v1/snaplead_responses?business_id=eq.${businessId}&select=response_time_ms`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const responses = await responsesResp.json();
      const avgResponseMs = Array.isArray(responses) && responses.length > 0
        ? responses.reduce((sum, r) => sum + r.response_time_ms, 0) / responses.length
        : 0;

      // Status breakdown
      const statusCounts = {};
      if (Array.isArray(allLeads)) {
        allLeads.forEach(l => {
          statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
        });
      }

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

      if (!result || result.code) {
        return res.status(500).json({ error: 'Failed to update lead' });
      }

      return res.status(200).json({ success: true, lead: result });
    }

    return res.status(400).json({ error: 'Invalid action. Use: leads, stats, update_lead' });
  } catch (err) {
    console.error('snaplead-data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
