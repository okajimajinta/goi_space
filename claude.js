// api/usage.js
// 現在の使用量を確認するエンドポイント（フロントのUI表示用）

import { setCors } from './_redis.js';
import { getUsage } from './_ratelimit.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

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
