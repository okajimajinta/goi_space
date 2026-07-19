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
      // 星雲用：語の総出現回数を集計（明るさ・大きさに使う）
      await redis('ZINCRBY', 'nebula:words', 1, from);
      await redis('ZINCRBY', 'nebula:words', 1, to);
      // 月次探索統計：「今月よく探索されている言葉」ランキング＋語ページの統計表示に使う。
      // 月ごとに1キー。古い月のキーは120日で自動消滅（直近3〜4ヶ月分だけ保持）。
      try {
        const ym = new Date().toISOString().slice(0, 7); // 例: 2026-07
        const mkey = `wmonth:${ym}`;
        await redis('ZINCRBY', mkey, 1, from);
        await redis('ZINCRBY', mkey, 1, to);
        await redis('EXPIRE', mkey, 60 * 60 * 24 * 120);
      } catch {}
      return res.status(200).json({ ok: true });
    }

    // --- 星雲データ（全体の語＋繋がり）---
    if (req.method === 'GET' && req.query.action === 'nebula') {
      const topN = Math.min(parseInt(req.query.limit, 10) || 100, 2000);
      const wordsRaw = await redis('ZREVRANGE', 'nebula:words', 0, topN - 1, 'WITHSCORES');
      const nodes = [];
      const wordSet = new Set();
      for (let i = 0; i < (wordsRaw?.length || 0); i += 2) {
        nodes.push({ word: wordsRaw[i], weight: Number(wordsRaw[i + 1]) });
        wordSet.add(wordsRaw[i]);
      }
      // 上位語それぞれの edge: から、両端が上位に含まれるエッジを収集。
      // 語数が多いと逐次Redis呼び出しが重いので、探索対象を絞りつつ並列化する。
      const edges = [];
      const seen = new Set();
      // 語数に応じて探索対象を調整（多いほど各語のエッジ本数を絞る）
      const probeCount = Math.min(nodes.length, topN <= 300 ? nodes.length : 600);
      const edgesPerWord = topN <= 300 ? 8 : (topN <= 800 ? 6 : 4);
      const probe = nodes.slice(0, probeCount);
      // 並列バッチでRedisを叩く（負荷とレイテンシのバランス）
      const BATCH = 40;
      for (let start = 0; start < probe.length; start += BATCH) {
        const batch = probe.slice(start, start + BATCH);
        const results = await Promise.all(batch.map(n =>
          redis('ZREVRANGE', `edge:${n.word}`, 0, edgesPerWord - 1, 'WITHSCORES')
            .then(raw => ({ word: n.word, raw })).catch(() => ({ word: n.word, raw: [] }))
        ));
        for (const { word, raw } of results) {
          for (let i = 0; i < (raw?.length || 0); i += 2) {
            const to = raw[i], w = Number(raw[i + 1]);
            if (!wordSet.has(to)) continue;
            const a = word < to ? word : to;
            const b = word < to ? to : word;
            const key = a + '\u0001' + b;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ a, b, weight: w });
          }
        }
      }
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
      return res.status(200).json({ nodes, edges });
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
