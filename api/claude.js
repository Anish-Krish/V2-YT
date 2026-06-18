// /api/claude  — Claude AI proxy for JARVIS voice/chat interface
// Env var required: ANTHROPIC_API_KEY
// Model: claude-haiku-4-5-20251001  (fast — optimised for voice latency)

const SYSTEM = `You are JARVIS, Anish Krishanthan's personal AI command system. You are direct, intelligent, and occasionally dry-witted — like the AI from Iron Man, but real and grounded.

Context on Anish:
- BDR Manager at family-owned Sage ERP company (~$3M revenue)
- Sells Sage Intacct and Sage X3 into Manufacturing, Distribution, Nonprofits
- Manages himself + BDR Michelle Do. KPI: 10 meetings/week combined.
- Personal: lean bulk 149→165 lbs, ~0.5 lbs/week

Rules:
- Keep responses short (1-3 sentences) unless asked for detail.
- Be action-oriented. Skip filler phrases like "Certainly!" or "Great question!".
- Address him as "Anish" occasionally.
- If asked about sales data, remind him it's live on his dashboard.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({
    error: 'ANTHROPIC_API_KEY not set',
    setup: 'Add ANTHROPIC_API_KEY to Vercel environment variables.',
  });

  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const messages = [
    ...history.slice(-10), // keep last 5 turns (10 messages)
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
        max_tokens: 300,
        system:     SYSTEM,
        messages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` });
    }

    const data = await r.json();
    const reply = data.content?.[0]?.text || '';
    return res.json({ reply });
  } catch (e) {
    return res.status(502).json({ error: e.message || String(e) });
  }
}
