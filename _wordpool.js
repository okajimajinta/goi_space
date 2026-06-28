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
        // クレジットパック購入の場合：残高に加算（重複加算防止つき）
        const creditPlan = session.metadata?.credit_plan;
        if (creditPlan) {
          const CREDIT_AMOUNTS = { credits_small: 100, credits_large: 300 };
          const add = CREDIT_AMOUNTS[creditPlan] || 0;
          // 同一セッションの二重付与を防ぐ
          const guardKey = `credited:${session.id}`;
          let already = null;
          try { already = await redis('GET', guardKey); } catch {}
          if (!already && add > 0) {
            try {
              await redis('INCRBY', `credits:${email}`, add);
              await redis('SET', guardKey, '1');
              await redis('EXPIRE', guardKey, 7776000); // 90日
            } catch {}
          }
          let bal = 0;
          try { bal = parseInt(await redis('GET', `credits:${email}`), 10) || 0; } catch {}
          return res.status(200).json({ credits: bal, email, creditPurchase: true });
        }

        // サブスク（プレミアム / プレミアム+）
        await redis('SET', `premium:${email}`, session.subscription || 'active');
        await redis('EXPIRE', `premium:${email}`, 3024000);
        return res.status(200).json({ premium: true, email });
      }
      return res.status(200).json({ premium: false });
    }

    // --- メールで課金状態を確認（プラン詳細つき） ---
    if (req.query.email) {
      const email = normEmail(req.query.email);

      // セキュリティ強化：Redisキャッシュだけでなく、Stripeに実在の支払い顧客が
      // いるかを必ず照合する（ランダムなメール入力での復元を防ぐ）。
      let customer = null;
      try {
        const search = await fetch(
          `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
          { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
        ).then(r => r.json());
        customer = search.data && search.data[0];
      } catch {}

      if (!customer) {
        // Stripeに該当顧客が存在しない＝復元不可
        return res.status(200).json({ premium: false, email, verified: false });
      }

      // 顧客が支払い済みか（サブスク or 過去の支払い）を確認
      let hasPayment = false;
      let plan = null;
      try {
        const subs = await fetch(
          `https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=1`,
          { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
        ).then(r => r.json());
        const s = subs.data && subs.data[0];
        if (s) {
          hasPayment = true;
          const item = s.items.data[0];
          const interval = item.price.recurring?.interval;
          const amount = item.price.unit_amount;
          const priceId = item.price.id;
          const PLUS_PRICES = [
            process.env.STRIPE_PRICE_PLUS_MONTHLY,
            process.env.STRIPE_PRICE_PLUS_YEARLY,
          ].filter(Boolean);
          const tier = PLUS_PRICES.includes(priceId) ? 'premium_plus' : 'premium';
          plan = {
            interval, amount, tier,
            label: (tier === 'premium_plus' ? 'プレミアム+ ' : '') + (interval === 'year' ? '年額プラン' : '月額プラン'),
            startedAt: s.start_date || s.created,
            renewsAt: s.current_period_end,
            cancelAtEnd: s.cancel_at_period_end,
          };
          try {
            await redis('SET', `premium:${email}`, s.id);
            await redis('EXPIRE', `premium:${email}`, 3024000);
            await redis('SET', `plan:${email}`, tier);
            await redis('EXPIRE', `plan:${email}`, 3024000);
          } catch {}
        }
      } catch {}

      // サブスクが無くても、過去にクレジット購入（支払い）があれば復元可
      if (!hasPayment) {
        try {
          const pays = await fetch(
            `https://api.stripe.com/v1/payment_intents?customer=${customer.id}&limit=1`,
            { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
          ).then(r => r.json());
          if (pays.data && pays.data.some(p => p.status === 'succeeded')) hasPayment = true;
        } catch {}
      }

      if (!hasPayment) {
        return res.status(200).json({ premium: false, email, verified: true });
      }

      return res.status(200).json({ premium: !!plan, email, plan, verified: true });
    }

    return res.status(400).json({ error: 'session_id または email が必要です' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
