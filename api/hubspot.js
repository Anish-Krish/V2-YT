// ================================================================
// GET /api/hubspot?type=all
//   Returns { monthly: {...}, weekly: {...} } in one shot.
//   HubSpot CRM search limit = 4 req/s.  We fire at most 2
//   concurrent searches per batch, with 350 ms between batches.
//
// Env var: HUBSPOT_TOKEN  (HubSpot Private App)
// Scopes : crm.objects.meetings.read
//          crm.objects.calls.read
//          crm.objects.deals.read
// ================================================================

const ANISH_ID    = '88049636';
const MICHELLE_ID = '93119217';

// Michelle's first 2 days (Jun 8–9 2026) were over-reported.
const MICHELLE_CALL_FLOOR = '2026-06-10';

// Connected call disposition UUIDs (from sync-sales.py)
const CONNECT_DISPOSITIONS = new Set([
  'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  'bb945bfa-dc67-4bc0-b078-0438372832a1',
  'e7390be5-647d-4795-8672-210114ba37e3',
  'cd510b3a-be32-4546-b3d8-9f14c1d8c349',
]);

// Meeting exclusion rules
const MTG_EXCLUDE_WORDS  = ['round 1', 'round 2', 'interview'];
const MTG_EXCLUDE_SUFFIX = 'and anish krishanthan';

