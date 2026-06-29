// api/usage.js
// 現在の使用量を確認するエンドポイント（フロントのUI表示用）
// + ライブ検索フィード（旧 /api/live を統合）: ?live=1 で直近30秒の検索語一覧

import { redis, setCors } from './_redis.js';
import { getUsage } from './_ratelimit.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ライブ検索フィード（他ユーザーの直近検索語）
  if (req.query.live === '1') {
    try {
      const now = Date.now();
      const cutoff = now - 30000;
      const raw = await redis('ZRANGEBYSCORE', 'live:searches', cutoff, '+inf');
      const words = (raw || []).map(s => String(s).split(':')[0]);
      return res.status(200).json({ words: [...new Set(words)] });
    } catch {
      return res.status(200).json({ words: [] });
    }
  }

  try {
    const [explore, golf, hint] = await Promise.all([
      getUsage(req, 'explore'),
      getUsage(req, 'golf'),
      getUsage(req, 'hint'),
    ]);

    return res.status(200).json({
      explore: { used: explore, limit: 20, remaining: Math.max(0, 20 - explore) },
      golf:    { used: golf,    limit: 3,  remaining: Math.max(0, 3 - golf) },
      hint:    { used: hint,    limit: 3,  remaining: Math.max(0, 3 - hint) },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
