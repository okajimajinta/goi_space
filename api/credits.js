// api/credits.js
// プレミアム+のクレジット（チャージ式・使った分消費）残高管理。
//
//   GET  /api/credits?email=xxx           → { credits }
//   POST { email, action:'consume', cost } → { ok, credits } 残高から消費
//
// クレジットは買い切り（都度決済）で追加。checkout.js の credit_* プランで購入。
// Redis: "credits:{email}" = 残数（整数）
//
// 消費コスト目安: 通常探索=1, 高速探索=2（フロントから cost を渡す）

import { redis, setCors } from './_redis.js';

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const email = normEmail(req.query.email);
      if (!email) return res.status(400).json({ error: 'email required' });
      let c = 0;
      try { c = parseInt(await redis('GET', `credits:${email}`), 10) || 0; } catch {}
      return res.status(200).json({ credits: c });
    }

    if (req.method === 'POST') {
      const { email, action, cost } = req.body || {};
      const e = normEmail(email);
      if (!e) return res.status(400).json({ error: 'email required' });

      if (action === 'consume') {
        const amount = Math.max(1, parseInt(cost, 10) || 1);
        let c = 0;
        try { c = parseInt(await redis('GET', `credits:${e}`), 10) || 0; } catch {}
        if (c < amount) {
          return res.status(402).json({ ok: false, credits: c, error: 'insufficient' });
        }
        // DECRBY で消費（負荷を抑えつつアトミック）
        let newBal = c;
        try { newBal = await redis('DECRBY', `credits:${e}`, amount); } catch {}
        return res.status(200).json({ ok: true, credits: newBal });
      }

      return res.status(400).json({ error: 'invalid action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
