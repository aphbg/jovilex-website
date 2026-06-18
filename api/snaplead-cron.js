// api/snaplead-cron.js
// Monthly maintenance: reset lead counters, clean up old rate limit entries
// Called by Vercel cron (configured in vercel.json)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // Only allow GET (Vercel cron uses GET)
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Verify this is a legitimate cron call
  // Vercel sends Authorization header with CRON_SECRET for cron jobs
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = {};

    // 1. Reset monthly lead counters for all businesses
    const resetResp = await fetch(`${SUPABASE_URL}/rest/v1/snaplead_businesses?monthly_leads=gt.0`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ monthly_leads: 0 })
    });
    const resetData = await resetResp.json();
    results.counters_reset = Array.isArray(resetData) ? resetData.length : 0;

    // 2. Clean up rate limit entries older than 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/snaplead_rate_limits?created_at=lt.${cutoff}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    results.rate_limits_cleaned = true;

    // 3. Mark expired trials
    const now = new Date().toISOString();
    const expireResp = await fetch(`${SUPABASE_URL}/rest/v1/snaplead_businesses?plan=eq.trial&trial_ends_at=lt.${now}&status=eq.trial`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status: 'paused' })
    });
    const expireData = await expireResp.json();
    results.trials_expired = Array.isArray(expireData) ? expireData.length : 0;

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      ...results
    });
  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err.message });
  }
};
