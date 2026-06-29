// api/compass.js
// 知的コンパス：ユーザーの興味（語群）から、文化的に離れた推奨領域と
// それを取り入れることで生まれる価値を提案する。
//
//   POST { interests:[...] }
//     → {
//         center: "興味の重心の言葉",
//         summary: "あなたの興味の傾向",
//         recommendations: [
//           { domain, distance(1-10), angle(0-360), reason, value }
//         ]
//       }
//
// distance: 文化的距離（1=隣接, 10=対極）
// angle:    方位（地図配置用・0-360度）

import { setCors } from './_redis.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let { interests } = req.body || {};
  if (!Array.isArray(interests)) interests = [];
  interests = interests.map(w => String(w || '').slice(0, 50)).filter(Boolean).slice(0, 30);
  if (interests.length === 0) return res.status(400).json({ error: 'interests required' });

  const list = interests.join('、');
  const prompt = `あなたは知的な探求を導く「知的コンパス」です。あるユーザーが次の言葉に興味を持っています：
${list}

このユーザーの興味の傾向を分析し、そこから「文化的・知的に離れた領域」を5つ提案してください。それぞれ、その領域を取り入れることでユーザーに生まれる価値（新しい視点・創造性・意外な繋がり）を述べてください。

重要な観点：
- 単に無関係な領域ではなく、「離れているが繋がると豊かさが生まれる」領域を選ぶ
- 文化的距離が近いもの（応用・隣接分野）から遠いもの（全く異質な文化・思考様式）まで幅を持たせる
- 各領域に文化的距離(1=隣接〜10=対極)と、地図上の方位(0-360度、互いに散らばるように)を割り当てる

次のJSON形式のみで出力してください（前後の説明文は不要）：
{
  "center": "ユーザーの興味を最も象徴する一語",
  "summary": "興味の傾向を40字以内で要約",
  "recommendations": [
    {"domain": "領域名（短く）", "distance": 数値, "angle": 数値, "reason": "なぜ離れているか30字以内", "value": "取り入れると生まれる価値50字以内"}
  ]
}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    if (!data.content || !Array.isArray(data.content)) {
      return res.status(502).json({ error: 'AI応答が不正です' });
    }
    let raw = data.content.map(c => c.text || '').join('');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(502).json({ error: 'AI応答の解析に失敗しました' }); }

    // 正規化
    const recs = (parsed.recommendations || []).slice(0, 6).map((r, i) => ({
      domain: String(r.domain || '').slice(0, 40),
      distance: Math.max(1, Math.min(10, Number(r.distance) || 5)),
      angle: ((Number(r.angle) || (i * 67)) % 360 + 360) % 360,
      reason: String(r.reason || '').slice(0, 60),
      value: String(r.value || '').slice(0, 100),
    })).filter(r => r.domain);

    return res.status(200).json({
      center: String(parsed.center || interests[0]).slice(0, 30),
      summary: String(parsed.summary || '').slice(0, 80),
      recommendations: recs,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
