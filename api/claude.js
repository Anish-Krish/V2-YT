// /api/claude — JARVIS AI proxy
// Env var: ANTHROPIC_API_KEY
// Model: claude-haiku-4-5-20251001 (fast for voice)

const SYSTEM = `You are JARVIS, the personal AI assistant built into Anish Krishanthan's sales command center dashboard.

WHO ANISH IS:
Anish is a BDR Manager at a family-owned Sage ERP company (~$3M revenue). His job is outbound sales DEVELOPMENT — he sets meetings with prospects and hands them off to an Account Executive (AE) to close. He does NOT close deals himself. He manages himself and one BDR, Michelle Do.

WHAT HE SELLS:
Sage Intacct and Sage X3 (ERP/accounting software) into Manufacturing, Distribution, and Nonprofit verticals. Sales cycle is long (6-12+ months).

HIS METRICS:
- Primary KPI: 10 meetings/week COMBINED (Anish + Michelle) — this is the north star
- Call funnel: Cold call → Connect → Pitch → Past Pitch → Meeting Set → Meeting Attended → MQL → SQL
- Michelle's sprint: 60 outbound dials/day by June 30, 2026
- Michelle's call floor started June 10 (first 2 days were data issues)

PERSONAL:
Lean bulk from 149 → 165 lbs, ~0.5 lbs/week. Doesn't want to gain fat.

YOUR JOB:
- Answer questions about his sales data, pipeline, strategy, outreach, and goals
- When live dashboard data is provided in context, USE IT — don't ask him for numbers you can see
- Help him think through problems, prioritize, or draft outreach
- Be direct, conversational, and useful. Not a robot. Not overly formal.
- Skip filler phrases ("Certainly!", "Great question!"). Just answer.
- Length: match the question. Short answer = short response. Complex = go deeper.`;

function buildDashContext(snap) {
  if (!snap) return '';
  return `
LIVE DASHBOARD DATA (pulled from HubSpot right now):
This week: ${snap.weekMeetings}/${snap.weekGoal} meetings | Anish ${snap.anishWeekDials} dials (${snap.anishAvgDials}/day avg, ${snap.anishWeekMeetings} meetings) | Michelle ${snap.michelleWeekDials} dials (${snap.michelleAvgDials}/day avg, ${snap.michelleWeekMeetings} meetings)
This week connects: Anish ${snap.anishConnects} | Michelle ${snap.michelleConnects}
This month: ${snap.monthlyAppts} appointments set (Anish ${snap.anishMonthlyAppts}, Michelle ${snap.michelleMonthlyAppts}) | MQLs: ${snap.monthlyMqls} | SQLs: ${snap.monthlySqls}
Monthly dials: Anish ${snap.anishMonthlyDials} | Michelle ${snap.michelleMonthlyDials}`.trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({
    error: 'ANTHROPIC_API_KEY not set — add it to Vercel environment variables',
  });

  const { message, history = [], dashSnap = null } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const systemWithData = SYSTEM + (dashSnap ? '\n\n' + buildDashContext(dashSnap) : '');

  const messages = [
    ...history.slice(-12),
    { role: 'user', content: message },
  ];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:     systemWithData,
        messages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` });
    }

    const data  = await r.json();
    const reply = data.content?.[0]?.text || '';
    return res.json({ reply });
  } catch (e) {
    return res.status(502).json({ error: e.message || String(e) });
  }
}
