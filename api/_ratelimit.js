// api/_ratelimit.js
// IPベースの日次レートリミッター。Redis INCRで簡潔に実装。
//
// 使い方: const { ok, remaining } = await checkLimit(req, 'explore', 20);
//   ok=true: 許可（残りremaining回）
//   ok=false: 上限到達

import { redis } from './_redis.js';

function getIP(req) {
  // Vercelでは x-forwarded-for にクライアントIPが入る
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function todayKey() {
  // JST基準
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// 課金済みユーザーか確認（リクエストのpremium_emailヘッダー or bodyで判定）
async function isPremium(req) {
  // フロントが課金者のメールを送ってくる（x-premium-email ヘッダー）
  const email = (req.headers['x-premium-email'] || req.body?.premiumEmail || '').toString().trim().toLowerCase();
  if (!email) return false;
  try {
    const sub = await redis('GET', `premium:${email}`);
    return !!sub;
  } catch {
    return false;
  }
}

export async function checkLimit(req, action, limit) {
  // 課金済みなら無制限
  if (await isPremium(req)) {
    return { ok: true, remaining: 9999, used: 0, premium: true };
  }

  const ip = getIP(req);
  const key = `limit:${action}:${ip}:${todayKey()}`;

  try {
    const count = await redis('INCR', key);

    // 初回なら24時間TTLを設定
    if (count === 1) {
      await redis('EXPIRE', key, 86400);
    }

    if (count > limit) {
      return { ok: false, remaining: 0, used: count };
    }

    return { ok: true, remaining: limit - count, used: count };
  } catch (err) {
    // Redis障害時は通す（サービス停止よりマシ）
    console.error('Rate limit error:', err);
    return { ok: true, remaining: -1, used: 0 };
  }
}

// 現在の使用量を取得（INCRせずに確認だけ）
export async function getUsage(req, action) {
  const ip = getIP(req);
  const key = `limit:${action}:${ip}:${todayKey()}`;
  try {
    const count = await redis('GET', key);
    return Number(count) || 0;
  } catch {
    return 0;
  }
}
