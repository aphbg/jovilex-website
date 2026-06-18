// api/snaplead-public.js
// Public endpoints: business config for lead forms, demo data, templates
// Uses Supabase REST API directly — no client library needed

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseGet(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return resp.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = req.query.action;

  try {
    // GET BUSINESS CONFIG BY SLUG
    if (action === 'business') {
      const slug = req.query.slug;
      if (!slug) return res.status(400).json({ error: 'slug required' });

      const data = await supabaseGet(
        'snaplead_businesses',
        `business_slug=eq.${encodeURIComponent(slug)}&status=in.(trial,active)&select=business_name,business_slug,industry,business_description,services_offered,custom_questions,logo_url,calendar_link,response_tone&limit=1`
      );

      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Business not found or inactive' });
      }

      return res.status(200).json({ business: data[0] });
    }

    // GET DEMO CONFIG BY INDUSTRY
    if (action === 'demo') {
      const industry = req.query.industry;
      if (!industry) return res.status(400).json({ error: 'industry required' });

      const data = await supabaseGet(
        'snaplead_templates',
        `industry_key=eq.${encodeURIComponent(industry)}&select=*&limit=1`
      );

      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Industry template not found' });
      }

      return res.status(200).json({ template: data[0] });
    }

    // LIST ALL TEMPLATES
    if (action === 'templates') {
      const data = await supabaseGet(
        'snaplead_templates',
        'select=industry_key,display_name,landing_copy,default_questions'
      );

      return res.status(200).json({ templates: data || [] });
    }

    return res.status(400).json({ error: 'Invalid action. Use: business, demo, templates' });
  } catch (err) {
    console.error('snaplead-public error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
