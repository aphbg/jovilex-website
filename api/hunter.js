// api/hunter.js
// Director of Business Development (Hunter) - Komir Agent Workforce seat one
// Actions: ?action=run&track=<name>   -> run one scan track (fits serverless limits)
//          ?action=sheet              -> today's Opportunity Sheet data
//          ?action=mark               -> POST { id, status, note } update a find
// Auth: header 'x-hunter-key' must equal env HUNTER_KEY
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, HUNTER_KEY

const TRACKS = {
  "development-sector": {
    label: "Development-sector contracts",
    prompt: "Search Devex, DevelopmentAid, and similar international development job/tender boards for OPEN opportunities posted recently: NGOs, foundations, UN-adjacent organisations seeking digital builds - platforms, dashboards, data systems, websites, mobile tools, AI/automation. Prioritise Africa/Nigeria-relevant but include global. Budgets $1,000+."
  },
  "institutional-procurement": {
    label: "Institutional procurement",
    prompt: "Search for OPEN procurement notices and RFPs for software/digital systems: UNGM (UN Global Marketplace), World Bank procurement, African Development Bank, Nigerian BPP and state procurement portals. Digital platforms, dashboards, MIS, e-government tools. Budgets $1,000+."
  },
  "corporate-signals": {
    label: "Direct corporate signals",
    prompt: "Search LinkedIn posts, X posts, and company announcements where a business says it is LOOKING FOR a technology partner, software vendor, development agency, or automation help - worldwide, any language (translate findings to English). Not job-board freelancer listings; direct company calls for a build partner. Budgets $1,000+ stated or inferable."
  },
  "funding-announcements": {
    label: "Funding announcements",
    prompt: "Search TechCabal, Techpoint Africa, Crunchbase news, and tech press for startups that ANNOUNCED FUNDING in the last 14 days (seed to Series B, Africa-weighted but global). Each is a prospect: money plus a build backlog. Identify what they will likely need built next based on the announcement."
  },
  "distress-signals": {
    label: "Distress signals",
    prompt: "Search for businesses showing digital distress: recent negative reviews complaining that a business never responds to enquiries/leads (dental clinics, law firms, home services, med spas, logistics, churches with software complaints), visibly broken booking/websites, or SaaS tools users are angry at. These never posted a job - we create the conversation. Classify lead-response failures as SnapLead prospects."
  },
  "expansion-signals": {
    label: "Expansion signals",
    prompt: "Search recent news for companies announcing expansion: new markets, new product lines, new government contracts won, new branches - Africa-weighted but global. Delivery of the expansion will need systems: operations platforms, dashboards, automation. Identify what the expansion implies they need."
  },
  "agency-overflow": {
    label: "Agency overflow",
    prompt: "Search for established software/design agencies (US, UK, EU, Gulf) signalling capacity strain: posts about being fully booked, hiring rushes for contract developers, or seeking white-label/outsourcing partners. Each is a recurring-pipeline partnership target for a fast senior build partner."
  },
  "grant-backed": {
    label: "Grant-backed projects",
    prompt: "Search for organisations that recently WON grants or funding awards specifically for digital projects (education tech, health tech, civic tech, agriculture tech - Africa-weighted but global) and now need a builder. Grant announcements from foundations, development agencies, government innovation funds."
  }
};

