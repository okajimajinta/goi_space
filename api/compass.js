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

import { setCors } from './_redis.js';

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
    // === 選書カードの詳細（あらすじ・推薦根拠・読者像）===
    if (req.body.bookDetail && req.body.bookDetail.title) {
      const bt = String(req.body.bookDetail.title).slice(0, 120);
      const ba = String(req.body.bookDetail.author || '').slice(0, 60);
      const prompt = `ユーザーは次の言葉に興味があります：${list}
書籍「${bt}」${ba ? `（${ba}）` : ''}について案内してください。次のJSON形式のみで出力（前後の説明文なし）：
{
  "synopsis": "この本の簡単なあらすじ・内容紹介（100字以内）",
  "why": "なぜこのユーザーの興味にこの本を勧めるのか、その根拠（80字以内）",
  "reader": "この本に惹かれるのはどのような関心や精神を持つ人物像か（70字以内）"
}`;
      const parsed = await callClaude(prompt, 700);
      return res.status(200).json({
        synopsis: String(parsed.synopsis || '').slice(0, 240),
        why: String(parsed.why || '').slice(0, 200),
        reader: String(parsed.reader || '').slice(0, 180),
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
      const prompt = `ユーザーは次の言葉に興味があります：${list}
「知的コンパス」が、${dDisc}の視点から「${dDom}」という領域を推薦しました。
${depthNote}

この領域について、ユーザーの興味と結びつけて深く案内してください。次のJSON形式のみで出力（前後の説明文なし）：
{
  "relationship": "ユーザーの興味の性向と、この分野・領域がどう関係し、なぜ離れていて、繋ぐと何が生まれるか（150字以内）",
  "intro_books": [
    {"title": "入門書・前段に読むべき本や文書（日本語/英語可）", "author": "著者", "note": "なぜ最初に読むべきか30字以内"}
  ],
  "keywords": ["より深く知るためのキーワード5〜8個"],
  "universal_concept": "この領域を深く探求した先にある普遍的概念と、それがユーザーの知にもたらす意味（120字以内）"
}
intro_books は2〜3冊。実在する古典・名著を優先。`;
      const parsed = await callClaude(prompt, 1400);
      return res.status(200).json({
        relationship: String(parsed.relationship || '').slice(0, 400),
        intro_books: (parsed.intro_books || []).slice(0, 4).map(b => ({
          title: String(b.title || '').slice(0, 120),
          author: String(b.author || '').slice(0, 60),
          note: String(b.note || '').slice(0, 80),
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

次の6つの学問的視点それぞれから、ユーザーの興味と「文化的・知的に離れているが、繋ぐと豊かさが生まれる領域」を1つずつ提案してください。各視点の括弧内に、ユーザーの習熟度に応じた調整指示があれば従ってください：
${tuneLines}

各視点で、その領域を取り入れることで生まれる価値（新しい視点・創造性・意外な繋がり）を述べてください。文化的距離は1(隣接)〜10(対極)で表します。

加えて、ユーザーの興味の組み合わせに最も近い書籍を1冊案内してください（実在する名著・古典を優先）。

次のJSON形式のみで出力（前後の説明文なし）：
{
  "center": "ユーザーの興味を最も象徴する一語",
  "summary": "興味の傾向を40字以内で要約",
  "book": {"title": "最も近い書籍", "author": "著者", "reason": "なぜこの本が近いか40字以内"},
  "recommendations": [
    {"discipline": "自然科学", "domain": "領域名（短く）", "distance": 数値, "reason": "なぜ離れているか30字以内", "value": "取り入れると生まれる価値50字以内"}
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

    return res.status(200).json({
      center: String(parsed.center || interests[0]).slice(0, 30),
      summary: String(parsed.summary || '').slice(0, 80),
      book,
      recommendations,
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'コンパスの生成に失敗しました' });
  }
}
