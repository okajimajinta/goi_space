// api/compass.js
// 知的コンパス：ユーザーの興味（語群）から、6つの学問的視点で離れた領域を提案する。
//
//   POST { interests:[...] }
//     → { center, summary, book, recommendations:[{discipline,color,angle,domain,distance,reason,value}] }
//   POST { interests:[...], detail:{discipline, domain} }
//     → { relationship, intro_books:[...], keywords:[...], universal_concept }
//
// 6視点（色・方位固定）:
//   青=自然科学(0) 緑=生物(60) 黄=社会(120) 紫=芸術(180) 赤=哲学(240) 白=数学(300)

import { setCors, redis } from './_redis.js';
import { getCredits, consumeCredits } from './_ratelimit.js';

const DISCIPLINES = [
  { key: '自然科学', color: '#5B8FDE', angle: 0 },
  { key: '生物',     color: '#4ECBA8', angle: 60 },
  { key: '社会',     color: '#E8C547', angle: 120 },
  { key: '芸術',     color: '#9B72E8', angle: 180 },
  { key: '哲学',     color: '#E06B8B', angle: 240 },
  { key: '数学',     color: '#E8EDF5', angle: 300 },
];

async function callClaude(prompt, maxTokens) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  if (!data.content || !Array.isArray(data.content)) throw new Error('bad response');
  let raw = data.content.map(c => c.text || '').join('');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- コンパス履歴の閲覧（GET）: /api/compass?history=語 ---
  if (req.method === 'GET') {
    // === 藍の夢：報告書一覧（全公開・新しい順）===
    if (req.query.ainoyume === 'list') {
      try {
        const ids = await redis('ZREVRANGE', 'ainoyume:list', 0, 29) || [];
        const items = [];
        for (const id of ids) {
          try {
            const raw = await redis('GET', `ainoyume:${id}`);
            if (!raw) continue;
            const r = JSON.parse(raw);
            items.push({ id, goal: r.g, pioneer: r.p ? r.p.exists : null, ts: r.t, frontiers: (r.d || []).filter(x => x.f === 'frontier').length });
          } catch {}
        }
        return res.status(200).json({ items });
      } catch { return res.status(200).json({ items: [] }); }
    }
    // === 藍の夢：報告書の取得 ===
    if (req.query.ainoyume === 'report' && req.query.id) {
      const id = String(req.query.id).slice(0, 20).replace(/[^a-zA-Z0-9]/g, '');
      try {
        const raw = await redis('GET', `ainoyume:${id}`);
        if (!raw) return res.status(404).json({ error: 'not found' });
        return res.status(200).json({ id, report: JSON.parse(raw) });
      } catch { return res.status(500).json({ error: 'load failed' }); }
    }
    // 履歴のある語の一覧（星雲でボタン表示判定に使う）
    if (req.query.words === '1') {
      try {
        const words = await redis('SMEMBERS', 'compass:words') || [];
        return res.status(200).json({ words });
      } catch {
        return res.status(200).json({ words: [] });
      }
    }
    const word = String(req.query.history || req.query.word || '').slice(0, 50);
    if (!word) return res.status(400).json({ error: 'word required' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
    try {
      const ids = await redis('ZREVRANGE', `compassword:${word}`, 0, limit * 2 - 1);
      if (!ids || !ids.length) return res.status(200).json({ word, history: [] });
      const history = [];
      const seen = new Set();
      for (const id of ids) {
        if (history.length >= limit) break;
        try {
          const raw = await redis('GET', `compasslog:${id}`);
          if (!raw) continue;
          const rec = JSON.parse(raw);
          const key = (rec.i || []).join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          history.push({
            interests: rec.i || [],
            center: rec.c || '',
            summary: rec.s || '',
            recommendations: rec.r || [],
            book: rec.b || null,
            ts: rec.t || 0,
          });
        } catch {}
      }
      return res.status(200).json({ word, history });
    } catch {
      return res.status(200).json({ word, history: [] });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ===== 藍の夢（出藍の誉）：目標→未踏検出→知の航海図 =====
  if (req.body && req.body.ainoyume) {
    const ay = req.body.ainoyume;
    const stage = String(ay.stage || '');

    // --- 段階1：先駆者確認＋周辺展開（クレジット15消費）---
    if (stage === 'expand') {
      const goal = String(ay.goal || '').trim().slice(0, 120);
      if (!goal) return res.status(400).json({ error: 'goal required' });
      // クレジット消費（藍の夢は1回15クレジット）
      const { email, credits } = await getCredits(req);
      if (!email || credits < 15) {
        return res.status(402).json({ error: 'insufficient_credits', need: 15, credits: credits || 0 });
      }
      const ok = await consumeCredits(email, 15);
      if (!ok) return res.status(402).json({ error: 'insufficient_credits', need: 15, credits });
      const prompt = `ユーザーの目標：「${goal}」

この目標について、次の2つを調べてください。

1. 先駆者確認：この目標に対して、事業・研究・実践の先駆者（既に取り組んで成果を出している人・組織・研究分野）が存在するか。
2. 周辺展開：この目標を達成するために必要な知の領域を8〜12個洗い出す。技能・理論・周辺分野を含め、依存関係（何を先に知るべきか）を意識すること。各領域には、その領域を代表する検索可能なキーワードを1つ添える。

次のJSON形式のみで出力（前後の説明文なし）：
{
 "pioneer": {"exists": true/false, "note": "先駆者の概況、または不在の理由（60字以内）"},
 "domains": [
   {"name": "領域名（短く）", "key": "代表キーワード1語", "why": "なぜ目標に必要か（40字以内）", "order": 学習順序の番号（1が最初）}
 ]
}`;
      try {
        const parsed = await callClaude(prompt, 1600);
        const domains = (parsed.domains || []).slice(0, 14).map(d => ({
          name: String(d.name || '').slice(0, 40),
          key: String(d.key || '').slice(0, 30),
          why: String(d.why || '').slice(0, 100),
          order: Math.max(1, Math.min(20, Number(d.order) || 1)),
        })).filter(d => d.name);
        return res.status(200).json({
          pioneer: { exists: !!(parsed.pioneer && parsed.pioneer.exists), note: String(parsed.pioneer?.note || '').slice(0, 140) },
          domains,
          creditsLeft: credits - 15,
        });
      } catch (e) {
        // 生成失敗時はクレジットを返却
        try { await redis('INCRBY', `credits:${email}`, 15); } catch {}
        return res.status(502).json({ error: '展開に失敗しました。クレジットは返却されました。' });
      }
    }

    // --- 段階2：二重の未踏検出（Redis照合のみ・AI不使用）---
    if (stage === 'detect') {
      const domains = Array.isArray(ay.domains) ? ay.domains.slice(0, 14) : [];
      const myWords = new Set((Array.isArray(ay.myWords) ? ay.myWords : []).map(w => String(w).slice(0, 50)));
      const out = [];
      for (const d of domains) {
        const key = String(d.key || d.name || '').slice(0, 50);
        // 集合知照合：星雲・コンパス履歴にその語が存在するか
        let inNebula = false, inCompass = false;
        try { inNebula = (await redis('ZSCORE', 'nebula:words', key)) != null; } catch {}
        try { inCompass = (await redis('SISMEMBER', 'compass:words', key)) === 1; } catch {}
        out.push({
          ...d,
          personalUnknown: !myWords.has(key) && !myWords.has(d.name), // 本人未踏
          collectiveUnknown: !inNebula && !inCompass,                  // 本サービス集合知の未踏
        });
      }
      return res.status(200).json({ domains: out });
    }

    // --- 段階3：航海図の凝縮＋人類未踏の判定＋保存（公開・永続）---
    if (stage === 'chart') {
      const goal = String(ay.goal || '').trim().slice(0, 120);
      const pioneer = ay.pioneer || { exists: false, note: '' };
      const domains = Array.isArray(ay.domains) ? ay.domains.slice(0, 14) : [];
      if (!goal || !domains.length) return res.status(400).json({ error: 'goal/domains required' });
      const domList = domains.map(d =>
        `- ${d.name}（キーワード:${d.key}／必要理由:${d.why}／本人未踏:${d.personalUnknown ? 'はい' : 'いいえ'}／集合知未踏:${d.collectiveUnknown ? 'はい' : 'いいえ'}）`
      ).join('\n');
      const prompt = `ユーザーの目標：「${goal}」
先駆者：${pioneer.exists ? `存在する（${pioneer.note}）` : `見当たらない（${pioneer.note}）`}
必要な知の領域（未踏フラグ付き）：
${domList}

この目標のための「知の航海図」を作ります。各領域について：
1. 学習順序（依存関係順）を最終決定する
2. 一行の要点（この領域の芯を突く要約、25字以内）を書く
3. 人類未踏の判定：あなたの知識に照らして、その領域に確立された研究・知見・実践が存在するかを判定。本当に確立知見が無い場合のみ "frontier" とする（安易に frontier にしないこと）
4. frontier と判定した領域には、検証されていない「予測（仮説）」と、それを確かめるための調査計画の要点を書く。予測は必ず未検証であると分かる書き方をすること

次のJSON形式のみで出力（前後の説明文なし）：
{
 "title": "この航海図の題（20字以内・目標を言い換えた詩的すぎない題）",
 "items": [
   {"name": "領域名", "key": "キーワード", "order": 番号, "gist": "一行要点25字以内",
    "status": "known(確立知見あり) または frontier(人類未踏候補)",
    "prediction": "frontierのみ：未検証の予測（60字以内）", "plan": "frontierのみ：調査計画の要点（60字以内）"}
 ]
}
items は入力された全領域を含めること。`;
      try {
        const parsed = await callClaude(prompt, 2200);
        const items = (parsed.items || []).slice(0, 14).map((it, i) => {
          const src = domains.find(d => d.name === it.name) || domains[i] || {};
          return {
            n: String(it.name || src.name || '').slice(0, 40),
            k: String(it.key || src.key || '').slice(0, 30),
            o: Math.max(1, Math.min(20, Number(it.order) || i + 1)),
            g: String(it.gist || '').slice(0, 60),
            w: String(src.why || '').slice(0, 100),
            f: (String(it.status || '').includes('frontier')) ? 'frontier' : 'known',
            pu: !!src.personalUnknown,
            cu: !!src.collectiveUnknown,
            pr: String(it.prediction || '').slice(0, 140),
            pl: String(it.plan || '').slice(0, 140),
          };
        }).filter(it => it.n);
        items.sort((a, b) => a.o - b.o);
        // 保存（全公開・永続）
        const idNum = await redis('INCR', 'ainoyume:seq');
        const id = `a${idNum}`;
        const rec = {
          g: goal,
          ti: String(parsed.title || goal).slice(0, 40),
          p: { exists: !!pioneer.exists, note: String(pioneer.note || '').slice(0, 140) },
          d: items,
          t: Date.now(),
        };
        await redis('SET', `ainoyume:${id}`, JSON.stringify(rec));
        await redis('ZADD', 'ainoyume:list', rec.t, id);
        // 人類未踏カタログに索引＋語→航海図の索引（SEOページへの還元用）
        for (const it of items) {
          if (it.f === 'frontier') {
            try { await redis('RPUSH', 'ainoyume:frontiers', JSON.stringify({ id, n: it.n, g: goal, t: rec.t })); } catch {}
          }
          // 領域名・キーワードの両方で引けるように
          for (const w of [...new Set([it.k, it.n])].filter(Boolean)) {
            try {
              await redis('ZADD', `ayword:${w}`, rec.t, id);
              await redis('ZREMRANGEBYRANK', `ayword:${w}`, 0, -51); // 各語50件まで
            } catch {}
          }
        }
        return res.status(200).json({ id, report: rec });
      } catch (e) {
        return res.status(502).json({ error: '航海図の凝縮に失敗しました' });
      }
    }

    // --- 註脚の遅延生成（開いた時に生成→全体キャッシュ。次に開く人は無料）---
    if (stage === 'note') {
      const id = String(ay.id || '').slice(0, 20).replace(/[^a-zA-Z0-9]/g, '');
      const itemName = String(ay.item || '').slice(0, 40);
      if (!id || !itemName) return res.status(400).json({ error: 'id/item required' });
      const cacheKey = `ainoyume:note:${id}:${itemName}`;
      try {
        const cached = await redis('GET', cacheKey);
        if (cached) return res.status(200).json({ note: JSON.parse(cached), cached: true });
      } catch {}
      // 報告書から文脈を取得
      let rec = null;
      try { const raw = await redis('GET', `ainoyume:${id}`); if (raw) rec = JSON.parse(raw); } catch {}
      if (!rec) return res.status(404).json({ error: 'report not found' });
      const item = (rec.d || []).find(x => x.n === itemName);
      if (!item) return res.status(404).json({ error: 'item not found' });
      const isFrontier = item.f === 'frontier';
      const prompt = `目標「${rec.g}」の知の航海図における領域「${item.n}」（キーワード:${item.k}）の註脚を書いてください。
${isFrontier ? 'この領域は確立知見が無い「人類未踏候補」です。前提として何が分かっていて何が分かっていないかを峻別してください。' : ''}
学習効率を最大化するため、抽象論ではなく具体的な概念名・手法・事実に触れること。

次のJSON形式のみで出力（前後の説明文なし）：
{
 "context": "この領域の前提知識・背景（120字以内・具体的に）",
 "core": "目標達成のために掴むべき核心（100字以内）",
 "resources": [{"title": "本・文献・資料名", "author": "著者", "note": "何が得られるか25字以内", "type": "book または paper"}],
 "keywords": ["さらに掘るための具体的キーワード4〜6個"]${isFrontier ? ',\n "unknown": "何が分かっていないのか、その空白の正確な輪郭（100字以内）"' : ''}
}
resources は2〜3点。実在するものを優先。`;
      try {
        const parsed = await callClaude(prompt, 1200);
        const note = {
          context: String(parsed.context || '').slice(0, 300),
          core: String(parsed.core || '').slice(0, 240),
          resources: (parsed.resources || []).slice(0, 4).map(b => ({
            title: String(b.title || '').slice(0, 120),
            author: String(b.author || '').slice(0, 80),
            note: String(b.note || '').slice(0, 80),
            type: String(b.type || 'book').toLowerCase().includes('paper') ? 'paper' : 'book',
          })),
          keywords: (parsed.keywords || []).slice(0, 8).map(k => String(k).slice(0, 30)),
          unknown: String(parsed.unknown || '').slice(0, 240),
        };
        await redis('SET', cacheKey, JSON.stringify(note)); // 永続キャッシュ（公開）
        return res.status(200).json({ note });
      } catch { return res.status(502).json({ error: '註脚の生成に失敗しました' }); }
    }

    return res.status(400).json({ error: 'unknown ainoyume stage' });
  }

  // === ソナー：円内に入った語群から共通する意味を抽出して命名 ===
  if (req.body && req.body.sonar && Array.isArray(req.body.words)) {
    const words = req.body.words.map(w => String(w || '').slice(0, 50)).filter(Boolean).slice(0, 20);
    if (words.length < 2) return res.status(200).json({ name: '', summary: '' });
    const wlist = words.join('、');
    const prompt = `次の日本語の語の集まりに共通して流れる意味・主題を読み取ってください：
${wlist}

これらの語が同じ星座のように集まっているとき、その領域に与える「名前」と、共通する意味の説明を作ってください。
次のJSON形式のみで出力（前後の説明文なし）：
{"name":"領域の名前（8字以内・詩的でも可）","summary":"共通する意味の説明（40字以内）"}`;
    try {
      const parsed = await callClaude(prompt, 300);
      return res.status(200).json({
        name: String(parsed.name || '').slice(0, 20),
        summary: String(parsed.summary || '').slice(0, 80),
      });
    } catch {
      return res.status(502).json({ error: 'sonar failed' });
    }
  }

  let { interests, detail, tuning, depth } = req.body || {};
  if (!Array.isArray(interests)) interests = [];
  interests = interests.map(w => String(w || '').slice(0, 50)).filter(Boolean).slice(0, 30);
  if (interests.length === 0) return res.status(400).json({ error: 'interests required' });

  const list = interests.join('、');

  // チューニング：各ジャンルで希望する文化的距離（1=近い・易しい〜10=遠い・難解）
  // ユーザーが「その分野でどれくらい遠い領域を求めるか」を表す。指定なしは既定5。
  const tune = (tuning && typeof tuning === 'object') ? tuning : {};
  const tuneText = (disc) => {
    const v = Math.max(1, Math.min(10, Number(tune[disc]) || 5));
    if (v <= 2) return `（${disc}は最も近接した親しみやすく易しい領域を。文化的距離1〜3程度）`;
    if (v <= 4) return `（${disc}はやや近い応用的な領域を。文化的距離3〜5程度）`;
    if (v >= 9) return `（${disc}は最も遠い未知で難解な領域を。文化的距離8〜10程度）`;
    if (v >= 7) return `（${disc}はやや遠い挑戦的な領域を。文化的距離6〜8程度）`;
    return '';
  };

  let compassEmail = '';
  try {
    // === 選書カードの詳細（あらすじ・推薦根拠・読者像・全力セールス）===
    if (req.body.bookDetail && req.body.bookDetail.title) {
      const bt = String(req.body.bookDetail.title).slice(0, 120);
      const ba = String(req.body.bookDetail.author || '').slice(0, 60);
      const prompt = `ユーザーは次の言葉に興味があります：${list}
書籍「${bt}」${ba ? `（${ba}）` : ''}について案内してください。

あなたはこの本を深く読み込んだ書店員です。pitchの欄では、この本の何が具体的に面白いのか、どんな一節や着想が読者の頭に残るのかを、具体的な中身に触れながら書いてください。「素晴らしい」「必読」「魅力的」といった空虚な賛辞や、「読め」「読むべき」などの命令は使わず、本の実際の内容の強さだけで語ってください。

次のJSON形式のみで出力（前後の説明文なし）：
{
  "synopsis": "この本の簡単なあらすじ・内容紹介（100字以内）",
  "why": "なぜこのユーザーの興味にこの本を勧めるのか、その根拠（80字以内）",
  "reader": "この本に惹かれるのはどのような関心や精神を持つ人物像か（70字以内）",
  "pitch": "この本の具体的な面白さ・核心にある着想を、中身に触れて語る紹介文。誇張語と命令形は禁止（150字以内）"
}`;
      const parsed = await callClaude(prompt, 900);
      return res.status(200).json({
        synopsis: String(parsed.synopsis || '').slice(0, 240),
        why: String(parsed.why || '').slice(0, 200),
        reader: String(parsed.reader || '').slice(0, 180),
        pitch: String(parsed.pitch || '').slice(0, 360),
      });
    }

    // === カード詳細（クリック時）===
    if (detail && detail.discipline && detail.domain) {
      const dDisc = String(detail.discipline).slice(0, 20);
      const dDom = String(detail.domain).slice(0, 40);
      // 深さレベル：'deep'(より専門的) | 'shallow'(より入門的) | 既定(標準)
      const depthNote = depth === 'deep'
        ? 'ユーザーはこの分野をさらに深く知りたい。より専門的・先端的な内容、上級者向けの文献を中心に。'
        : depth === 'shallow'
        ? 'ユーザーはこの分野の初学者。基礎の基礎から、最も易しい入口を中心に。'
        : '';
      // 深さに応じて「読むべきもの」の性質とラベルを変える
      const readingLabel = depth === 'deep'
        ? '理解を深めるための本・文献'
        : depth === 'shallow'
        ? '最初の一歩となる易しい入門書'
        : '入門・前段に読むべき本や文書';
      const readingInstruction = depth === 'deep'
        ? 'この領域を既にある程度知っている人が、理解をさらに深めるための本や文献を挙げてください。専門書・古典的名著に加え、最先端の学術論文やレビュー論文を含めても構いません（論文の場合は著者名と発表年、可能なら掲載誌を明記）。'
        : depth === 'shallow'
        ? 'この分野に初めて触れる人向けに、最も易しく取っつきやすい入門書を挙げてください。'
        : '前段として読むべき入門書・古典を挙げてください。';
      const prompt = `ユーザーは次の言葉に興味があります：${list}
「知的コンパス」が、${dDisc}の視点から「${dDom}」という領域を推薦しました。
${depthNote}

この領域について、ユーザーの興味と結びつけて具体的に案内してください。抽象的な美辞麗句ではなく、実際の概念名・人物・事例に触れて書くこと。
読むべきもの（intro_books）については：${readingInstruction}
次のJSON形式のみで出力（前後の説明文なし）：
{
  "relationship": "ユーザーの興味と、この分野・領域が具体的にどこで交差し、なぜ離れて見えるのか。実際の概念や事例に触れて（150字以内）",
  "intro_books": [
    {"title": "本や論文のタイトル（日本語/英語可）", "author": "著者（論文なら発表年・掲載誌も）", "note": "何が書かれているか30字以内", "type": "book または paper"}
  ],
  "keywords": ["この領域を掘るための具体的なキーワード5〜8個"],
  "universal_concept": "この領域を掘り下げた先で立ち上がる、分野を横断する具体的な概念とその中身（120字以内）"
}
intro_books は2〜3冊（点）。実在するものを優先。`;
      const parsed = await callClaude(prompt, 1400);
      return res.status(200).json({
        reading_label: readingLabel,
        relationship: String(parsed.relationship || '').slice(0, 400),
        intro_books: (parsed.intro_books || []).slice(0, 4).map(b => ({
          title: String(b.title || '').slice(0, 120),
          author: String(b.author || '').slice(0, 80),
          note: String(b.note || '').slice(0, 80),
          type: (String(b.type || 'book').toLowerCase().includes('paper')) ? 'paper' : 'book',
        })),
        keywords: (parsed.keywords || []).slice(0, 10).map(k => String(k).slice(0, 30)),
        universal_concept: String(parsed.universal_concept || '').slice(0, 300),
      });
    }

    // === メイン提案（6視点）===
    // メインのコンパス生成はクレジットを3消費する（カード詳細・選書詳細は無料）。
    const { email: cEmail, credits: compassCredits } = await getCredits(req);
    compassEmail = cEmail;
    if (!compassEmail || compassCredits < 3) {
      return res.status(402).json({ error: 'insufficient_credits', need: 3, credits: compassCredits || 0 });
    }
    const compassPaid = await consumeCredits(compassEmail, 3);
    if (!compassPaid) return res.status(402).json({ error: 'insufficient_credits', need: 3, credits: compassCredits });

    const discList = DISCIPLINES.map(d => d.key).join('、');
    const tuneLines = DISCIPLINES.map(d => `・${d.key}${tuneText(d.key)}`).join('\n');
    const prompt = `あなたは知的探求を導く「知的コンパス」です。ユーザーは次の言葉に興味を持っています：
${list}

次の6つの学問的視点それぞれから、ユーザーの興味から離れているが具体的に接続しうる領域を1つずつ挙げてください。各視点の括弧内に、ユーザーの習熟度に応じた調整指示があれば従ってください：
${tuneLines}

各視点のvalueでは、その領域がユーザーの興味と具体的にどう噛み合うのか、どんな問いや着想が立ち上がるのかを、実際の中身に触れて書いてください。「新しい視点」「豊かさ」「意外なつながり」のような抽象的で空虚な言い回しは避けること。文化的距離は1(隣接)〜10(対極)で表します。

加えて、ユーザーの興味の組み合わせに最も近い書籍を1冊挙げてください（実在する名著・古典を優先）。

次のJSON形式のみで出力（前後の説明文なし）：
{
  "center": "ユーザーの興味を最も象徴する一語",
  "summary": "興味の傾向を40字以内で、具体的に要約",
  "book": {"title": "最も近い書籍", "author": "著者", "reason": "なぜこの本が近いか40字以内・具体的に"},
  "recommendations": [
    {"discipline": "自然科学", "domain": "領域名（短く）", "distance": 数値, "reason": "なぜ離れているか30字以内", "value": "その領域とユーザーの興味が具体的にどう噛み合うか50字以内"}
  ]
}
recommendations は上記6視点すべてを ${discList} の順で必ず含めること。`;

    const parsed = await callClaude(prompt, 1600);
    const byKey = {};
    (parsed.recommendations || []).forEach(r => { if (r.discipline) byKey[r.discipline] = r; });

    const recommendations = DISCIPLINES.map(d => {
      const r = byKey[d.key] || {};
      return {
        discipline: d.key,
        color: d.color,
        angle: d.angle,
        domain: String(r.domain || '').slice(0, 40),
        distance: Math.max(1, Math.min(10, Number(r.distance) || 5)),
        reason: String(r.reason || '').slice(0, 60),
        value: String(r.value || '').slice(0, 100),
      };
    }).filter(r => r.domain);

    const book = parsed.book ? {
      title: String(parsed.book.title || '').slice(0, 120),
      author: String(parsed.book.author || '').slice(0, 60),
      reason: String(parsed.book.reason || '').slice(0, 80),
    } : null;

    const center = String(parsed.center || interests[0]).slice(0, 30);
    const summary = String(parsed.summary || '').slice(0, 80);

    // コンパス履歴を保存（全件公開）。中心語＋興味語の両方に索引を張る。
    try {
      const id = await redis('INCR', 'compassseq');
      const cid = `c${id}`;
      const ts = Date.now();
      // 圧縮形式で保存
      const rec = {
        i: interests.slice(0, 12),
        c: center,
        s: summary,
        r: recommendations.map(r => ({ discipline: r.discipline, color: r.color, domain: r.domain, distance: r.distance, reason: r.reason, value: r.value })),
        b: book,
        t: ts,
      };
      await redis('SET', `compasslog:${cid}`, JSON.stringify(rec));
      // 索引：中心語＋興味語のユニーク集合
      const indexWords = [...new Set([center, ...interests].map(w => String(w || '').slice(0, 50)).filter(Boolean))];
      for (const w of indexWords.slice(0, 15)) {
        await redis('ZADD', `compassword:${w}`, ts, cid);
        await redis('ZREMRANGEBYRANK', `compassword:${w}`, 0, -101); // 各語最新100件
        await redis('SADD', 'compass:words', w); // 星雲側でボタン表示判定に使う
      }
    } catch {}

    return res.status(200).json({
      center,
      summary,
      book,
      recommendations,
      creditsLeft: compassCredits - 3,
    });
  } catch (err) {
    console.error(err);
    // 生成失敗時はクレジットを返却
    try { if (compassEmail) await redis('INCRBY', `credits:${compassEmail}`, 3); } catch {}
    return res.status(502).json({ error: 'コンパスの生成に失敗しました' });
  }
}
