// api/daily.js
// チャレンジAPI（デイリー & マンスリー両対応）。
//
//   GET  /api/daily?period=daily              → 今日の3問
//   GET  /api/daily?period=monthly            → 今月の3問（距離が遠いお題）
//   POST {action:"submit", period, puzzle, name, moves, path}  → スコア登録
//   GET  /api/daily?action=board&period=daily&puzzle=0         → ランキング上位
//
// データ構造（Redis）:
//   STRING "puzzles:{period}:{key}"             お題3問(JSON)をキャッシュ
//   ZSET   "rank:{period}:{key}:{puzzleIdx}"    member="{name}|{path}" score=手数
//
// key は daily なら "2024-06-22"、monthly なら "2024-06"。
// 同じ期間は全員同じお題になる（キャッシュで固定）。

import { redis, setCors } from './_redis.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function nowJST() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function dailyKey() { return nowJST().toISOString().slice(0, 10); }   // YYYY-MM-DD
function monthlyKey() { return nowJST().toISOString().slice(0, 7); }  // YYYY-MM

// お題生成。period に応じて距離感（難易度）を変える。
async function generatePuzzles(period, key) {
  // キャッシュキーにシードを混ぜ、生成のたびにバリエーションを出す
  const seed = Math.random().toString(36).slice(2, 8);

  const dailySpec = `
各問は、スタートとゴールの単語ペア。条件：
- 一般的で誰でも知っている名詞
- 4〜6手で関連語をたどればつなげられる、ほどよい距離感
- 3問それぞれ難易度を変える（易・中・難）`;

  const monthlySpec = `
各問は、スタートとゴールの単語ペア。条件：
- 一般的で知られている名詞だが、2語は「分野・文脈が大きく離れている」こと
  （例：りんご↔鍛造、風鈴↔為替、絵本↔溶鉱炉 のような距離感）
- 6〜9手で関連語を辿らないとつながらない、挑戦しがいのある遠さ
- 3問すべて最高難度（激難）で、それぞれ違う語彙分野から選ぶこと`;

  const diffSet = period === 'monthly'
    ? `"激難"`
    : `"易"|"中"|"難"`;

  const prompt = `
日本語のワードゴルフの${period === 'monthly' ? 'マンスリー' : 'デイリー'}お題を3問、ランダムに作ってください。
毎回違う語彙分野（自然・料理・工業・芸術・スポーツ・乗り物・感情・歴史など）から幅広く選び、ありきたりにならないようにしてください。
ランダムシード: ${seed}（この値ごとに必ず異なる組み合わせにすること）
${period === 'monthly' ? monthlySpec : dailySpec}

JSON形式のみで返答：
{"puzzles":[{"start":"語","goal":"語","par":整数,"difficulty":${diffSet}}]}
`.trim();

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      // 多様性を出すため温度を高めに
      temperature: 1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const raw = data.content.map(c => c.text || '').join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // period: "daily"（既定）または "monthly"
  const period = (req.body?.period || req.query.period) === 'monthly' ? 'monthly' : 'daily';
  const key = period === 'monthly' ? monthlyKey() : dailyKey();
  // 失効秒数：デイリー=30時間、マンスリー=35日
  const ttl = period === 'monthly' ? 3024000 : 108000;

  try {
    // --- スコア登録 ---
    if (req.method === 'POST') {
      const { action, puzzle, name, moves, path } = req.body || {};
      if (action !== 'submit') return res.status(400).json({ error: 'unknown action' });
      if (typeof puzzle !== 'number' || typeof moves !== 'number')
        return res.status(400).json({ error: 'invalid' });
      const cleanName = (name || '名無し').slice(0, 16);
      const pathStr = Array.isArray(path) ? path.join('→') : '';
      const member = `${cleanName}|${pathStr}`;
      const rankKey = `rank:${period}:${key}:${puzzle}`;
      await redis('ZADD', rankKey, moves, member);
      await redis('EXPIRE', rankKey, ttl);
      return res.status(200).json({ ok: true });
    }

    // --- ランキング取得 ---
    if (req.method === 'GET' && req.query.action === 'board') {
      const puzzle = Number(req.query.puzzle || 0);
      const rankKey = `rank:${period}:${key}:${puzzle}`;
      const raw = await redis('ZRANGE', rankKey, 0, 19, 'WITHSCORES');
      const board = [];
      for (let i = 0; i < (raw?.length || 0); i += 2) {
        const [name, pathStr] = String(raw[i]).split('|');
        board.push({ name, path: pathStr, moves: Number(raw[i + 1]) });
      }
      return res.status(200).json({ period, key, puzzle, board });
    }

    // --- お題取得 ---
    if (req.method === 'GET') {
      const cacheKey = `puzzles:${period}:${key}`;
      let cached = await redis('GET', cacheKey);
      if (cached) {
        return res.status(200).json({ period, key, date: key, ...JSON.parse(cached) });
      }
      const puzzles = await generatePuzzles(period, key);
      await redis('SET', cacheKey, JSON.stringify(puzzles));
      await redis('EXPIRE', cacheKey, ttl);
      return res.status(200).json({ period, key, date: key, ...puzzles });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
