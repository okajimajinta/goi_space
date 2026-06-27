// api/claude.js — 語彙生成API（キャッシュ＋レートリミット付き）

import { redis, setCors } from './_redis.js';
import { checkLimit } from './_ratelimit.js';

const FREE_LIMIT = 20; // 1日あたりの無料探索回数

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { word } = req.body;
  if (!word || typeof word !== 'string' || word.length > 50)
    return res.status(400).json({ error: 'Invalid word' });

  // キャッシュヒットならレートリミットを消費しない
  const cacheKey = `vocab:${word}`;
  let cached = null;
  try { cached = await redis('GET', cacheKey); } catch {}
  if (cached) {
    logLive(word);
    // 現在の残り回数を返す（参考情報）
    const { remaining } = await checkLimit(req, 'explore', FREE_LIMIT);
    // INCRしてしまったので戻す（キャッシュヒットはカウントしない）
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    try { await redis('DECR', `limit:explore:${ip}:${now}`); } catch {}
    const data = JSON.parse(cached);
    data._remaining = remaining + 1; // 消費してないので+1
    data._limit = FREE_LIMIT;
    return res.status(200).json(data);
  }

  // レートリミットチェック
  const rl = await checkLimit(req, 'explore', FREE_LIMIT);
  if (!rl.ok) {
    return res.status(429).json({
      error: 'daily_limit',
      message: `本日の無料探索回数（${FREE_LIMIT}回）に達しました`,
      remaining: 0,
      limit: FREE_LIMIT,
    });
  }

  // Claude API呼び出し
  const prompt = `
あなたは語彙・言語の専門家です。以下の日本語の言葉「${word}」について、周辺の語彙空間を探索します。

以下のカテゴリで関連語を合計16〜20語挙げてください。各語に読み仮名（ひらがな）と、その語が「${word}」とどう関係するかの一言説明（20字以内）を添えてください。

重要：「${word}」そのものと同じ語は絶対に含めないでください。

カテゴリ：
- synonym: 類義語・関連語（6語）
- antonym: 対義語・対比となる語（4語）
- emotion: この語が呼び起こす感情・感覚・ニュアンス（4語）
- metaphor: この語の比喩・象徴・連想イメージ（4語）

必ずJSON形式のみで返してください（マークダウン不可）：
{"words":[{"word":"語","reading":"よみ","type":"synonym|antonym|emotion|metaphor","description":"説明"}]}
`.trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });

    const raw = data.content.map(c => c.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // 重複除外
    if (parsed.words) {
      parsed.words = parsed.words.filter(w => w.word !== word);
    }

    // キャッシュ保存（24時間）
    try {
      await redis('SET', cacheKey, JSON.stringify(parsed));
      await redis('EXPIRE', cacheKey, 86400);
    } catch {}

    logLive(word);

    // 残り回数を付与
    parsed._remaining = rl.remaining;
    parsed._limit = FREE_LIMIT;

    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function logLive(word) {
  const now = Date.now();
  redis('ZADD', 'live:searches', now, `${word}:${now}`).catch(() => {});
  redis('ZREMRANGEBYSCORE', 'live:searches', 0, now - 30000).catch(() => {});
}
