// api/checkout.js
// Stripe Checkout セッションを作成し、決済ページのURLを返す。
//
// POST { plan: "monthly" | "yearly", email?: string }
//   → { url: "https://checkout.stripe.com/..." }
//
// 必要な環境変数:
//   STRIPE_SECRET_KEY        … Stripeのシークレットキー（sk_test_... / sk_live_...）
//   STRIPE_PRICE_MONTHLY     … 月額プランの価格ID（price_...）
//   STRIPE_PRICE_YEARLY      … 年額プランの価格ID（price_...）
//   SITE_URL                 … サイトのURL（例: https://goispace.app）

import { setCors } from './_redis.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY;
const PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY;
const PRICE_PLUS_MONTHLY = process.env.STRIPE_PRICE_PLUS_MONTHLY;
const PRICE_PLUS_YEARLY = process.env.STRIPE_PRICE_PLUS_YEARLY;
// クレジットパック（買い切り・都度決済）
const PRICE_CREDITS_SMALL = process.env.STRIPE_PRICE_CREDITS_SMALL;   // 例: ¥500 / 100クレジット
const PRICE_CREDITS_LARGE = process.env.STRIPE_PRICE_CREDITS_LARGE;   // 例: ¥1,200 / 300クレジット
const SITE_URL = process.env.SITE_URL || 'https://goispace.app';

// Stripe APIをfetchで直接叩く（SDK不要・軽量）
async function stripeRequest(path, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return resp.json();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!STRIPE_SECRET) {
    return res.status(500).json({ error: 'Stripe未設定です' });
  }

  const { plan, email } = req.body || {};
  const priceMap = {
    monthly: PRICE_MONTHLY,
    yearly: PRICE_YEARLY,
    plus_monthly: PRICE_PLUS_MONTHLY,
    plus_yearly: PRICE_PLUS_YEARLY,
    credits_small: PRICE_CREDITS_SMALL,
    credits_large: PRICE_CREDITS_LARGE,
  };
  const priceId = priceMap[plan] || PRICE_MONTHLY;
  if (!priceId) return res.status(400).json({ error: 'プランが無効です' });

  // クレジットパックは買い切り（payment）、それ以外はサブスク
  const isCredits = plan === 'credits_small' || plan === 'credits_large';
  const mode = isCredits ? 'payment' : 'subscription';

  try {
    // Checkout セッション作成
    const params = {
      'mode': mode,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${SITE_URL}/?checkout=cancel`,
      'allow_promotion_codes': 'true',
    };
    // クレジット購入はメタデータに付与数を記録（戻り検証で使う）
    if (isCredits) {
      params['metadata[credit_plan]'] = plan;
    }
    // メールが分かっていれば事前入力
    if (email) params['customer_email'] = email;

    const session = await stripeRequest('checkout/sessions', params);

    if (session.error) {
      console.error(session.error);
      return res.status(400).json({ error: session.error.message });
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
