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
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'コンパスの生成に失敗しました' });
  }
}
