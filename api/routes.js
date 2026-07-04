// api/routes.js
// 「ある語を含む探索経路」を保存・検索する。
// コンセプト：憧れの人の語彙空間モデルを覗く。
// ある語を検索すると、その語を経路・目的地として通った人たちの「経路全体」を複数表示する。
//
// 【保存方針】経路ログは行動経済学的な価値を持つため永続保存する。
//   ただし容量効率のため、キー名を短縮した圧縮形式で保存し、
//   表示用の索引と分析用の全ログを分離する。
//
// データ構造（Redis）:
//   STRING "path:{id}"       = 圧縮JSON {w:[...], t, h}   個々の経路（永続）
//   ZSET   "pathword:{word}" member={pathId} score=ts     語ごとの索引（表示用・各語最新200件）
//   LIST   "pathlog"         = pathId を追記（分析用・全経路の永続台帳）
//   STRING "pathseq"         = 連番（経路IDの採番）
//
//   POST { words:[...], handle? }     → 経路を保存し、各語に索引を張る
//   GET  /api/routes?word=海&limit=8  → その語を含む経路を最大limit件返す

import { redis, setCors } from './_redis.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // --- 経路を保存 ---
    if (req.method === 'POST') {
      let { words, handle } = req.body || {};
      if (!Array.isArray(words)) return res.status(400).json({ error: 'words[] required' });
      // 正規化：文字列のみ・重複連続を除去・長さ制限
      words = words.map(w => String(w || '').slice(0, 50)).filter(Boolean);
      // 連続重複を畳む
      words = words.filter((w, i) => i === 0 || w !== words[i - 1]);
      if (words.length < 2) return res.status(200).json({ ok: true, skipped: true });
      if (words.length > 40) words = words.slice(-40);

      const id = await redis('INCR', 'pathseq');
      const pathId = `p${id}`;
      const ts = Date.now();
      // 圧縮形式：キー名を短縮（words→w, ts→t, handle→h）してJSONサイズを削減
      const rec = { w: words, t: ts, h: String(handle || '名無し').slice(0, 16) };

      // 経路本体：永続保存（TTLなし）
      await redis('SET', `path:${pathId}`, JSON.stringify(rec));

      // 分析用の全経路台帳に追記（永続・全件・順序保持）
      await redis('RPUSH', 'pathlog', pathId);

      // 各語に索引を張る（表示用・ユニークな語のみ）
      const uniq = [...new Set(words)];
      for (const w of uniq) {
        await redis('ZADD', `pathword:${w}`, ts, pathId);
        // 表示索引の肥大を防ぐため、各語あたり最新200経路に制限
        // （索引から外れても経路本体・pathlog には永続的に残る）
        await redis('ZREMRANGEBYRANK', `pathword:${w}`, 0, -201);
      }

      return res.status(200).json({ ok: true, pathId });
    }

    // --- ある語を含む経路を検索 ---
    if (req.method === 'GET') {
      const word = String(req.query.word || '').slice(0, 50);
      if (!word) return res.status(400).json({ error: 'word required' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);

      // その語を含む経路IDを新しい順に取得
      const ids = await redis('ZREVRANGE', `pathword:${word}`, 0, limit * 2);
      if (!ids || !ids.length) return res.status(200).json({ word, paths: [] });

      const paths = [];
      const seen = new Set(); // 同一経路の重複表示を避ける（words列で判定）
      for (const pid of ids) {
        if (paths.length >= limit) break;
        try {
          const raw = await redis('GET', `path:${pid}`);
          if (!raw) continue;
          const rec = JSON.parse(raw);
          // 圧縮形式（w/t/h）を従来形式（words/ts/handle）に復元して返す
          const words = rec.w || rec.words || [];
          const out = { words, ts: rec.t || rec.ts, handle: rec.h || rec.handle || '名無し' };
          const key = words.join('>');
          if (seen.has(key)) continue;
          seen.add(key);
          paths.push(out);
        } catch {}
      }

      return res.status(200).json({ word, paths });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
