// api/live.js
// リアルタイム検索フィード。他ユーザーが検索した語をフロントに通知する。
//   POST { word }    → 検索語を記録（TTL 30秒）
//   GET              → 直近30秒の検索語一覧を返す

import { redis, setCors } from './_redis.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = Date.now();

  try {
    if (req.method === 'POST') {
      const { word } = req.body || {};
      if (!word || typeof word !== 'string') return res.status(400).json({ error: 'word required' });
      // スコア=タイムスタンプで記録。30秒以上前のものは削除。
      await redis('ZADD', 'live:searches', now, `${word}:${now}`);
      await redis('ZREMRANGEBYSCORE', 'live:searches', 0, now - 30000);
      await redis('EXPIRE', 'live:searches', 60);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const cutoff = now - 30000;
      const raw = await redis('ZRANGEBYSCORE', 'live:searches', cutoff, '+inf');
      const words = (raw || []).map(s => String(s).split(':')[0]);
      // 重複除去
      const unique = [...new Set(words)];
      return res.status(200).json({ words: unique });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
