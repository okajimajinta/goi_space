// api/golf.js — ワードゴルフAPI（レートリミット付き、軽量タスクはHaiku）

import { checkLimit } from './_ratelimit.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// 軽量タスク（ヒント・距離）はHaiku、お題生成はSonnet
async function callClaude(prompt, maxTokens = 400, useHaiku = false) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: useHaiku ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const raw = data.content.map(c => c.text || '').join('');
  return raw.replace(/```json|```/g, '').trim();
}

const GOLF_LIMIT = 3;  // 1日のゴルフ回数
const HINT_LIMIT = 3;  // 1日のヒント回数

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  try {
    // --- お題生成（レートリミット付き） ---
    if (action === 'pair') {
      const rl = await checkLimit(req, 'golf', GOLF_LIMIT);
      if (!rl.ok) {
        return res.status(429).json({
          error: 'daily_limit',
          message: `本日の無料ゴルフ回数（${GOLF_LIMIT}回）に達しました`,
          remaining: 0,
        });
      }

      const prompt = `
日本語のワードゴルフ用に、スタートとゴールの単語ペアを1組作ってください。
条件：
- どちらも具体的で誰でも知っている一般的な名詞
- 2つの語は意味的に「離れている」が、4〜6手で関連語をたどればつなげられる距離感
- 抽象的すぎる語や固有名詞は避ける

JSON形式のみで返答：
{"start":"語","goal":"語","par":手数の目安(整数)}
`.trim();
      const out = await callClaude(prompt, 150, false); // Sonnet
      const parsed = JSON.parse(out);
      parsed._remaining = rl.remaining;
      parsed._limit = GOLF_LIMIT;
      return res.status(200).json(parsed);
    }

    // --- ヒント（Haikuで安く、レートリミット付き） ---
    if (action === 'hint') {
      const rl = await checkLimit(req, 'hint', HINT_LIMIT);
      if (!rl.ok) {
        return res.status(429).json({
          error: 'daily_limit',
          message: `本日の無料ヒント回数（${HINT_LIMIT}回）に達しました`,
          remaining: 0,
        });
      }

      const { from, goal } = req.body;
      if (!from || !goal) return res.status(400).json({ error: 'from/goal required' });
      const prompt = `
日本語の語彙ゲームで、「${from}」から「${goal}」へ関連語をたどってつなげたいです。
「${from}」と関連があり、かつ「${goal}」の方向に近づく中継語の候補を3つ挙げてください。

JSON形式のみで返答：
{"hints":["語1","語2","語3"]}
`.trim();
      const out = await callClaude(prompt, 150, true); // Haiku（安い）
      const parsed = JSON.parse(out);
      parsed._remaining = rl.remaining;
      return res.status(200).json(parsed);
    }

    // --- 距離測定（Haikuで安く） ---
    if (action === 'distance') {
      const { words, goal } = req.body;
      if (!words || !goal) return res.status(400).json({ error: 'words/goal required' });
      const list = words.slice(0, 20).join('、');
      const prompt = `
以下の日本語の語それぞれと「${goal}」との意味的距離を1〜10で評価してください。
1=ほぼ同じ意味、10=全く関係ない。

語のリスト：${list}

JSON形式のみで返答：
{"distances":[{"word":"語","distance":数値,"reason":"一言理由(10字以内)"}]}
`.trim();
      const out = await callClaude(prompt, 500, true); // Haiku
      return res.status(200).json(JSON.parse(out));
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
