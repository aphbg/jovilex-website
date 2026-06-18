// api/snaplead-auth.js
// Business owner signup and login
// Uses Supabase REST API directly — no client library needed

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === check;
}

function generateToken(businessId) {
  const payload = { id: businessId, exp: Date.now() + (7 * 24 * 60 * 60 * 1000) };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
}

async function supabaseGet(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return resp.json();
}

async function supabaseInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const validIndustries = ['home_services', 'dental', 'legal', 'medspa'];
      if (!validIndustries.includes(industry)) {
        return res.status(400).json({ error: 'Invalid industry' });
      }

      // Check if email exists
      const existing = await supabaseGet('snaplead_businesses', `owner_email=eq.${encodeURIComponent(owner_email.toLowerCase())}&select=id&limit=1`);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Generate unique slug
      let baseSlug = slugify(business_name);
      let slug = baseSlug;
      let attempt = 0;
      while (true) {
        const slugCheck = await supabaseGet('snaplead_businesses', `business_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
        if (!slugCheck || slugCheck.length === 0) break;
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      // Get default questions from template
      const templates = await supabaseGet('snaplead_templates', `industry_key=eq.${encodeURIComponent(industry)}&select=default_questions&limit=1`);
      const defaultQuestions = templates && templates.length > 0 ? templates[0].default_questions : [];

      const passwordHash = hashPassword(password);

      const business = await supabaseInsert('snaplead_businesses', {
        owner_name,
        owner_email: owner_email.toLowerCase(),
        password_hash: passwordHash,
        business_name,
        business_slug: slug,
        industry,
        phone: phone || null,
        website: website || null,
        notification_email: owner_email.toLowerCase(),
        custom_questions: defaultQuestions,
        plan: 'trial',
        status: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (!business || business.code) {
        console.error('Signup insert error:', business);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      const token = generateToken(business.id);

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

      const results = await supabaseGet('snaplead_businesses', `owner_email=eq.${encodeURIComponent(email.toLowerCase())}&select=*&limit=1`);
      if (!results || results.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const business = results[0];
      if (!verifyPassword(password, business.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = generateToken(business.id);

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
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'No token' });

      const token = authHeader.replace('Bearer ', '');
      const payload = verifyToken(token);
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

      const results = await supabaseGet('snaplead_businesses', `id=eq.${payload.id}&select=id,business_name,business_slug,industry,plan,status,trial_ends_at,custom_questions,total_leads,monthly_leads,owner_name,owner_email,notification_email,calendar_link,response_tone,services_offered,logo_url,phone,website,business_description&limit=1`);
      if (!results || results.length === 0) return res.status(401).json({ error: 'Account not found' });

      return res.status(200).json({ success: true, business: results[0] });
    }

    // ---- UPDATE SETTINGS ----
    if (action === 'update') {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'No token' });

      const token = authHeader.replace('Bearer ', '');
      const payload = verifyToken(token);
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

      const { settings } = req.body;
      if (!settings) return res.status(400).json({ error: 'No settings provided' });

      const allowed = ['business_name', 'business_description', 'services_offered', 'calendar_link', 'notification_email', 'custom_questions', 'response_tone', 'logo_url', 'phone', 'website'];
      const updates = {};
      for (const key of allowed) {
        if (settings[key] !== undefined) updates[key] = settings[key];
      }
      updates.updated_at = new Date().toISOString();

      const result = await supabaseUpdate('snaplead_businesses', `id=eq.${payload.id}`, updates);

      if (!result || result.code) {
        return res.status(500).json({ error: 'Failed to update' });
      }

      return res.status(200).json({ success: true, business: result });
    }

    return res.status(400).json({ error: 'Invalid action. Use: signup, login, verify, update' });
  } catch (err) {
    console.error('snaplead-auth error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
