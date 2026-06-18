// ================================================================
// GET /api/hubspot?type=monthly   — meetings + MQL/SQL this month
// GET /api/hubspot?type=weekly    — calls per day + meetings this week
//
// Env var required : HUBSPOT_TOKEN  (HubSpot Private App token)
// Required scopes  :
//   crm.objects.meetings.read
//   crm.objects.calls.read
//   crm.objects.deals.read
//
// Logic ported from Old/AI-Agents/scripts/sync-sales.py
// ================================================================

const ANISH_ID    = '88049636';
const MICHELLE_ID = '93119217';

// Michelle's first 2 days (Jun 8–9) were over-reported — start counting from Jun 10.
// Once a new month begins this is irrelevant, but it guards Jun MTD call stats.
const MICHELLE_CALL_FLOOR = '2026-06-10';

// ── Call disposition UUIDs (from sync-sales.py) ─────────────────
// A call is a "connect" if its disposition is any of these.
const CONNECT_DISPOSITIONS = new Set([
  'f240bbac-87c9-4f6e-bf70-924b57d47db7',  // Connected
  'bb945bfa-dc67-4bc0-b078-0438372832a1',  // Connected - 01 - Pitch
  'e7390be5-647d-4795-8672-210114ba37e3',  // Connected - 02 - Past Pitch
  'cd510b3a-be32-4546-b3d8-9f14c1d8c349', // Connected - 03 - Meeting
]);

// ── Meeting title exclusion rules (BDR hiring, networking) ───────
const MTG_EXCLUDE_SUBSTRINGS = ['round 1', 'round 2', 'interview'];
const MTG_EXCLUDE_SUFFIX     = 'and anish krishanthan';

