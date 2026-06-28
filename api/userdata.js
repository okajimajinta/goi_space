// api/userdata.js
// メールアカウントに紐づくユーザーデータ（ハンドルネーム・プレイ履歴）を保存/取得。
//
//   GET  /api/userdata?email=xxx          → { handle, results }
//   POST { email, handle?, results? }      → 保存（部分更新）
//
// データ構造（Redis）:
//   STRING "userdata:{email}" = JSON {handle, results}
//
// メールはプレミアム会員のものを想定。未課金でもメールがあれば保存可能。

import { redis, setCors } from './_redis.js';

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // --- 取得 ---
    if (req.method === 'GET') {
      const email = normEmail(req.query.email);
      if (!email) return res.status(400).json({ error: 'email required' });
      let raw = null;
      try { raw = await redis('GET', `userdata:${email}`); } catch {}
      const data = raw ? JSON.parse(raw) : { handle: '', results: {} };
      return res.status(200).json(data);
    }

    // --- 保存（部分更新） ---
    if (req.method === 'POST') {
      const { email, handle, results } = req.body || {};
      const e = normEmail(email);
      if (!e) return res.status(400).json({ error: 'email required' });

      // 既存データを読み込んでマージ
      let cur = { handle: '', results: {} };
      try {
        const raw = await redis('GET', `userdata:${e}`);
        if (raw) cur = JSON.parse(raw);
      } catch {}

      if (typeof handle === 'string') cur.handle = handle.slice(0, 16);
      if (results && typeof results === 'object') {
        // 既存の記録とマージ（新しい記録を優先）
        cur.results = { ...cur.results, ...results };
        // 上限200件（古いものから削除）
        const keys = Object.keys(cur.results);
        if (keys.length > 200) {
          keys.slice(0, keys.length - 200).forEach(k => delete cur.results[k]);
        }
      }

      await redis('SET', `userdata:${e}`, JSON.stringify(cur));
      // 1年保持
      await redis('EXPIRE', `userdata:${e}`, 31536000);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
