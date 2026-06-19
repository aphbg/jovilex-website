// api/snaplead-public.js
// Public endpoints: business config for lead forms, demo data, templates, partner stats

const { supabaseGet, setCORS } = require('./_utils');

module.exports = async function handler(req, res) {
  setCORS(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = req.query.action;

  try {
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

    if (action === 'templates') {
      const data = await supabaseGet(
        'snaplead_templates',
        'select=industry_key,display_name,landing_copy,default_questions'
      );
      return res.status(200).json({ templates: data || [] });
    }

    // PARTNER STATS — returns attributed clients for a referral code
    if (action === 'partner') {
      const code = req.query.code;
      if (!code) return res.status(400).json({ error: 'code required' });

      const data = await supabaseGet(
        'snaplead_businesses',
        `referred_by=eq.${encodeURIComponent(code)}&select=business_name,industry,plan,status,created_at&order=created_at.desc`
      );

      if (!data || data.length === 0) {
        return res.status(200).json({ success: true, clients: [] });
      }

      return res.status(200).json({ success: true, clients: data });
    }

    return res.status(400).json({ error: 'Invalid action. Use: business, demo, templates, partner' });
  } catch (err) {
    console.error('snaplead-public error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