const RUBRIC = `Score each opportunity 0-100 using EXACTLY these weights (v1.2 frozen):
- budget (max 40): budget stated or clearly inferable at/above $1,000 floor; real, visible, ready money scores high
- speed (max 25): gap between their timeline and ours (we deliver in 2-3 days what takes others weeks/months); wider gap = higher
- client (max 20): organisation with sense - real entity, formal payment rails, pays on delivery, does not ghost or discount a Nigerian firm; international orgs with procurement processes score highest
- menu (max 10): overlap with Jovilex services (websites, MVPs, full products, marketplaces, dashboards, SaaS, AI automation, ecosystem design) - mild bonus, never a gate
- multiplier (max 5): delivering once creates something sellable again
RULES: Tier definitions describe NATURE of work, never price bands. tier2_flag=true only for strategic systems-depth finds (whole-operation problems, ecosystem conversations, relationship doors) at ANY price - a pure execution $25k MVP is NOT tier2; a $12k operational-architecture reveal IS. A find can be both Tier 1 scored AND tier2_flag. NOTHING above the $1,000 floor is rejected by price in either direction.
tag: MULTIPLIER (creates resellable asset), CASH (clean revenue only), BOTH.
classification: "jovilex" (build client), "snaplead" (lead-response failure prospect), or "both".`;

const APPROACH = `For each opportunity draft a send-ready approach in Jovilex voice (confident, direct, plain English, no jargon, no buzzwords like leverage/bespoke/cutting-edge). Structure: (1) their problem read back sharper than they said it, 2 sentences max; (2) one line of proof with the closest live Jovilex build: SnapLead + intake engine (AI automation), jovilex.com/admin + portal (dashboards/internal tools), Errands (marketplace/escrow/payments), Church Pulse (multi-module ecosystem, workforce module live), jovilex.com full stack (websites/funnels); (3) exactly what we would deliver, 3-5 plain lines; (4) timeline in days - speed lands at the END of a sentence, never the headline; (5) one question that opens the conversation. NO price in the message. For tier2_flag finds, open instead with the systems read: what their posting reveals about their operation that they have not said out loud. Identify recipient_channel: the specific place/way to send (email found, contact form URL, LinkedIn page, portal submission).`;

function json(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(obj));
}

async function sb(path, method, body, params) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}${params ? "?" + params : ""}`;
  const r = await fetch(url, {
    method: method || "GET",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation,resolution=ignore-duplicates" : "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

function hashOf(s) {
  // simple stable hash (djb2) - dedup key, not security
  let h = 5381;
  const str = (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) & 0xffffffff;
  return "h" + (h >>> 0).toString(16);
}

async function runTrack(track) {
  const t = TRACKS[track];
  if (!t) throw new Error("Unknown track: " + track);

  const run = (await sb("hunter_runs", "POST", [{ track, status: "running" }]))[0];

  try {
    const sys = `You are the Director of Business Development agent for Jovilex (jovilex.com), a global AI-powered services firm under Komir Holdings, Lagos. You hunt paid opportunities and systems problems. You read public postings only - you never submit or contact anyone. Today: ${new Date().toISOString().slice(0, 10)}.
