// api/snaplead-auth.js
// Business owner signup, login, verify, update settings

const {
  signJWT, requireAuth, setCORS, slugify,
  supabaseGet, supabaseInsert, supabaseUpdate,
  hashPassword, verifyPassword, isValidEmail, sanitize
} = require('./_utils');

module.exports = async function handler(req, res) {
  setCORS(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  try {
    // ---- SIGNUP ----
    if (action === 'signup') {
      const { owner_name, owner_email, password, business_name, industry, phone, website } = req.body;

      if (!owner_name || !owner_email || !password || !business_name || !industry) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!isValidEmail(owner_email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const validIndustries = ['home_services', 'dental', 'legal', 'medspa'];
      if (!validIndustries.includes(industry)) {
        return res.status(400).json({ error: 'Invalid industry' });
      }

      const cleanEmail = owner_email.toLowerCase().trim();
      const cleanName = sanitize(owner_name);
      const cleanBizName = sanitize(business_name);

      // Check if email exists
      const existing = await supabaseGet('snaplead_businesses', `owner_email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Generate unique slug
      let baseSlug = slugify(cleanBizName);
      let slug = baseSlug;
      let attempt = 0;
      while (true) {
        const slugCheck = await supabaseGet('snaplead_businesses', `business_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
        if (!slugCheck || slugCheck.length === 0) break;
        attempt++;
        slug = `${baseSlug}-${attempt}`;
        if (attempt > 10) { slug = `${baseSlug}-${Date.now()}`; break; }
      }

      // Get default questions from template
      const templates = await supabaseGet('snaplead_templates', `industry_key=eq.${encodeURIComponent(industry)}&select=default_questions&limit=1`);
      const defaultQuestions = templates && templates.length > 0 ? templates[0].default_questions : [];

      const business = await supabaseInsert('snaplead_businesses', {
        owner_name: cleanName,
        owner_email: cleanEmail,
        password_hash: hashPassword(password),
        business_name: cleanBizName,
        business_slug: slug,
        industry,
        phone: phone ? sanitize(phone) : null,
        website: website ? sanitize(website) : null,
        notification_email: cleanEmail,
        custom_questions: defaultQuestions,
        plan: 'trial',
        status: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        referred_by: req.body.referred_by || null
      });

      if (!business || business.code) {
        console.error('Signup insert error:', business);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      const token = signJWT({ id: business.id, email: cleanEmail });

      return res.status(200).json({
        success: true,
        token,
        business: {
          id: business.id,
          business_name: business.business_name,
          business_slug: business.business_slug,
          industry: business.industry,
          plan: business.plan,
          trial_ends_at: business.trial_ends_at,
          custom_questions: business.custom_questions
        }
      });
    }

    // ---- LOGIN ----
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      const cleanEmail = email.toLowerCase().trim();
      const results = await supabaseGet('snaplead_businesses', `owner_email=eq.${encodeURIComponent(cleanEmail)}&select=*&limit=1`);
      if (!results || results.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const business = results[0];
      if (!verifyPassword(password, business.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = signJWT({ id: business.id, email: cleanEmail });

      return res.status(200).json({
        success: true,
        token,
        business: {
          id: business.id,
          business_name: business.business_name,
          business_slug: business.business_slug,
          industry: business.industry,
          plan: business.plan,
          status: business.status,
          trial_ends_at: business.trial_ends_at,
          custom_questions: business.custom_questions,
          total_leads: business.total_leads,
          monthly_leads: business.monthly_leads
        }
      });
    }

    // ---- VERIFY TOKEN ----
    if (action === 'verify') {
      const auth = requireAuth(req);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });

      const results = await supabaseGet('snaplead_businesses', `id=eq.${auth.payload.id}&select=id,business_name,business_slug,industry,plan,status,trial_ends_at,custom_questions,total_leads,monthly_leads,owner_name,owner_email,notification_email,calendar_link,response_tone,services_offered,logo_url,phone,website,business_description&limit=1`);
      if (!results || results.length === 0) return res.status(401).json({ error: 'Account not found' });

      return res.status(200).json({ success: true, business: results[0] });
    }

    // ---- UPDATE SETTINGS ----
    if (action === 'update') {
      const auth = requireAuth(req);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });

      const { settings } = req.body;
      if (!settings) return res.status(400).json({ error: 'No settings provided' });

      const allowed = ['business_name', 'business_description', 'services_offered', 'calendar_link', 'notification_email', 'custom_questions', 'response_tone', 'logo_url', 'phone', 'website'];
      const updates = {};
      for (const key of allowed) {
        if (settings[key] !== undefined) {
          updates[key] = typeof settings[key] === 'string' ? sanitize(settings[key]) : settings[key];
        }
      }
      if (updates.notification_email && !isValidEmail(updates.notification_email)) {
        return res.status(400).json({ error: 'Invalid notification email' });
      }
      updates.updated_at = new Date().toISOString();

      const result = await supabaseUpdate('snaplead_businesses', `id=eq.${auth.payload.id}`, updates);
      if (!result || result.code) return res.status(500).json({ error: 'Failed to update' });

      return res.status(200).json({ success: true, business: result });
    }

    return res.status(400).json({ error: 'Invalid action. Use: signup, login, verify, update' });
  } catch (err) {
    console.error('snaplead-auth error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
