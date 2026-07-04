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
import { randomPair, randomDistantPair, expandWord } from './_wordpool.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function nowJST() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function dailyKey() { return nowJST().toISOString().slice(0, 10); }   // YYYY-MM-DD
function monthlyKey() { return nowJST().toISOString().slice(0, 7); }  // YYYY-MM

// Haikuでパーを推定
async function estimatePar(start, goal) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `日本語のワードゴルフで「${start}」から関連語をたどって「${goal}」に到達するのに必要な手数の目安を整数だけで答えてください。数字のみ。` }],
      }),
    });
    const data = await resp.json();
    const raw = data.content.map(c => c.text || '').join('');
    const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    if (n >= 3 && n <= 14) return n * 3; // 実際は手数がかさむため3倍
  } catch {}
  return null;
}

// お題生成。語プールからランダムに選ぶ（真のランダム性）。
async function generatePuzzles(period, key) {
  const puzzles = [];
  const diffs = period === 'monthly' ? ['激難', '激難', '激難'] : ['易', '中', '難'];
  const used = new Set();

  for (let i = 0; i < 3; i++) {
    // マンスリーは距離の遠いペア、デイリーは通常ペア
    let seed;
    let tries = 0;
    do {
      seed = period === 'monthly' ? randomDistantPair() : randomPair();
      tries++;
    } while ((used.has(seed.start) || used.has(seed.goal)) && tries < 10);
    used.add(seed.start);
    used.add(seed.goal);

    // 種語をAIで関連語に展開
    const [start, goal] = await Promise.all([
      expandWord(seed.start, ANTHROPIC_KEY),
      expandWord(seed.goal, ANTHROPIC_KEY),
    ]);

    // パー推定（失敗時はデフォルト・3倍基準）
    const par = await estimatePar(start, goal)
      || (period === 'monthly' ? 21 : 15);

    puzzles.push({ start, goal, par, difficulty: diffs[i] });
  }

  return { puzzles };
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
      const { action, puzzle, name, moves, path, email } = req.body || {};
      if (action !== 'submit') return res.status(400).json({ error: 'unknown action' });
      if (typeof puzzle !== 'number' || typeof moves !== 'number')
        return res.status(400).json({ error: 'invalid' });
      const cleanName = String(name || '名無し').replace(/[<>"'&`]/g, '').slice(0, 16);
      const pathStr = Array.isArray(path) ? path.join('→') : '';
      const member = `${cleanName}|${pathStr}`;
      const rankKey = `rank:${period}:${key}:${puzzle}`;
      await redis('ZADD', rankKey, moves, member);
      await redis('EXPIRE', rankKey, ttl);

      // チャレンジクリアで無償クレジット付与（メールがあれば、1問1回まで）
      let creditsGranted = 0;
      let creditsTotal = null;
      const em = String(email || '').trim().toLowerCase();
      if (em) {
        const grantKey = `reward:${em}:${period}:${key}:${puzzle}`;
        let already = null;
        try { already = await redis('GET', grantKey); } catch {}
        if (!already) {
          const amount = period === 'monthly' ? 20 : 5; // デイリー5・マンスリー20
          try {
            await redis('SET', grantKey, '1');
            await redis('EXPIRE', grantKey, 31536000); // 1年
            creditsTotal = await redis('INCRBY', `credits:${em}`, amount);
            creditsGranted = amount;
          } catch {}
        }
      }

      return res.status(200).json({ ok: true, creditsGranted, credits: creditsTotal });
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