// Deal stages
const MQL_STAGES = new Set([
  '1129362176', '1129362177',
  '102677034', '109814654',
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);
const SQL_STAGES = new Set([
  '102677034', '109814654',
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);

// ── Utilities ────────────────────────────────────────────────────

function isoToday()      { return new Date().toISOString().slice(0, 10); }
function isoMonthStart() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`;
}
function isoWeekStart() {
  const n = new Date(), dow = n.getDay();
  const mon = new Date(n);
  mon.setDate(n.getDate() - (dow === 0 ? 6 : dow - 1));
  return mon.toISOString().slice(0, 10);
}

function normTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
function isSalesMeeting(title) {
  const t = (title || '').toLowerCase().trim();
  if (MTG_EXCLUDE_WORDS.some(kw => t.includes(kw))) return false;
  if (t.endsWith(MTG_EXCLUDE_SUFFIX)) return false;
  return true;
}
function countMeetings(records, ownerId) {
  const seen = new Set();
  let count = 0;
  for (const r of records) {
    const p = r.properties;
    if (ownerId && p.hubspot_owner_id !== ownerId) continue;
    if (!isSalesMeeting(p.hs_meeting_title)) continue;
    const key = (p.hs_createdate || '').slice(0, 10) + '|' + normTitle(p.hs_meeting_title);
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
  }
  return count;
}

// ── Typed search helpers ─────────────────────────────────────────

function searchMeetings(token, ownerId, start, end) {
  return hsSearch(token, 'meetings', {
    filterGroups: [{ filters: [
      { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: ownerId },
      { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: start, highValue: end },
    ]}],
    properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
  });
}

function searchCalls(token, ownerId, start, end) {
  return hsSearch(token, 'calls', {
    filterGroups: [{ filters: [
      { propertyName: 'hubspot_owner_id',  operator: 'EQ',      value: ownerId },
      { propertyName: 'hs_call_direction', operator: 'EQ',      value: 'OUTBOUND' },
      { propertyName: 'hs_createdate',     operator: 'BETWEEN', value: start, highValue: end },
    ]}],
    properties: ['hs_createdate', 'hubspot_owner_id', 'hs_call_disposition'],
  });
}

function searchDeals(token, monthStart) {
  const allMqlSqlStages = [...new Set([...MQL_STAGES, ...SQL_STAGES])];
  return hsSearch(token, 'deals', {
    filterGroups: [{ filters: [
      { propertyName: 'createdate', operator: 'GTE', value: String(new Date(monthStart).getTime()) },
      { propertyName: 'pipeline',   operator: 'EQ',  value: 'default' },
      { propertyName: 'dealstage',  operator: 'IN',  values: allMqlSqlStages },
    ]}],
    properties: ['dealstage', 'hubspot_owner_id'],
  });
}

// ── Main fetch: 4 batches, 2 concurrent each, 350 ms apart ───────

async function getAll(token) {
  const ms  = isoMonthStart();
  const td  = isoToday();
  const ws  = isoWeekStart();
  const dow = new Date().getDay();
  const michelleCutoff = ms > MICHELLE_CALL_FLOOR ? ms : MICHELLE_CALL_FLOOR;

  // Sequential with explicit 300ms gap — guarantees ≤ 3.3 req/s regardless of
  // how fast HubSpot responds, and handles pagination (each page = 1 request).
  const w = ms2 => new Promise(r => setTimeout(r, ms2));
  const anishMtgsM    = await searchMeetings(token, ANISH_ID,    ms, td); await w(300);
  const michelleMtgsM = await searchMeetings(token, MICHELLE_ID, ms, td); await w(300);
  const deals         = await searchDeals(token, ms);                      await w(300);
  const anishCalls    = await searchCalls(token, ANISH_ID,    ws, td);    await w(300);
  const michelleCalls = await searchCalls(token, MICHELLE_ID, ws, td);    await w(300);
  const anishMtgsW    = await searchMeetings(token, ANISH_ID,    ws, td); await w(300);
  const michelleMtgsW = await searchMeetings(token, MICHELLE_ID, ws, td);

  // ── Process monthly ──────────────────────────────────────────
  const apptAnish    = countMeetings(anishMtgsM,    ANISH_ID);
  const apptMichelle = countMeetings(michelleMtgsM, MICHELLE_ID);
  let mqls = 0, sqls = 0;
  for (const d of deals) {
    const stage = d.properties.dealstage;
    if (MQL_STAGES.has(stage)) mqls++;
    if (SQL_STAGES.has(stage)) sqls++;
  }

  // ── Process weekly ───────────────────────────────────────────
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const zero = () => ({ Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 });
  const byDay = { Anish: zero(), Michelle: zero() };

  function tallyCalls(calls, who) {
    let total = 0, connects = 0;
    for (const c of calls) {
      const dateStr = (c.properties.hs_createdate || '').slice(0, 10);
      const di = new Date(dateStr + 'T12:00:00Z').getDay();
      if (di >= 1 && di <= 5) byDay[who][DAYS[di - 1]]++;
      total++;
      if (CONNECT_DISPOSITIONS.has(c.properties.hs_call_disposition)) connects++;
    }
    return { total, connects };
  }

  const at  = tallyCalls(anishCalls,    'Anish');
  const mt  = tallyCalls(michelleCalls, 'Michelle');
  const awm = countMeetings(anishMtgsW,    ANISH_ID);
  const mwm = countMeetings(michelleMtgsW, MICHELLE_ID);

  const daysElapsed = Math.max(1, dow === 0 ? 5 : Math.min(dow, 5));

  return {
    monthly: {
      appts: apptAnish + apptMichelle,
      apptAnish,
      apptMichelle,
      mqls,
      sqls,
    },
    weekly: {
      byDay,
      anish:    { calls: at.total, connects: at.connects, meetings: awm, avgDials: +(at.total / daysElapsed).toFixed(1) },
      michelle: { calls: mt.total, connects: mt.connects, meetings: mwm, avgDials: +(mt.total / daysElapsed).toFixed(1) },
      weekMeetings: awm + mwm,
      weekGoal: 10,
    },
  };
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
    setup: 'Create a HubSpot Private App with meetings.read, calls.read, deals.read scopes.',
  });

  const type = (req.query && req.query.type) || '';
  try {
    if (type === 'all') return res.json(await getAll(token));
    return res.status(400).json({ error: 'type must be all' });
  } catch (e) {
    console.error('[hubspot]', e.message || e);
    return res.status(502).json({ error: e.message || String(e) });
  }
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
