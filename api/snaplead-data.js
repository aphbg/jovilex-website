// api/snaplead-data.js
// Dashboard data: leads list, stats, analytics

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const payload = verifyToken(authHeader.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  const businessId = payload.id;
  const action = req.query.action || req.body?.action;

  // ---- LEADS LIST ----
  if (action === 'leads') {
    const page = parseInt(req.query.page || '1');
    const limit = 20;
    const offset = (page - 1) * limit;
    const status = req.query.status; // optional filter

    let query = supabase
      .from('snaplead_leads')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: leads, count, error } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch leads' });

    return res.status(200).json({
      leads: leads || [],
      total: count || 0,
      page,
      pages: Math.ceil((count || 0) / limit)
    });
  }

  // ---- STATS ----
  if (action === 'stats') {
    // Total leads
    const { count: totalLeads } = await supabase
      .from('snaplead_leads')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId);

    // This month's leads
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { count: monthLeads } = await supabase
      .from('snaplead_leads')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('created_at', monthStart.toISOString());

    // Today's leads
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayLeads } = await supabase
      .from('snaplead_leads')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('created_at', todayStart.toISOString());

    // Average response time
    const { data: avgData } = await supabase
      .from('snaplead_responses')
      .select('response_time_ms')
      .eq('business_id', businessId);
    
    const avgResponseMs = avgData && avgData.length > 0
      ? avgData.reduce((sum, r) => sum + r.response_time_ms, 0) / avgData.length
      : 0;

    // Lead status breakdown
    const { data: allLeads } = await supabase
      .from('snaplead_leads')
      .select('status')
      .eq('business_id', businessId);

    const statusCounts = {};
    (allLeads || []).forEach(l => {
      statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
    });

    // Conversion rate (booked + won / total)
    const converted = (statusCounts.booked || 0) + (statusCounts.won || 0);
    const conversionRate = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : '0.0';

    return res.status(200).json({
      total_leads: totalLeads || 0,
      month_leads: monthLeads || 0,
      today_leads: todayLeads || 0,
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

    const { data, error } = await supabase
      .from('snaplead_leads')
      .update(updates)
      .eq('id', lead_id)
      .eq('business_id', businessId) // security: only own leads
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update lead' });

    return res.status(200).json({ success: true, lead: data });
  }

  // ---- GET BUSINESS PUBLIC CONFIG (no auth needed for this one) ----
  // This is called by the lead form to get questions and branding

  return res.status(400).json({ error: 'Invalid action. Use: leads, stats, update_lead' });
}
