// api/_utils.js
// Shared utilities for all SnapLead API routes
// JWT auth, Supabase REST helpers, rate limiting, sanitization, validation

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;


// =============================================
// JWT — HMAC-SHA256 signed tokens
// =============================================

function base64urlEncode(data) {
  return Buffer.from(data).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

function signJWT(payload, expiresInDays = 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + (expiresInDays * 24 * 60 * 60)
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    if (signatureB64 !== expectedSig) return null;

    // Decode and check expiry
    const payload = JSON.parse(base64urlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  return authHeader.replace('Bearer ', '');
}

function requireAuth(req) {
  const token = extractToken(req);
  if (!token) return { error: 'No token provided', status: 401 };
  const payload = verifyJWT(token);
  if (!payload) return { error: 'Invalid or expired token', status: 401 };
  return { payload };
}


// =============================================
// SUPABASE REST HELPERS
// =============================================

async function supabaseGet(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return resp.json();
}

async function supabaseGetWithCount(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'count=exact'
    }
  });
  const data = await resp.json();
  const countHeader = resp.headers.get('content-range');
  let total = 0;
  if (countHeader) {
    const match = countHeader.match(/\/(\d+)/);
    if (match) total = parseInt(match[1]);
  }
  return { data: Array.isArray(data) ? data : [], total };
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

async function supabaseDelete(table, query) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
}


// =============================================
// RATE LIMITING
// =============================================

async function checkRateLimit(businessId, maxPerHour = 100) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Count requests in the last hour for this business
  const results = await supabaseGet(
    'snaplead_rate_limits',
    `business_id=eq.${businessId}&created_at=gte.${oneHourAgo}&select=id`
  );

  const count = Array.isArray(results) ? results.length : 0;

  if (count >= maxPerHour) {
    return { allowed: false, remaining: 0, limit: maxPerHour };
  }

  // Log this request
  await supabaseInsert('snaplead_rate_limits', {
    business_id: businessId,
    endpoint: 'respond'
  });

  return { allowed: true, remaining: maxPerHour - count - 1, limit: maxPerHour };
}


// =============================================
// INPUT SANITIZATION
// =============================================

function sanitize(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .trim();
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    clean[key] = typeof value === 'string' ? sanitize(value) : value;
  }
  return clean;
}


// =============================================
// EMAIL VALIDATION
// =============================================

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  // RFC 5322 simplified — covers real-world emails without being overly strict
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return re.test(email) && email.length <= 254;
}


// =============================================
// PASSWORD HASHING
// =============================================

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


// =============================================
// CORS HEADERS
// =============================================

function setCORS(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}


// =============================================
// SLUG GENERATION
// =============================================

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
}


module.exports = {
  signJWT,
  verifyJWT,
  extractToken,
  requireAuth,
  supabaseGet,
  supabaseGetWithCount,
  supabaseInsert,
  supabaseUpdate,
  supabaseDelete,
  checkRateLimit,
  sanitize,
  sanitizeObject,
  isValidEmail,
  hashPassword,
  verifyPassword,
  setCORS,
  slugify
};
