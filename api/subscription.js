// api/subscription.js
// 課金状態の確認と、チェックアウト完了の検証。
//
//   GET  /api/subscription?session_id=cs_xxx   → セッションから課金確認＆メール保存
//   GET  /api/subscription?email=xxx           → そのメールが課金済みか確認
//
// 課金済みのメールは Redis に保存（"premium:{email}" = サブスクID, TTL 35日）。
// Stripe Webhookを使わない簡易版。決済成功画面の戻りで検証する。
//
// 必要な環境変数:
//   STRIPE_SECRET_KEY … Stripeのシークレットキー

import { redis, setCors } from './_redis.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

async function stripeGet(path) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` },
  });
  return resp.json();
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe未設定です' });

  try {
    // --- チェックアウト完了の検証 ---
    if (req.query.session_id) {
      const session = await stripeGet(`checkout/sessions/${req.query.session_id}`);
      if (session.error) return res.status(400).json({ premium: false });

      const paid = session.payment_status === 'paid' || session.status === 'complete';
      const email = normEmail(session.customer_details?.email || session.customer_email);

      if (paid && email) {
        // 課金済みとして記録（35日TTL。サブスク継続中は再訪時に延長）
        await redis('SET', `premium:${email}`, session.subscription || 'active');
        await redis('EXPIRE', `premium:${email}`, 3024000);
        return res.status(200).json({ premium: true, email });
      }
      return res.status(200).json({ premium: false });
    }

    // --- メールで課金状態を確認 ---
    if (req.query.email) {
      const email = normEmail(req.query.email);
      let sub = null;
      try { sub = await redis('GET', `premium:${email}`); } catch {}
      return res.status(200).json({ premium: !!sub, email });
    }

    return res.status(400).json({ error: 'session_id または email が必要です' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
