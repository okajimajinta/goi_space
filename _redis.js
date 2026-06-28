// api/transitions.js
// ワードの遷移（A → B）を記録し、「よく辿られる経路」の重みを返す。
//
// データ構造（Redis）:
//   ZSET "edge:{from}"  member={to}  score=遷移回数
//   → from から各 to への遷移回数をソート済みで保持。引力計算に使う。
//
// POST { from: "海", to: "波" }        → 遷移を1件記録
// GET  /api/transitions?word=海        → { 海から: [{word:"波", count:12}, ...] }

import { redis, setCors } from './_redis.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // --- 遷移を記録 ---
    if (req.method === 'POST') {
      const { from, to } = req.body || {};
      if (!from || !to || typeof from !== 'string' || typeof to !== 'string')
        return res.status(400).json({ error: 'from/to required' });
      if (from.length > 50 || to.length > 50)
        return res.status(400).json({ error: 'too long' });
      if (from === to) return res.status(200).json({ ok: true });

      // 双方向に重みを加算（語彙の関連は対称とみなす）
      await redis('ZINCRBY', `edge:${from}`, 1, to);
      await redis('ZINCRBY', `edge:${to}`, 1, from);
      return res.status(200).json({ ok: true });
    }

    // --- 重みを取得 ---
    if (req.method === 'GET') {
      const word = req.query.word;
      if (!word) return res.status(400).json({ error: 'word required' });

      // 遷移回数の多い順に上位20件（member, score, member, score... の配列で返る）
      const raw = await redis('ZREVRANGE', `edge:${word}`, 0, 19, 'WITHSCORES');
      const neighbors = [];
      for (let i = 0; i < (raw?.length || 0); i += 2) {
        neighbors.push({ word: raw[i], count: Number(raw[i + 1]) });
      }
      return res.status(200).json({ word, neighbors });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
