// api/claude.js — 語彙生成API（キャッシュ＋レートリミット付き）

import { redis, setCors } from './_redis.js';
import { checkLimit, getPlan, getCredits, consumeCredits } from './_ratelimit.js';

const FREE_LIMIT = 20; // 1日あたりの無料探索回数

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { word, context, action } = req.body || {};

  // --- エンチャント：中心語とランダム語の文脈から5つのコンテキスト語を生成 ---
  if (action === 'enchant') {
    const center = String(word || '').slice(0, 50);
    const rand = String(req.body.randomWord || '').slice(0, 50);
    if (!center || !rand) return res.status(400).json({ error: 'words required' });
    try {
      const prompt = `日本語の語彙探索です。「${center}」と「${rand}」という一見無関係な2語を結びつける、意外で詩的な文脈を考え、その文脈から連想される語をちょうど5語挙げてください。各語に読み仮名と、なぜこの2語の間に現れるかの一言説明（20字以内）を添えてください。JSON配列のみ：[{"word":"語","reading":"よみ","description":"説明"}]`;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          temperature: 1,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await resp.json();
      if (!data.content || !Array.isArray(data.content)) return res.status(502).json({ error: 'enchant: bad response' });
      let raw = data.content.map(c => c.text || '').join('');
      const s = raw.indexOf('['); const e2 = raw.lastIndexOf(']');
      if (s >= 0 && e2 > s) raw = raw.slice(s, e2 + 1);
      const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
      const words = (Array.isArray(arr) ? arr : [])
        .filter(w => w && w.word && w.word !== center && w.word !== rand)
        .slice(0, 5)
        .map(w => ({ word: w.word, reading: w.reading || '', type: 'context', description: w.description || '' }));
      return res.status(200).json({ words });
    } catch (e) {
      return res.status(500).json({ error: 'enchant failed' });
    }
  }

  if (!word || typeof word !== 'string' || word.length > 50)
    return res.status(400).json({ error: 'Invalid word' });

  // プラン判定（失敗しても続行）
  let plan = 'free', creditEmail = '', credits = 0;
  try { plan = await getPlan(req); } catch {}
  try { const c = await getCredits(req); creditEmail = c.email; credits = c.credits; } catch {}

  const isSubscriber = plan === 'premium' || plan === 'premium_plus';
  const hasCredits = credits > 0;
  // 高速モード：永久プレミアム+、またはクレジット残高あり（月額会員でもクレジットがあれば高速）
  const fastMode = plan === 'premium_plus' || hasCredits;
  // クレジット消費対象：高速だが永久プレミアム+ではない（=クレジットで高速化している）
  const usesCredit = hasCredits && plan !== 'premium_plus';

  // キャッシュ（高速モードは別キャッシュ）
  const cacheKey = fastMode ? `vocabfast:${word}` : `vocab:${word}`;
  let cached = null;
  try { cached = await redis('GET', cacheKey); } catch {}
  if (cached) {
    logLive(word);
    const { remaining } = await checkLimit(req, 'explore', FREE_LIMIT);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    try { await redis('DECR', `limit:explore:${ip}:${now}`); } catch {}
    const data = JSON.parse(cached);
    if (context && typeof context === 'string') {
      const ctx = await generateContextWords(context, word);
      if (ctx.length) data.words = [...(data.words || []), ...ctx];
    }
    data._remaining = remaining + 1;
    data._limit = FREE_LIMIT;
    data._credits = credits; // 現在のクレジット残高を返す
    return res.status(200).json(data);
  }

  // プリフェッチ（先読み）はクレジットを消費しない（キャッシュ温めのみ）
  const isPrefetch = req.body?.prefetch === true;

  // クレジットで高速化している場合は1クレジット消費（プリフェッチ・サブスク日次は除く）
  let rl = { remaining: 9999 };
  let creditsAfter = credits;
  if (usesCredit && !isPrefetch) {
    const ok = await consumeCredits(creditEmail, 1);
    if (!ok) {
      // クレジット切れ：サブスク会員なら標準速度で続行、無料なら停止
      if (isSubscriber) {
        creditsAfter = 0;
        // 標準モードへフォールバック（このリクエストはSonnetで生成）
      } else {
        return res.status(402).json({
          error: 'no_credits',
          message: 'クレジットが不足しています',
          credits: 0,
        });
      }
    } else {
      creditsAfter = credits - 1;
    }
  }

  // 無料ユーザーのみ日次制限チェック（プリフェッチは消費しない）
  if (!isSubscriber && !usesCredit && !isPrefetch) {
    rl = await checkLimit(req, 'explore', FREE_LIMIT);
    if (!rl.ok) {
      return res.status(429).json({
        error: 'daily_limit',
        message: `本日の無料探索回数（${FREE_LIMIT}回）に達しました`,
        remaining: 0,
        limit: FREE_LIMIT,
      });
    }
  }
  // クレジット切れでフォールバックした場合は標準キャッシュ/モデルに切替
  const effectiveFast = fastMode && (creditsAfter > 0 || plan === 'premium_plus' || !usesCredit);

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
    // 高速モードは Haiku で生成
    const model = effectiveFast ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

    // 本体の語彙生成と、文脈語生成を並行実行（高速化）
    const mainPromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const ctxPromise = (context && typeof context === 'string')
      ? generateContextWords(context, word)
      : Promise.resolve([]);

    const [response, ctx] = await Promise.all([mainPromise, ctxPromise]);

    let data = await response.json();
    // 高速(Haiku)で失敗した場合はSonnetでリトライ（検索を止めない）
    if (effectiveFast && (!response.ok || !data.content || !Array.isArray(data.content))) {
      console.error('Fast model failed, retrying with Sonnet');
      const retry = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1400,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      data = await retry.json();
    }

    if (!data.content || !Array.isArray(data.content)) {
      console.error('Unexpected API response:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'AI応答の形式が不正です', detail: data });
    }

    const raw = data.content.map(c => c.text || '').join('');
    let clean = raw.replace(/```json|```/g, '').trim();
    // JSONオブジェクト部分だけを抽出（前後に説明文が付いても対応）
    const objStart = clean.indexOf('{');
    const objEnd = clean.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      clean = clean.slice(objStart, objEnd + 1);
    }
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (pe) {
      console.error('JSON parse failed. raw:', raw.slice(0, 400));
      return res.status(502).json({ error: 'AI応答の解析に失敗しました', raw: raw.slice(0, 200) });
    }

    // 重複除外
    if (parsed.words) {
      parsed.words = parsed.words.filter(w => w.word !== word);
    }

    // キャッシュ保存（実際に使ったモードのキーに保存）
    const saveKey = effectiveFast ? `vocabfast:${word}` : `vocab:${word}`;
    try {
      await redis('SET', saveKey, JSON.stringify(parsed));
      await redis('EXPIRE', saveKey, 86400);
    } catch {}

    // 文脈語を追加（並行取得済み）
    if (ctx && ctx.length) parsed.words = [...(parsed.words || []), ...ctx];

    logLive(word);

    // 残り回数・クレジット残高を付与
    parsed._remaining = rl.remaining;
    parsed._limit = FREE_LIMIT;
    parsed._credits = creditsAfter;
    parsed._fast = effectiveFast;

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

// 文脈語生成：前の語(prev)から現在の語(cur)への流れを踏まえた関連語をHaikuで生成
async function generateContextWords(prev, cur) {
  if (!prev || prev === cur) return [];
  const prompt = `日本語の語彙探索です。「${prev}」から「${cur}」へと連想が移りました。この2語の流れ・文脈を踏まえて、両者を橋渡しする・あるいはこの文脈で次に連想される語をちょうど3語挙げてください。各語に読み仮名と、なぜこの文脈で出てくるかの一言説明（20字以内）を添えてください。JSON配列のみ：[{"word":"語","reading":"よみ","description":"説明"}]`;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    if (!data.content || !Array.isArray(data.content)) return [];
    let raw = data.content.map(c => c.text || '').join('');
    const s = raw.indexOf('['); const e2 = raw.lastIndexOf(']');
    if (s >= 0 && e2 > s) raw = raw.slice(s, e2 + 1);
    const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(arr)) {
      return arr
        .filter(w => w && w.word && w.word !== cur && w.word !== prev)
        .slice(0, 3)
        .map(w => ({ word: w.word, reading: w.reading || '', type: 'context', description: w.description || '' }));
    }
  } catch {}
  return [];
}
