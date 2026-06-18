// ================================================================
// GET /api/hubspot?type=all
//   Returns { monthly, weekly } with full call-funnel breakdown.
//
// Env var : HUBSPOT_TOKEN  (HubSpot Private App)
// Scopes  : crm.objects.meetings.read
//           crm.objects.calls.read
//           crm.objects.deals.read
//
// Rate-limit strategy: fully sequential with explicit 300 ms gaps
// ================================================================

const ANISH_ID    = '88049636';
const MICHELLE_ID = '93119217';

// Michelle's first 2 days (Jun 8–9 2026) were over-reported.
const MICHELLE_CALL_FLOOR = '2026-06-10';

// ── Call disposition UUIDs (from sync-sales.py) ──────────────────
const CONNECT_DISPOSITIONS = new Set([
  'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  'bb945bfa-dc67-4bc0-b078-0438372832a1',
  'e7390be5-647d-4795-8672-210114ba37e3',
  'cd510b3a-be32-4546-b3d8-9f14c1d8c349',
]);
const PITCHED_DISPOSITIONS = new Set([
  'bb945bfa-dc67-4bc0-b078-0438372832a1',
  'e7390be5-647d-4795-8672-210114ba37e3',
  'cd510b3a-be32-4546-b3d8-9f14c1d8c349',
]);
const PAST_PITCH_DISPOSITIONS = new Set([
  'e7390be5-647d-4795-8672-210114ba37e3',
  'cd510b3a-be32-4546-b3d8-9f14c1d8c349',
]);
const MEETING_SET_DISPOSITION = 'cd510b3a-be32-4546-b3d8-9f14c1d8c349';

// ── Meeting exclusion rules ───────────────────────────────────────
const MTG_EXCLUDE_WORDS  = ['round 1', 'round 2', 'interview'];
const MTG_EXCLUDE_SUFFIX = 'and anish krishanthan';

// ── Deal stages ───────────────────────────────────────────────────
const MQL_STAGES = new Set([
  '1129362176', '1129362177',
  '102677034', '109814654',
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);
const SQL_STAGES = new Set([
  '102677034', '109814654',
  'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon',
]);

// ── Date helpers ─────────────────────────────────────────────────

// Return epoch-ms strings for HubSpot BETWEEN filters.
// HubSpot interprets bare ISO date strings as midnight UTC, so calls/meetings
// made during business hours on "today" get excluded. Use actual timestamps.
function msNow()        { return String(Date.now()); }
function msMonthStart() {
  const n = new Date();
  return String(new Date(n.getFullYear(), n.getMonth(), 1).getTime());
}
function msWeekStart() {
  const n = new Date(), dow = n.getDay();
  const mon = new Date(n);
  mon.setDate(n.getDate() - (dow === 0 ? 6 : dow - 1));
  mon.setHours(0, 0, 0, 0);
  return String(mon.getTime());
}
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

// ── Meeting helpers ───────────────────────────────────────────────

function normTitle(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); }
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
    // Use HubSpot record ID as the unique key — title+date dedup was incorrectly
    // collapsing distinct meetings that happened to share a common title (e.g. "Discovery Call")
    // on the same day.
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    count++;
  }
  return count;
}

// ── Call tally ────────────────────────────────────────────────────

function tallyFunnel(calls) {
  let dials = 0, connects = 0, pitched = 0, pastPitch = 0, meetingSet = 0;
  for (const c of calls) {
    const disp = c.properties.hs_call_disposition;
    dials++;
    if (CONNECT_DISPOSITIONS.has(disp))    connects++;
    if (PITCHED_DISPOSITIONS.has(disp))    pitched++;
    if (PAST_PITCH_DISPOSITIONS.has(disp)) pastPitch++;
    if (disp === MEETING_SET_DISPOSITION)  meetingSet++;
  }
  return { dials, connects, pitched, pastPitch, meetingSet };
}

// ── Search helpers ────────────────────────────────────────────────

