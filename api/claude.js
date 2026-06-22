// api/claude.js
// Vercel Serverless Function — APIキーをサーバー側で管理し、フロントに露出させない

export default async function handler(req, res) {
  // CORSヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { word } = req.body;
  if (!word || typeof word !== 'string' || word.length > 50) {
    return res.status(400).json({ error: 'Invalid word' });
  }

  const prompt = `
あなたは語彙・言語の専門家です。以下の日本語の言葉「${word}」について、周辺の語彙空間を探索します。

以下のカテゴリで関連語を合計16〜20語挙げてください。各語に読み仮名（ひらがな）と、その語が「${word}」とどう関係するかの一言説明（20字以内）を添えてください。

カテゴリ：
- synonym: 類義語・関連語（6語）
- antonym: 対義語・対比となる語（4語）
- emotion: この語が呼び起こす感情・感覚・ニュアンス（4語）
- metaphor: この語の比喩・象徴・連想イメージ（4語）

必ずJSON形式のみで返してください（マークダウン不可）：
{"words":[{"word":"語","reading":"よみ","type":"synonym|antonym|emotion|metaphor","description":"説明"}]}
`.trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,   // Vercelの環境変数から読む
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });

    const raw = data.content.map(c => c.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
