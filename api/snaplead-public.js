// api/snaplead-public.js
// Public endpoints: business config for lead forms, demo data, templates

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const action = req.query.action;

  // ---- GET BUSINESS CONFIG BY SLUG ----
  // Used by: lead capture form pages
  if (action === 'business') {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const { data: business, error } = await supabase
      .from('snaplead_businesses')
      .select('business_name, business_slug, industry, business_description, services_offered, custom_questions, logo_url, calendar_link, response_tone')
      .eq('business_slug', slug)
      .in('status', ['trial', 'active'])
      .single();

    if (error || !business) {
      return res.status(404).json({ error: 'Business not found or inactive' });
    }

    return res.status(200).json({ business });
  }

  // ---- GET DEMO CONFIG BY INDUSTRY ----
  // Used by: demo pages (jovilex.com/snaplead/demo/dental etc)
  if (action === 'demo') {
    const industry = req.query.industry;
    if (!industry) return res.status(400).json({ error: 'industry required' });

    const { data: template, error } = await supabase
      .from('snaplead_templates')
      .select('*')
      .eq('industry_key', industry)
      .single();

    if (error || !template) {
      return res.status(404).json({ error: 'Industry template not found' });
    }

    return res.status(200).json({ template });
  }

  // ---- LIST ALL TEMPLATES ----
  // Used by: signup page industry selector
  if (action === 'templates') {
    const { data: templates } = await supabase
      .from('snaplead_templates')
      .select('industry_key, display_name, landing_copy, default_questions');

    return res.status(200).json({ templates: templates || [] });
  }

  return res.status(400).json({ error: 'Invalid action. Use: business, demo, templates' });
}