// start/end are epoch-ms strings. highValue always uses Date.now() so we never
// cut off activity from earlier today.
function searchMeetings(token, ownerId, startMs) {
  return hsSearch(token, 'meetings', {
    filterGroups: [{ filters: [
      { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: ownerId },
      { propertyName: 'hs_createdate',    operator: 'BETWEEN', value: startMs, highValue: msNow() },
    ]}],
    properties: ['hs_meeting_title', 'hs_createdate', 'hubspot_owner_id'],
  });
}

function searchCalls(token, ownerId, startMs) {
  return hsSearch(token, 'calls', {
    filterGroups: [{ filters: [
      { propertyName: 'hubspot_owner_id',  operator: 'EQ',      value: ownerId },
      { propertyName: 'hs_call_direction', operator: 'EQ',      value: 'OUTBOUND' },
      { propertyName: 'hs_createdate',     operator: 'BETWEEN', value: startMs, highValue: msNow() },
    ]}],
    properties: ['hs_createdate', 'hubspot_owner_id', 'hs_call_disposition'],
  });
}

function searchDeals(token, monthStart) {
  const stages = [...new Set([...MQL_STAGES, ...SQL_STAGES])];
  return hsSearch(token, 'deals', {
    filterGroups: [{ filters: [
      { propertyName: 'createdate', operator: 'GTE', value: String(new Date(monthStart).getTime()) },
      { propertyName: 'pipeline',   operator: 'EQ',  value: 'default' },
      { propertyName: 'dealstage',  operator: 'IN',  values: stages },
    ]}],
    properties: ['dealstage', 'hubspot_owner_id'],
  });
}

// ── Main: 9 sequential calls, 300 ms apart ────────────────────────

async function getAll(token) {
  const mMs  = msMonthStart();
  const wMs  = msWeekStart();
  const dow  = new Date().getDay();
  // Michelle's floor: whichever is later — month start or MICHELLE_CALL_FLOOR
  const michFloorMs = String(Math.max(Number(mMs), new Date(MICHELLE_CALL_FLOOR).getTime()));

  const w = ms2 => new Promise(r => setTimeout(r, ms2));

  // 1–3: Monthly meetings + deals
  const anishMtgsM    = await searchMeetings(token, ANISH_ID,    mMs);      await w(300);
  const michelleMtgsM = await searchMeetings(token, MICHELLE_ID, mMs);      await w(300);
  const deals         = await searchDeals(token, isoMonthStart());           await w(300);
  // 4–5: Weekly calls
  const anishCallsW   = await searchCalls(token, ANISH_ID,    wMs);         await w(300);
  const michelleCallsW = await searchCalls(token, MICHELLE_ID, wMs);        await w(300);
  // 6–7: Weekly meetings
  const anishMtgsW    = await searchMeetings(token, ANISH_ID,    wMs);      await w(300);
  const michelleMtgsW = await searchMeetings(token, MICHELLE_ID, wMs);      await w(300);
  // 8–9: Monthly calls (for full-month funnel)
  const anishCallsM   = await searchCalls(token, ANISH_ID,    mMs);         await w(300);
  const michelleCallsM = await searchCalls(token, MICHELLE_ID, michFloorMs);

  // ── Bar chart grouping (weekly calls) ─────────────────────────
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const zero = () => ({ Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 });
  const byDay = { Anish: zero(), Michelle: zero() };

  for (const [calls, who] of [[anishCallsW, 'Anish'], [michelleCallsW, 'Michelle']]) {
    for (const c of calls) {
      const dateStr = (c.properties.hs_createdate || '').slice(0, 10);
      const di = new Date(dateStr + 'T12:00:00Z').getDay();
      if (di >= 1 && di <= 5) byDay[who][DAYS[di - 1]]++;
    }
  }

  // ── Funnel tallies ────────────────────────────────────────────
  const wfa = tallyFunnel(anishCallsW);
  const wfm = tallyFunnel(michelleCallsW);
  const mfa = tallyFunnel(anishCallsM);
  const mfm = tallyFunnel(michelleCallsM);

  // ── Meetings ──────────────────────────────────────────────────
  const apptAnish    = countMeetings(anishMtgsM,    ANISH_ID);
  const apptMichelle = countMeetings(michelleMtgsM, MICHELLE_ID);
  const awm          = countMeetings(anishMtgsW,    ANISH_ID);
  const mwm          = countMeetings(michelleMtgsW, MICHELLE_ID);

  // ── Deals ────────────────────────────────────────────────────
  let mqls = 0, sqls = 0;
  for (const d of deals) {
    const stage = d.properties.dealstage;
    if (MQL_STAGES.has(stage)) mqls++;
    if (SQL_STAGES.has(stage)) sqls++;
  }

  // Days *completed* this week. Current day is in-progress so subtract 1 (Mon-Thu).
  // Fri/Sat/Sun = full week done.
  const daysElapsed = (dow === 0 || dow >= 5) ? 5 : Math.max(1, dow - 1);

  return {
    monthly: {
      appts: apptAnish + apptMichelle,
      apptAnish,
      apptMichelle,
      mqls,
      sqls,
      anish:    { ...mfa, meetings: apptAnish },
      michelle: { ...mfm, meetings: apptMichelle },
    },
    weekly: {
      byDay,
      weekMeetings: awm + mwm,
      weekGoal: 10,
      anish: {
        ...wfa,
        meetings: awm,
        avgDials: +(wfa.dials / daysElapsed).toFixed(1),
      },
      michelle: {
        ...wfm,
        meetings: mwm,
        avgDials: +(wfm.dials / daysElapsed).toFixed(1),
      },
    },
    meta: { michFloor },
  };
}

