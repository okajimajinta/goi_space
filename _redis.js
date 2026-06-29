// api/routes.js
// 「ある語を含む探索経路」を保存・検索する。
// コンセプト：憧れの人の語彙空間モデルを覗く。
// ある語を検索すると、その語を経路・目的地として通った人たちの「経路全体」を複数表示する。
//
// データ構造（Redis）:
//   STRING "path:{id}" = JSON { words:[...], ts, handle }   個々の経路（TTL 90日）
//   ZSET   "pathword:{word}" member={pathId} score=ts       語ごとに、その語を含む経路IDの索引
//   STRING "pathseq"  = 連番（経路IDの採番）
//
//   POST { words:[...], handle? }     → 経路を保存し、各語に索引を張る
//   GET  /api/routes?word=海&limit=8  → その語を含む経路を最大limit件返す

import { redis, setCors } from './_redis.js';

const PATH_TTL = 7776000; // 90日

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
      const rec = { words, ts, handle: String(handle || '名無し').slice(0, 16) };

      await redis('SET', `path:${pathId}`, JSON.stringify(rec));
      await redis('EXPIRE', `path:${pathId}`, PATH_TTL);

      // 各語に索引を張る（ユニークな語のみ）
      const uniq = [...new Set(words)];
      for (const w of uniq) {
        await redis('ZADD', `pathword:${w}`, ts, pathId);
        await redis('EXPIRE', `pathword:${w}`, PATH_TTL);
        // 索引肥大を防ぐため、各語あたり最新200経路に制限
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
          const key = rec.words.join('>');
          if (seen.has(key)) continue;
          seen.add(key);
          paths.push(rec);
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