// ── Deal stages for MQL / SQL (new tracking, not in old script) ──
// MQL = deal has reached Pre-Assessment Questions or System Overview or beyond
const MQL_STAGES = new Set([
  '1129362176',            // Pre-Assessment Questions
  '1129362177',            // System Overview (NFP Overview Done)
  '102677034',             // Discovery
  '109814654',             // Investment Summary
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);
// SQL = deal has reached Discovery or beyond
const SQL_STAGES = new Set([
  '102677034',             // Discovery
  '109814654',             // Investment Summary
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);

// ── Date helpers ─────────────────────────────────────────────────

function isoToday() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
function isoMonthStart() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`;
}
function isoWeekStart() {
  const n   = new Date();
  const dow = n.getDay(); // 0 = Sun
  const mon = new Date(n);
  mon.setDate(n.getDate() - (dow === 0 ? 6 : dow - 1));
  return mon.toISOString().slice(0, 10);
}

// ── Meeting helpers ───────────────────────────────────────────────

function normTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
function isSalesMeeting(title) {
  const t = (title || '').toLowerCase().trim();
  if (MTG_EXCLUDE_SUBSTRINGS.some(kw => t.includes(kw))) return false;
  if (t.endsWith(MTG_EXCLUDE_SUFFIX)) return false;
  return true;
}

// Deduplicate + exclude, return { anish, michelle, total }
function countMeetings(records) {
  const seen = new Set();
  let anish = 0, michelle = 0;
  for (const r of records) {
    const p = r.properties;
    if (!isSalesMeeting(p.hs_meeting_title)) continue;
    const day = (p.hs_createdate || '').slice(0, 10);
    const key = day + '|' + normTitle(p.hs_meeting_title);
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.hubspot_owner_id === ANISH_ID)    anish++;
    if (p.hubspot_owner_id === MICHELLE_ID) michelle++;
  }
  return { anish, michelle, total: anish + michelle };
}

// ── Handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'method not allowed' });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({
    error: 'HUBSPOT_TOKEN env var not set',
    setup: 'Create a HubSpot Private App with crm.objects.meetings.read, crm.objects.calls.read, crm.objects.deals.read scopes, then add HUBSPOT_TOKEN to Vercel env vars.',
  });

  const type = (req.query && req.query.type) || '';
  try {
    if (type === 'monthly') return res.json(await getMonthly(token));
    if (type === 'weekly')  return res.json(await getWeekly(token));
    return res.status(400).json({ error: 'type must be monthly or weekly' });
  } catch (e) {
    console.error('[hubspot]', e.message || e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}

// ── Monthly ───────────────────────────────────────────────────────
// Meetings set this month (via meetings object, deduplicated, exclusions applied)
// + MQL / SQL counts from deals created this month

async function getMonthly(token) {
  const ms = isoMonthStart();
  const td = isoToday();

  // Michelle's calls only count from MICHELLE_CALL_FLOOR within the same month
  const michelleCutoff = ms > MICHELLE_CALL_FLOOR ? ms : MICHELLE_CALL_FLOOR;

  const [anishMtgs, michelleMtgs, deals] = await Promise.all([
    // Meetings: query each owner separately (proven pattern from sync-sales.py)
    hsSearch(token, 'meetings', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: ANISH_ID },
        { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: ms, highValue: td },
      ]}],
      properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
    }),
    hsSearch(token, 'meetings', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: MICHELLE_ID },
        { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: ms, highValue: td },
      ]}],
      properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
    }),
    // Deals for MQL / SQL (new tracking on top of old system)
    hsSearch(token, 'deals', {
      filterGroups: [{ filters: [
        { propertyName: 'createdate',  operator: 'GTE', value: String(new Date(ms).getTime()) },
        { propertyName: 'pipeline',    operator: 'EQ',  value: 'default' },
        { propertyName: 'dealstage',   operator: 'IN',  values: [...new Set([...MQL_STAGES, ...SQL_STAGES])] },
      ]}],
      properties: ['dealstage', 'hubspot_owner_id'],
    }),
  ]);

  const am = countMeetings(anishMtgs);
  const mm = countMeetings(michelleMtgs);

  let mqls = 0, sqls = 0;
  for (const d of deals) {
    const stage = d.properties.dealstage;
    if (MQL_STAGES.has(stage)) mqls++;
    if (SQL_STAGES.has(stage)) sqls++;
  }

  return {
    appts:       am.anish + mm.michelle,
    apptAnish:   am.anish,
    apptMichelle: mm.michelle,
    mqls,
    sqls,
    // surface the cutoff so the UI can note it
    michelleCutoff,
  };
}

// ── Weekly ────────────────────────────────────────────────────────
// OUTBOUND calls per day (Mon–Fri), connects (disposition-based),
// and meetings set this week (via meetings object)

async function getWeekly(token) {
  const ws  = isoWeekStart();
  const td  = isoToday();
  const dow = new Date().getDay(); // 0 = Sun

  const [anishCalls, michelleCalls, anishMtgs, michelleMtgs] = await Promise.all([
    // Outbound calls this week — Anish
    hsSearch(token, 'calls', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id',  operator: 'EQ',      value: ANISH_ID },
        { propertyName: 'hs_call_direction', operator: 'EQ',      value: 'OUTBOUND' },
        { propertyName: 'hs_createdate',     operator: 'BETWEEN', value: ws, highValue: td },
      ]}],
      properties: ['hs_createdate', 'hubspot_owner_id', 'hs_call_disposition'],
    }),
    // Outbound calls this week — Michelle
    hsSearch(token, 'calls', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id',  operator: 'EQ',      value: MICHELLE_ID },
        { propertyName: 'hs_call_direction', operator: 'EQ',      value: 'OUTBOUND' },
        { propertyName: 'hs_createdate',     operator: 'BETWEEN', value: ws, highValue: td },
      ]}],
      properties: ['hs_createdate', 'hubspot_owner_id', 'hs_call_disposition'],
    }),
    // Meetings this week — Anish
    hsSearch(token, 'meetings', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: ANISH_ID },
        { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: ws, highValue: td },
      ]}],
      properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
    }),
    // Meetings this week — Michelle
    hsSearch(token, 'meetings', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: MICHELLE_ID },
        { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: ws, highValue: td },
      ]}],
      properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
    }),
  ]);

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const zero = () => ({ Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 });
  const byDay = { Anish: zero(), Michelle: zero() };
  let anishConnects = 0, michelleConnects = 0;

  function tally(calls, who) {
    let total = 0, connects = 0;
    for (const c of calls) {
      const p       = c.properties;
      // hs_createdate returned as ISO string "2026-06-18T14:30:00.000Z"
      const dateStr = (p.hs_createdate || '').slice(0, 10);
      // Use noon UTC to avoid edge-of-day timezone drift
      const di      = new Date(dateStr + 'T12:00:00Z').getDay(); // 1=Mon…5=Fri
      if (di >= 1 && di <= 5) byDay[who][DAYS[di - 1]]++;
      total++;
      if (CONNECT_DISPOSITIONS.has(p.hs_call_disposition)) connects++;
    }
    return { total, connects };
  }

  const at = tally(anishCalls,    'Anish');
  const mt = tally(michelleCalls, 'Michelle');
  anishConnects    = at.connects;
  michelleConnects = mt.connects;

  const daysElapsed = Math.max(1, dow === 0 ? 5 : Math.min(dow, 5));
  const am = countMeetings(anishMtgs);
  const mm = countMeetings(michelleMtgs);

  return {
    byDay,
    anish: {
      calls:    at.total,
      connects: anishConnects,
      meetings: am.anish,
      avgDials: +(at.total / daysElapsed).toFixed(1),
    },
    michelle: {
      calls:    mt.total,
      connects: michelleConnects,
      meetings: mm.michelle,
      avgDials: +(mt.total / daysElapsed).toFixed(1),
    },
    weekMeetings: am.anish + mm.michelle,
    weekGoal: 10,
  };
}

// ── HubSpot search (auto-paginates, up to 2 000 records) ─────────

async function hsSearch(token, objectType, body) {
  const url     = `https://api.hubapi.com/crm/v3/objects/${objectType}/search`;
  const results = [];
  let after;

  for (;;) {
    const payload = { ...body, limit: 200 };
    if (after != null) payload.after = after;

    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HubSpot ${objectType} ${r.status}: ${txt.slice(0, 300)}`);
    }

    const data = await r.json();
    results.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after || results.length >= 2000) break;
  }

  return results;
}
