// api/golf.js
// ワードゴルフ用API。
//   action="pair"      → ランダムなスタート/ゴールのワードペアを生成
//   action="validate"  → 現在の語から次の語へ「語彙的につながるか」を判定
//   action="hint"      → 現在の語からゴールに近づく中継語の候補を返す

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(prompt, maxTokens = 400) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const raw = data.content.map(c => c.text || '').join('');
  return raw.replace(/```json|```/g, '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  try {
    // --- ランダムなワードペア生成 ---
    if (action === 'pair') {
      const prompt = `
日本語のワードゴルフ用に、スタートとゴールの単語ペアを1組作ってください。
条件：
- どちらも具体的で誰でも知っている一般的な名詞
- 2つの語は意味的に「離れている」が、4〜6手で関連語をたどればつなげられる距離感
- 抽象的すぎる語や固有名詞は避ける

JSON形式のみで返答：
{"start":"語","goal":"語","par":手数の目安(整数)}
`.trim();
      const out = await callClaude(prompt, 150);
      return res.status(200).json(JSON.parse(out));
    }

    // --- ヒント（中継語候補） ---
    if (action === 'hint') {
      const { from, goal } = req.body;
      if (!from || !goal) return res.status(400).json({ error: 'from/goal required' });
      const prompt = `
日本語の語彙ゲームで、「${from}」から「${goal}」へ関連語をたどってつなげたいです。
「${from}」と関連があり、かつ「${goal}」の方向に近づく中継語の候補を3つ挙げてください。

JSON形式のみで返答：
{"hints":["語1","語2","語3"]}
`.trim();
      const out = await callClaude(prompt, 150);
      return res.status(200).json(JSON.parse(out));
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
