// api/golf.js — ワードゴルフAPI（レートリミット付き、軽量タスクはHaiku）

import { checkLimit } from './_ratelimit.js';
import { randomPair, expandWord } from './_wordpool.js';

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
    // --- お題生成（語プールからランダム選択） ---
    if (action === 'pair') {
      const rl = await checkLimit(req, 'golf', GOLF_LIMIT);
      if (!rl.ok) {
        return res.status(429).json({
          error: 'daily_limit',
          message: `本日の無料ゴルフ回数（${GOLF_LIMIT}回）に達しました`,
          remaining: 0,
        });
      }

      // 語プールから種となる2語を選び、それぞれAIで関連語に展開
      const seed = randomPair();
      const [start, goal] = await Promise.all([
        expandWord(seed.start, ANTHROPIC_KEY),
        expandWord(seed.goal, ANTHROPIC_KEY),
      ]);

      // パー（手数の目安）だけHaikuで軽く推定（実際の探索は手数がかさむため3倍に調整）
      let par = 15;
      try {
        const parPrompt = `日本語のワードゴルフで「${start}」から関連語をたどって「${goal}」に到達するのに必要な手数の目安を整数だけで答えてください（4〜8程度）。数字のみ。`;
        const out = await callClaude(parPrompt, 20, true); // Haiku
        const n = parseInt(out.replace(/[^0-9]/g, ''), 10);
        if (n >= 3 && n <= 12) par = n * 3;
      } catch {}

      return res.status(200).json({ start, goal, par, _remaining: rl.remaining, _limit: GOLF_LIMIT });
    }

    // --- パー推定のみ（ユーザー定義ペア用） ---
    if (action === 'par') {
      const start = String(req.body.start || '').slice(0, 30);
      const goal = String(req.body.goal || '').slice(0, 30);
      if (!start || !goal) return res.status(400).json({ error: 'start/goal required' });
      let par = 15;
      try {
        const parPrompt = `日本語のワードゴルフで「${start}」から関連語をたどって「${goal}」に到達するのに必要な手数の目安を整数だけで答えてください（4〜8程度）。数字のみ。`;
        const out = await callClaude(parPrompt, 20, true); // Haiku
        const n = parseInt(out.replace(/[^0-9]/g, ''), 10);
        if (n >= 3 && n <= 12) par = n * 3;
      } catch {}
      return res.status(200).json({ start, goal, par });
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

JSON形式のみで返答（前後に説明文を付けない）：
{"distances":[{"word":"語","distance":数値,"reason":"一言理由(10字以内)"}]}
`.trim();
      const out = await callClaude(prompt, 600, true); // Haiku
      // 頑健なJSON抽出（Haikuが前後に文字を付けても拾う）
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        const s = out.indexOf('{'), e = out.lastIndexOf('}');
        if (s >= 0 && e > s) {
          try { parsed = JSON.parse(out.slice(s, e + 1)); } catch {}
        }
      }
      if (!parsed || !Array.isArray(parsed.distances)) {
        return res.status(200).json({ distances: [], _error: 'parse_failed' });
      }
      // 数値を正規化
      parsed.distances = parsed.distances.map(d => ({
        word: String(d.word || ''),
        distance: Math.max(1, Math.min(10, Number(d.distance) || 5)),
        reason: String(d.reason || '').slice(0, 20),
      }));
      return res.status(200).json(parsed);
    }

    // --- 経路の抽象化：A→Bを何が接続していたか ---
    if (action === 'connection') {
      const { path, start, goal } = req.body;
      if (!Array.isArray(path) || path.length < 2) {
        return res.status(400).json({ error: 'path required' });
      }
      const route = path.slice(0, 30).join(' → ');
      const s = String(start || path[0]).slice(0, 50);
      const g = String(goal || path[path.length - 1]).slice(0, 50);
      const prompt = `語彙の連想ゲームで、ある人が「${s}」から「${g}」へ次の経路で辿り着きました：
${route}

この旅路を振り返り、出発点と終点の間に「何が橋を架けていたのか」を抽象的に読み解いてください。
個々の語ではなく、経路全体に通底するテーマ・転換点・意味の流れに注目してください。

次のJSON形式のみで出力（前後の説明文なし）：
{
  "bridge": "「${s}」と「${g}」の間を接続していた概念・テーマを一言で（15字以内）",
  "narrative": "どんな意味の流れでA地点からB地点へ辿り着いたのか、その物語（90字以内）",
  "pivot": "経路の中で最も重要だった転換点となる語"
}`;
      const out = await callClaude(prompt, 500, false); // Sonnetで質を確保
      let parsed;
      try { parsed = JSON.parse(out); }
      catch {
        const a = out.indexOf('{'), b = out.lastIndexOf('}');
        if (a >= 0 && b > a) { try { parsed = JSON.parse(out.slice(a, b + 1)); } catch {} }
      }
      if (!parsed) return res.status(200).json({ bridge: '', narrative: '', pivot: '' });
      return res.status(200).json({
        bridge: String(parsed.bridge || '').slice(0, 40),
        narrative: String(parsed.narrative || '').slice(0, 200),
        pivot: String(parsed.pivot || '').slice(0, 50),
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
