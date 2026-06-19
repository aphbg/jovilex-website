// api/snaplead-auth.js
// Business owner signup, login, verify, update settings
// With trial abuse protection + phone normalization to E.164

const {
  signJWT, requireAuth, setCORS, slugify,
  supabaseGet, supabaseInsert, supabaseUpdate,
  hashPassword, verifyPassword, isValidEmail, sanitize
} = require('./_utils');

// Disposable email domains — blocks throwaway email signups
const DISPOSABLE_DOMAINS = new Set([
  'tempmail.com','guerrillamail.com','guerrillamail.net','guerrillamail.org','yopmail.com','yopmail.fr',
  'mailinator.com','throwaway.email','temp-mail.org','fakeinbox.com','sharklasers.com','guerrillamailblock.com',
  'grr.la','dispostable.com','maildrop.cc','mailnesia.com','tempail.com','tempr.email','discard.email',
  'trashmail.com','trashmail.me','trashmail.net','10minutemail.com','10minutemail.net','minutemail.com',
  'emailondeck.com','33mail.com','maildrop.cc','mailcatch.com','mytemp.email','mohmal.com',
  'getnada.com','tempmailo.com','burnermail.io','inboxkitten.com','mailsac.com','harakirimail.com',
  'crazymailing.com','tmail.ws','temp-mail.io','fakemail.net','throwawaymail.com','mailtemp.net',
  'tempinbox.com','tmpmail.net','tmpmail.org','getairmail.com','mailexpire.com','dispostable.com',
  'anonbox.net','binkmail.com','bobmail.info','chammy.info','devnullmail.com','letthemeatspam.com',
  'mailblocks.com','mailcatch.com','mailmoat.com','mailnull.com','notmailinator.com','spamfree24.org',
  'spamgourmet.com','spamhole.com','trashymail.com','trashymail.net','wh4f.org','mailforspam.com',
  'safetymail.info','veryrealemail.com','tempmail.ninja','emailfake.com','cmail.net','10mail.org',
  'guerrillamail.de','guerrillamail.biz','spam4.me','trash-mail.com','bugmenot.com','maildrop.cc'
]);

function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return DISPOSABLE_DOMAINS.has(domain);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || 'unknown';
}

// Normalize any phone format to E.164 (+XXXXXXXXXXX)
// Handles: 09034047640, +2349034047640, +234 903 404 7640, 0903-404-7640, etc.
function normalizePhone(raw) {
  if (!raw) return null;

  // Strip everything except digits and leading +
  let hasPlus = raw.trim().startsWith('+');
  let digits = raw.replace(/[^0-9]/g, '');

  if (!digits || digits.length < 7) return null;

  // If had a + prefix, it's already international — keep as-is
  if (hasPlus) {
    return '+' + digits;
  }

  // Nigerian local format: starts with 0, 11 digits (0XXXXXXXXXX)
  if (digits.startsWith('0') && digits.length === 11) {
    return '+234' + digits.substring(1);
  }

  // Nigerian without leading zero: 10 digits starting with 7/8/9
  if (digits.length === 10 && ['7','8','9'].includes(digits[0])) {
    return '+234' + digits;
  }

  // Already has country code embedded (e.g., 2349034047640)
  if (digits.startsWith('234') && digits.length === 13) {
    return '+' + digits;
  }

  // US/Canada: 10 digits starting with area code
  if (digits.length === 10 && !digits.startsWith('0')) {
    return '+1' + digits;
  }

  // Fallback: prepend + and hope it's valid international
  return '+' + digits;
}

module.exports = async function handler(req, res) {
  setCORS(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  try {
    // ---- SIGNUP ----
    if (action === 'signup') {
      const { owner_name, owner_email, password, business_name, industry, phone, website } = req.body;

      // Required field validation
      if (!owner_name || !owner_email || !password || !business_name || !industry || !phone) {
        return res.status(400).json({ error: 'All fields are required including phone number' });
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

      // Normalize phone to E.164 — this is the key protection
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) {
        return res.status(400).json({ error: 'Please enter a valid phone number with country code' });
      }

      // PROTECTION 1: Block disposable email providers
      if (isDisposableEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Please use a business or personal email address, not a temporary one' });
      }

      // PROTECTION 2: Check if email already exists
      const existingEmail = await supabaseGet('snaplead_businesses', `owner_email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`);
      if (existingEmail && existingEmail.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // PROTECTION 3: Check if normalized phone already exists
      const existingPhone = await supabaseGet('snaplead_businesses', `phone=eq.${encodeURIComponent(normalizedPhone)}&select=id,business_name&limit=1`);
      if (existingPhone && existingPhone.length > 0) {
        return res.status(409).json({ error: 'This phone number is already registered to another account' });
      }

      // PROTECTION 4: Flag duplicate business names and IP addresses
      const fraudFlags = [];
      const clientIP = getClientIP(req);

      const similarNames = await supabaseGet('snaplead_businesses', `business_name=ilike.${encodeURIComponent(cleanBizName)}&select=id,owner_email&limit=3`);
      if (similarNames && similarNames.length > 0) {
        fraudFlags.push({ type: 'duplicate_name', details: `Business name "${cleanBizName}" matches ${similarNames.length} existing account(s)`, timestamp: new Date().toISOString() });
      }

      if (clientIP !== 'unknown') {
        const recentFromIP = await supabaseGet('snaplead_businesses', `signup_ip=eq.${encodeURIComponent(clientIP)}&created_at=gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}&select=id&limit=5`);
        if (recentFromIP && recentFromIP.length >= 2) {
          fraudFlags.push({ type: 'ip_velocity', details: `${recentFromIP.length} signups from IP ${clientIP} in last 24h`, timestamp: new Date().toISOString() });
        }
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
        phone: normalizedPhone,
        website: website ? sanitize(website) : null,
        notification_email: cleanEmail,
        custom_questions: defaultQuestions,
        plan: 'trial',
        status: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        referred_by: req.body.referred_by || null,
        signup_ip: clientIP,
        fraud_flags: fraudFlags.length > 0 ? JSON.stringify(fraudFlags) : '[]'
      });

      if (!business || business.code) {
        console.error('Signup insert error:', business);
        if (business?.message?.includes('idx_businesses_phone_unique')) {
          return res.status(409).json({ error: 'This phone number is already registered to another account' });
        }
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
      // Normalize phone if being updated
      if (updates.phone) {
        updates.phone = normalizePhone(updates.phone) || updates.phone;
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
