// api/portal.js
// Stripe Customer Portal（顧客管理画面）へのリンクを発行する。
// 解約・プラン変更・支払い方法更新・請求履歴がすべてここで行える。
//
// POST { email }  → { url: "https://billing.stripe.com/..." }
//
// 必要な環境変数:
//   STRIPE_SECRET_KEY … Stripeのシークレットキー
//   SITE_URL          … 戻り先URL（例: https://goispace.app）

import { setCors } from './_redis.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const SITE_URL = process.env.SITE_URL || 'https://goispace.app';

async function stripeRequest(path, params, method = 'POST') {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) opts.body = new URLSearchParams(params).toString();
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, opts);
  return resp.json();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe未設定です' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールが必要です' });

  try {
    // メールからStripeの顧客を検索
    const search = await stripeRequest(
      `customers/search?query=${encodeURIComponent(`email:'${email}'`)}`,
      null, 'GET'
    );

    const customer = search.data && search.data[0];
    if (!customer) {
      return res.status(404).json({ error: 'この メールの顧客が見つかりません' });
    }

    // Customer Portal セッション作成
    const session = await stripeRequest('billing_portal/sessions', {
      'customer': customer.id,
      'return_url': SITE_URL,
    });

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