${RUBRIC}
${APPROACH}
Return ONLY a JSON array (no markdown fences, no preamble). Each item:
{"company":"","country":"","language":"en","source_url":"","summary":"","evidence":"exact public signal that produced this find","classification":"jovilex|snaplead|both","tier2_flag":false,"tier2_reason":"","tag":"MULTIPLIER|CASH|BOTH","score":0,"score_breakdown":{"budget":0,"speed":0,"client":0,"menu":0,"multiplier":0},"budget_text":"","est_value_usd":0,"drafted_approach":"","recipient_channel":"","portfolio_package":""}
Only include finds plausibly at/above $1,000 value. 3-8 quality finds. If nothing qualifies, return [].`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        system: sys,
        messages: [{ role: "user", content: t.prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }]
      })
    });
    if (!resp.ok) throw new Error("Claude API " + resp.status + ": " + (await resp.text()).slice(0, 300));
    const data = await resp.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const m = text.match(/\[[\s\S]*\]/);
    let finds = [];
    if (m) { try { finds = JSON.parse(m[0]); } catch (e) { finds = []; } }
    if (!Array.isArray(finds)) finds = [];

    let surfaced = 0, deduped = 0;
    for (const f of finds) {
      const dh = hashOf((f.company || "") + "|" + (f.source_url || f.summary || ""));
      const seen = await sb("hunter_memory", "GET", null, `dedup_hash=eq.${dh}&select=id,kind`);
      if (seen && seen.length) { deduped++; continue; }
      await sb("hunter_memory", "POST", [{ dedup_hash: dh, company: f.company || "", kind: "seen" }]);
      await sb("hunter_opportunities", "POST", [{
        track,
        company: (f.company || "Unknown").slice(0, 300),
        country: f.country || null,
        language: f.language || "en",
        source_url: f.source_url || null,
        summary: f.summary || "",
        evidence: f.evidence || "",
        classification: ["jovilex", "snaplead", "both"].includes(f.classification) ? f.classification : "jovilex",
        tier2_flag: !!f.tier2_flag,
        tier2_reason: f.tier2_reason || null,
        tag: ["MULTIPLIER", "CASH", "BOTH"].includes(f.tag) ? f.tag : "CASH",
        score: Math.max(0, Math.min(100, parseInt(f.score) || 0)),
        score_breakdown: f.score_breakdown || null,
        budget_text: f.budget_text || null,
        est_value_usd: Number(f.est_value_usd) || null,
        drafted_approach: f.drafted_approach || "",
        recipient_channel: f.recipient_channel || "",
        portfolio_package: f.portfolio_package || "",
        dedup_hash: dh
      }]);
      surfaced++;
    }

    await sb("hunter_runs", "PATCH", { finished_at: new Date().toISOString(), status: "done", scanned: finds.length, surfaced, deduped, summary: `${t.label}: ${finds.length} read, ${surfaced} surfaced, ${deduped} deduped` }, `id=eq.${run.id}`);
    return { track, label: t.label, scanned: finds.length, surfaced, deduped };
  } catch (err) {
    await sb("hunter_runs", "PATCH", { finished_at: new Date().toISOString(), status: "error", error: String(err).slice(0, 500) }, `id=eq.${run.id}`);
    throw err;
  }
}

module.exports = async (req, res) => {
  try {
    if ((req.headers["x-hunter-key"] || "") !== process.env.HUNTER_KEY) {
      return json(res, 401, { error: "unauthorised" });
    }
    const action = (req.query && req.query.action) || "";

    if (action === "run") {
      const out = await runTrack(req.query.track || "");
      return json(res, 200, out);
    }

    if (action === "sheet") {
      const today = new Date().toISOString().slice(0, 10);
      const opps = await sb("hunter_opportunities", "GET", null,
        `scan_date=eq.${today}&status=eq.new&order=tier2_flag.desc,score.desc&select=*`);
      const followups = await sb("hunter_opportunities", "GET", null,
        `status=eq.approached&order=approached_at.desc&limit=20&select=id,company,summary,recipient_channel,approached_at,status_note`);
      const runs = await sb("hunter_runs", "GET", null,
        `started_at=gte.${today}T00:00:00Z&order=started_at.desc&select=track,status,scanned,surfaced,deduped,summary`);
      return json(res, 200, { date: today, tracks: Object.keys(TRACKS).map(k => ({ key: k, label: TRACKS[k].label })), opportunities: opps || [], followups: followups || [], runs: runs || [] });
    }

    if (action === "mark" && req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { id, status, note } = body || {};
      if (!id || !status) return json(res, 400, { error: "id and status required" });
      const patch = { status, status_note: note || null };
      if (status === "approached") patch.approached_at = new Date().toISOString();
      await sb("hunter_opportunities", "PATCH", patch, `id=eq.${id}`);
      if (status === "blacklisted") {
        const row = await sb("hunter_opportunities", "GET", null, `id=eq.${id}&select=dedup_hash,company`);
        if (row && row[0]) await sb("hunter_memory", "PATCH", { kind: "blacklisted" }, `dedup_hash=eq.${row[0].dedup_hash}`);
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: "unknown action" });
  } catch (err) {
    return json(res, 500, { error: String(err).slice(0, 500) });
  }
};