// ── Contacts: sequence enrollment + added this week ───────────────
// Uses limit:1 + total field — fast, one request per count.

async function countSearch(token, objectType, filters) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filterGroups: [{ filters }], limit: 1, properties: [] }),
  });
  if (!r.ok) return null; // non-fatal — return null so UI shows "—"
  const data = await r.json();
  return data.total ?? null;
}

async function getContacts(token) {
  const wMs = msWeekStart();
  const now = msNow();
  const w   = ms2 => new Promise(r => setTimeout(r, ms2));

  const anishEnrolled    = await countSearch(token, 'contacts', [
    { propertyName: 'hubspot_owner_id',        operator: 'EQ', value: ANISH_ID },
    { propertyName: 'hs_sequences_is_enrolled', operator: 'EQ', value: 'true'  },
  ]);
  await w(300);
  const michelleEnrolled = await countSearch(token, 'contacts', [
    { propertyName: 'hubspot_owner_id',        operator: 'EQ', value: MICHELLE_ID },
    { propertyName: 'hs_sequences_is_enrolled', operator: 'EQ', value: 'true'     },
  ]);
  await w(300);
  const anishAdded    = await countSearch(token, 'contacts', [
    { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: ANISH_ID },
    { propertyName: 'createdate',       operator: 'BETWEEN', value: wMs, highValue: now },
  ]);
  await w(300);
  const michelleAdded = await countSearch(token, 'contacts', [
    { propertyName: 'hubspot_owner_id', operator: 'EQ',      value: MICHELLE_ID },
    { propertyName: 'createdate',       operator: 'BETWEEN', value: wMs, highValue: now },
  ]);

  return {
    anish:    { enrolled: anishEnrolled,    added: anishAdded },
    michelle: { enrolled: michelleEnrolled, added: michelleAdded },
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
    setup: 'Add HUBSPOT_TOKEN to Vercel env vars (Private App with meetings/calls/deals read scopes).',
  });

  const type = (req.query && req.query.type) || '';
  try {
    if (type === 'all')      return res.json(await getAll(token));
    if (type === 'contacts') return res.json(await getContacts(token));
    return res.status(400).json({ error: 'type must be all or contacts' });
  } catch (e) {
    console.error('[hubspot]', e.message || e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}

// ── HubSpot search (auto-paginates up to 2 000 records) ──────────

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
