// api/word.js
// SEO用ロングテールページ。/word/孤独 のような各語の静的HTMLを返す。
// ハイブリッド方式：初回アクセスで生成→Redisにキャッシュ（7日）。以降はキャッシュを返す。
//   - 関連語は星雲データ（edge:WORD）を優先し、不足分をAI（Haiku）で補完。
//   - Googleにインデックスされることで、「〇〇 類語」等の検索流入を自動化する。

import { redis } from './_redis.js';

const SITE = process.env.SITE_URL || 'https://goispace.app';
const AMAZON_TAG = process.env.AMAZON_TAG || 'goispacead-22';

// クローラー（ボット）判定。新規AI生成を人間の実訪問だけに限定するために使う。
// 【対策B】robots.txtを無視するボットへの実力行使。
// AIスクレイパー・SEO分析ツールは検索流入に寄与せず、CPUだけを消費するため即座に遮断する。
// 検索エンジン（Googlebot/Bingbot等）はここに含めない＝SEOには一切影響しない。
function isBlockedBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return false; // UAなしはisBot側で軽量ページ扱い（ここでは遮断しない）
  return /gptbot|chatgpt-user|ccbot|claudebot|anthropic-ai|perplexitybot|bytespider|amazonbot|applebot-extended|meta-externalagent|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|dataforseobot|blexbot|serpstatbot|zoominfobot|imagesiftbot/i.test(ua);
}

function isBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true; // UAなしは機械アクセスとみなす（安全側）
  return /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|vkshare|whatsapp|telegram|discordbot|googlebot|bingbot|yandex|baidu|duckduck|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|gptbot|ccbot|claudebot|anthropic|perplexity|amazonbot|applebot|headless|python-requests|curl|wget|scrapy|http-client|go-http|okhttp/i.test(ua);
}

// Amazonアソシエイト検索リンク（書籍カテゴリ）
function amazonSearch(query) {
  const q = encodeURIComponent(String(query || '').slice(0, 60));
  return `https://www.amazon.co.jp/s?k=${q}&i=stripbooks&tag=${AMAZON_TAG}`;
}
const CACHE_TTL = 60 * 60 * 24 * 7; // 7日

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 星雲データ（共起グラフ）から関連語を取得
async function relatedFromNebula(word) {
  try {
    const raw = await redis('ZREVRANGE', `edge:${word}`, 0, 19, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < (raw?.length || 0); i += 2) {
      out.push({ word: raw[i], weight: Number(raw[i + 1]) });
    }
    return out;
  } catch { return []; }
}

// 利用者の活動データ（探索経路・コンパス記録・藍の夢）を集める
// → 集合知がそのままSEOテキストに還元される
async function gatherActivity(word) {
  const out = { routes: [], compass: [], ainoyume: [] };
  // 探索経路：この語を通った旅
  try {
    const ids = await redis('ZREVRANGE', `pathword:${word}`, 0, 4) || [];
    for (const pid of ids) {
      if (out.routes.length >= 3) break;
      try {
        const raw = await redis('GET', `path:${pid}`);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        const words = rec.w || rec.words || [];
        if (words.length >= 2) out.routes.push(words.slice(0, 12));
      } catch {}
    }
  } catch {}
  // コンパス記録：この語を含む興味から導かれた分野
  try {
    const ids = await redis('ZREVRANGE', `compassword:${word}`, 0, 3) || [];
    for (const cid of ids) {
      if (out.compass.length >= 2) break;
      try {
        const raw = await redis('GET', `compasslog:${cid}`);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        out.compass.push({
          interests: (rec.i || []).slice(0, 6),
          summary: rec.s || '',
          domains: (rec.r || []).slice(0, 3).map(r => ({ disc: r.discipline || '', dom: r.domain || '' })),
        });
      } catch {}
    }
  } catch {}
  // 藍の夢：この語が登場した知の航海図
  try {
    const ids = await redis('ZREVRANGE', `ayword:${word}`, 0, 3) || [];
    for (const aid of ids) {
      if (out.ainoyume.length >= 2) break;
      try {
        const raw = await redis('GET', `ainoyume:${aid}`);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        const item = (rec.d || []).find(x => x.k === word || x.n === word);
        out.ainoyume.push({ goal: rec.g || '', title: rec.ti || '', gist: item ? (item.g || '') : '' });
      } catch {}
    }
  } catch {}
  return out;
}

// AIで語をカテゴリ分類生成（Haiku・安価）
async function relatedFromAI(word) {
  const prompt = `日本語の言葉「${word}」について、語彙辞典のページを作ります。
「${word}」自身は類語等に含めないこと。次のJSON形式のみで出力（前後の説明・マークダウン不可）：
{
 "reading":"${word}のよみがな",
 "summary":"${word}の意味・ニュアンスの説明（80字以内）",
 "meaning_long":"${word}の意味をより詳しく、使われる文脈やニュアンスの違いも含めて説明（200字以内）",
 "synonyms":["類義語・関連語を8語"],
 "antonyms":["対義語・対比となる語を4語"],
 "related":["連想される語・周辺概念を8語"],
 "examples":["${word}を使った自然な例文を3つ（各40字以内）"],
 "etymology":"${word}の語源・成り立ち・由来（120字以内。不明なら空文字）",
 "english":["${word}に対応する英語表現を2〜3語"],
 "book_theme":"${word}を深く知るために読むとよい本のテーマやジャンル（Amazon検索に使う短い語句）"
}`;
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
        max_tokens: 1100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    let txt = (data.content || []).map(c => c.text || '').join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
    const p = JSON.parse(txt);
    return {
      reading: String(p.reading || '').slice(0, 40),
      summary: String(p.summary || '').slice(0, 200),
      meaning_long: String(p.meaning_long || '').slice(0, 300),
      synonyms: (p.synonyms || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 10),
      antonyms: (p.antonyms || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 6),
      related: (p.related || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 10),
      examples: (p.examples || []).map(w => String(w).slice(0, 80)).filter(Boolean).slice(0, 4),
      etymology: String(p.etymology || '').slice(0, 200),
      english: (p.english || []).map(w => String(w).slice(0, 40)).filter(Boolean).slice(0, 4),
      book_theme: String(p.book_theme || '').slice(0, 40),
    };
  } catch {
    return { reading: '', summary: '', meaning_long: '', synonyms: [], antonyms: [], related: [], examples: [], etymology: '', english: [], book_theme: '' };
  }
}

// 活動データをHTMLセクションに（存在するものだけ）
function activityHTML(word, activity) {
  if (!activity) return '';
  const parts = [];
  if (activity.routes && activity.routes.length) {
    const rows = activity.routes.map(words =>
      `<div class="route-row">${words.map(w => `<a class="chip neb" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('<span class="route-arrow">→</span>')}</div>`
    ).join('');
    parts.push(`<section><h2>「${esc(word)}」を通った言葉の旅</h2><p class="note">GOI-Spaceの利用者が「${esc(word)}」を経由して実際にたどった探索の道筋です。</p>${rows}</section>`);
  }
  if (activity.compass && activity.compass.length) {
    const rows = activity.compass.map(c => {
      const doms = c.domains.map(d => `${esc(d.disc)}「${esc(d.dom)}」`).join('、');
      return `<div class="act-card"><div class="act-line">興味：${c.interests.map(w => esc(w)).join('、')}</div>${c.summary ? `<div class="act-sub">${esc(c.summary)}</div>` : ''}${doms ? `<div class="act-sub">導かれた領域：${doms}</div>` : ''}</div>`;
    }).join('');
    parts.push(`<section><h2>「${esc(word)}」から知的コンパスが導いた先</h2><p class="note">この語を興味に含めた人が、どんな学問領域へ導かれたかの記録です。</p>${rows}</section>`);
  }
  if (activity.ainoyume && activity.ainoyume.length) {
    const rows = activity.ainoyume.map(a =>
      `<div class="act-card"><div class="act-line">目標：${esc(a.goal)}${a.title ? `（航海図「${esc(a.title)}」）` : ''}</div>${a.gist ? `<div class="act-sub">この語の位置づけ：${esc(a.gist)}</div>` : ''}</div>`
    ).join('');
    parts.push(`<section><h2>「${esc(word)}」が登場した知の航海図</h2><p class="note">「藍の夢」で紡がれた、目標達成のための知の地図にこの語が現れた記録です。</p>${rows}</section>`);
  }
  return parts.join('\n');
}

// ===== トレンド機能 =====
// Google公式のトレンドRSS（trends.google.com/trending/rss?geo=JP）から急上昇語を取得。
async function fetchTrendWords(limit) {
  try {
    const resp = await fetch('https://trends.google.com/trending/rss?geo=JP', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoiSpaceTrendBot/1.0)' },
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const grab = (block, tag) => {
      const mm = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return mm ? decode(mm[1]) : '';
    };
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    // フィルタで一部が落ちるため、多めに候補を集める
    while ((m = itemRe.exec(xml)) && items.length < limit * 6) {
      const block = m[1];
      const word = grab(block, 'title').slice(0, 40);
      if (!word) continue;
      // 関連ニュース見出しを収集（なぜ話題になったかのコンテキスト）
      const news = [];
      const nRe = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
      let nm;
      while ((nm = nRe.exec(block)) && news.length < 3) {
        const nb = nm[1];
        const title = grab(nb, 'ht:news_item_title');
        const source = grab(nb, 'ht:news_item_source');
        if (title) news.push({ title: title.slice(0, 120), source: source.slice(0, 40) });
      }
      items.push({ word, news });
    }
    // 【方針B】日本語（ひらがな・カタカナ・漢字）を1文字も含まない語は除外
    const hasJapanese = (s) => /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(s);
    return items.filter(it => hasJapanese(it.word)).slice(0, limit);
  } catch {
    return [];
  }
}

// トレンド語が「なぜ話題になったか」を関連ニュース見出しから一文に要約する。
async function summarizeTrendContext(word, news) {
  const headlines = news.map(n => `・${n.title}${n.source ? `（${n.source}）` : ''}`).join('\n');
  const prompt = `「${word}」がGoogleで急上昇しました。関連ニュース見出しは以下です。
${headlines}

この語がなぜ今話題になっているのかを、事実に基づいて簡潔な一文（40字以内）で説明してください。憶測は避け、見出しから読み取れる範囲で書くこと。説明文のみを出力し、前置きや引用符は不要です。`;
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
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    const txt = (data.content || []).map(c => c.text || '').join('').trim();
    return txt.slice(0, 100);
  } catch {
    return '';
  }
}

// 【施策4】既存語のページを深掘りする追加コンテンツを生成する。
// 検索実績のある語に「使い分け・ニュアンス・敬語・英語での言い分け・よくある誤用」を足して厚くする。
async function deepenWordData(word, data) {
  const syn = (data.synonyms || []).slice(0, 5).join('、');
  const prompt = `日本語の言葉「${word}」の解説ページを充実させます。
${data.summary ? `この語の意味：${data.summary}` : ''}
${syn ? `類語：${syn}` : ''}

次のJSON形式のみで出力（前後の説明・マークダウン不可）：
{
 "usage":"「${word}」の使い方・使われる場面を具体的に説明（200字以内）",
 "nuance":"類語との使い分け・ニュアンスの違いを具体的に説明（200字以内）",
 "keigo":"「${word}」を丁寧・改まった場面で使う際の言い換えや表現（120字以内。該当しなければ空文字）",
 "english_note":"英語で表現する際の使い分けの注意点（120字以内。該当しなければ空文字）",
 "mistakes":"「${word}」でよくある誤用・混同しやすい点（120字以内。なければ空文字）"
}`;
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
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await resp.json();
    let txt = (d.content || []).map(c => c.text || '').join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
    const p = JSON.parse(txt);
    const out = {
      usage: String(p.usage || '').slice(0, 300),
      nuance: String(p.nuance || '').slice(0, 300),
      keigo: String(p.keigo || '').slice(0, 200),
      english_note: String(p.english_note || '').slice(0, 200),
      mistakes: String(p.mistakes || '').slice(0, 200),
    };
    return (out.usage || out.nuance) ? out : null;
  } catch {
    return null;
  }
}

// 【施策3】2語の違いを解説するデータを生成する（「A B 違い」クエリ向け）。
async function compareWordsAI(a, b) {
  const prompt = `日本語の「${a}」と「${b}」の違いを解説します。
次のJSON形式のみで出力（前後の説明・マークダウン不可）：
{
 "summary":"${a}と${b}の違いを一言で（60字以内）",
 "a_desc":"${a}の意味と特徴（150字以内）",
 "b_desc":"${b}の意味と特徴（150字以内）",
 "difference":"両者の違いを、使う場面・ニュアンス・対象の観点から具体的に説明（250字以内）",
 "a_example":"${a}を使った例文（40字以内）",
 "b_example":"${b}を使った例文（40字以内）",
 "usage_tip":"どちらを使うべきかの判断のポイント（120字以内）"
}`;
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
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await resp.json();
    let txt = (d.content || []).map(c => c.text || '').join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
    const p = JSON.parse(txt);
    const out = {
      summary: String(p.summary || '').slice(0, 120),
      a_desc: String(p.a_desc || '').slice(0, 250),
      b_desc: String(p.b_desc || '').slice(0, 250),
      difference: String(p.difference || '').slice(0, 400),
      a_example: String(p.a_example || '').slice(0, 80),
      b_example: String(p.b_example || '').slice(0, 80),
      usage_tip: String(p.usage_tip || '').slice(0, 200),
    };
    return out.difference ? out : null;
  } catch {
    return null;
  }
}

// 比較ページのHTMLを組み立てる
function buildCompareHTML(a, b, c) {
  const title = `「${a}」と「${b}」の違いとは？使い分けをわかりやすく解説 | 語彙空間`;
  const desc = c.summary
    ? `${a}と${b}の違い：${c.summary} 使い分けのポイント・例文つきで解説。`.slice(0, 155)
    : `「${a}」と「${b}」の違い・使い分けを、意味・ニュアンス・例文から解説します。`;
  const url = `${SITE}/compare/${encodeURIComponent(a)}-vs-${encodeURIComponent(b)}`;

  const faqs = [
    {
      '@type': 'Question',
      name: `${a}と${b}の違いは？`,
      acceptedAnswer: { '@type': 'Answer', text: (c.difference || c.summary || '').slice(0, 300) },
    },
    {
      '@type': 'Question',
      name: `${a}と${b}はどう使い分ける？`,
      acceptedAnswer: { '@type': 'Answer', text: (c.usage_tip || c.difference || '').slice(0, 300) },
    },
  ];
  const jsonldFaq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs,
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<link rel="icon" href="/favicon.svg">
<script type="application/ld+json">${JSON.stringify(jsonldFaq).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9246118623869056" crossorigin="anonymous"></script>
<style>
:root{--bg:#080C18;--surface:#111726;--border:#233047;--text:#E8EDF5;--muted:#8595B3;--amber:#F5A623}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;line-height:1.9}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 80px}
.logo{font-size:14px;color:var(--muted);text-decoration:none;letter-spacing:.1em}
h1{font-size:26px;margin:20px 0 16px;line-height:1.5}
h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:8px;margin:32px 0 14px}
.summary{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:8px;padding:14px 16px;font-size:15px;margin-bottom:24px}
.prose{font-size:15px;line-height:1.9}
.vs-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0}
.vs-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
.vs-card h3{margin:0 0 10px;font-size:17px;color:var(--amber)}
.vs-card p{font-size:14px;margin:0 0 10px;line-height:1.8}
.vs-ex{font-size:13px;color:var(--muted);border-left:2px solid var(--border);padding-left:10px;margin-top:10px}
.cta{display:block;text-align:center;background:linear-gradient(135deg,#5B8FDE,#9B72E8);color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-size:15px;margin:26px 0;font-weight:600}
.ad-slot{margin:28px 0;min-height:100px;text-align:center}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.links a{display:inline-block;padding:8px 15px;border-radius:16px;text-decoration:none;font-size:14px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.links a:hover{border-color:var(--amber);color:var(--amber)}
footer{text-align:center;font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:20px;margin-top:48px}
footer a{color:var(--muted);margin:0 8px}
@media(max-width:600px){.vs-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<a class="logo" href="/">語彙空間 GOI-Space</a>
<h1>「${esc(a)}」と「${esc(b)}」の違い</h1>
${c.summary ? `<div class="summary">${esc(c.summary)}</div>` : ''}

<div class="vs-grid">
  <div class="vs-card">
    <h3>${esc(a)}</h3>
    ${c.a_desc ? `<p>${esc(c.a_desc)}</p>` : ''}
    ${c.a_example ? `<div class="vs-ex">例：${esc(c.a_example)}</div>` : ''}
  </div>
  <div class="vs-card">
    <h3>${esc(b)}</h3>
    ${c.b_desc ? `<p>${esc(c.b_desc)}</p>` : ''}
    ${c.b_example ? `<div class="vs-ex">例：${esc(c.b_example)}</div>` : ''}
  </div>
</div>

${c.difference ? `<section><h2>両者の違い</h2><p class="prose">${esc(c.difference)}</p></section>` : ''}

<div class="ad-slot">
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-9246118623869056" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>

${c.usage_tip ? `<section><h2>どちらを使うべき？判断のポイント</h2><p class="prose">${esc(c.usage_tip)}</p></section>` : ''}

<section>
  <h2>それぞれの語をさらに詳しく</h2>
  <div class="links">
    <a href="/word/${encodeURIComponent(a)}">「${esc(a)}」の意味・類語・例文</a>
    <a href="/word/${encodeURIComponent(b)}">「${esc(b)}」の意味・類語・例文</a>
  </div>
</section>

<a class="cta" href="/?q=${encodeURIComponent(a)}">語彙の星図で「${esc(a)}」と「${esc(b)}」のつながりを探索する →</a>

<footer>
  <a href="/">トップ</a><a href="/words">語彙さくいん</a><a href="/about.html">サイトについて</a><a href="/privacy.html">プライバシー</a>
</footer>
</div>
</body>
</html>`;
}

// 【品質フィルタ】sitemapに載せる価値のある「充実データ」かを判定する。
// 意味・類語に加えて、例文または詳細説明まで揃っているものだけを「rich」とする。
function isRichData(data) {
  if (!data) return false;
  const hasCore = !!(data.summary && data.synonyms && data.synonyms.length >= 3);
  const hasDepth = !!((data.examples && data.examples.length >= 2) || (data.meaning_long && data.meaning_long.length >= 60));
  return hasCore && hasDepth;
}

// 1語分のSEOデータをAI生成して永続保存する（トレンドジョブ用に再利用可能）。
async function generateAndSaveData(word) {
  const dataKey = `seodata:${word}`;
  try {
    const existing = await redis('GET', dataKey);
    if (existing) return { word, status: 'exists' }; // 既に生成済みなら再生成しない
  } catch {}
  const ai = await relatedFromAI(word);
  const data = {
    reading: ai.reading, summary: ai.summary, meaning_long: ai.meaning_long,
    synonyms: ai.synonyms, antonyms: ai.antonyms, related: ai.related,
    examples: ai.examples, etymology: ai.etymology, english: ai.english, book_theme: ai.book_theme,
  };
  const ok = !!(data.summary || (data.synonyms && data.synonyms.length));
  if (!ok) return { word, status: 'failed' };
  try {
    await redis('SET', dataKey, JSON.stringify(data));
    await redis('SADD', 'seo:words', word);
    if (isRichData(data)) await redis('SADD', 'seo:rich', word);
  } catch {}
  return { word, status: 'generated' };
}

function buildHTML(word, data, nebulaWords, activity) {
  // 【広告の出し分け】充実したページ（rich基準）でのみ広告を表示する。
  // 薄いページ＋広告は「広告のためのページ」と判定されるAdSense審査リスクの核心。
  const showAds = isRichData(data);
  // タイトル：検索実績のあるクエリ型（「◯◯とは」「◯◯ 言い換え」「◯◯ 類語」「◯◯ 対義語」）を反映。
  // 「言い換え」は類語より検索されやすい日本語SEOの定番語なので必ず含める。
  const title = `${word}とは？意味・言い換え・類語・対義語をわかりやすく解説 | 語彙空間`;
  // ディスクリプション：定型文ではなく、実際の類語・対義語を見せて「答えがここにある」と伝える。
  const synPreview = (data.synonyms || []).slice(0, 3).join('・');
  const antPreview = (data.antonyms || []).slice(0, 2).join('・');
  let desc;
  if (data.summary) {
    const parts = [`${word}${data.reading ? `（${data.reading}）` : ''}とは、${data.summary}`];
    if (synPreview) parts.push(`言い換え・類語は${synPreview}など。`);
    if (antPreview) parts.push(`対義語は${antPreview}など。`);
    parts.push('例文・語源も掲載。');
    desc = parts.join('').slice(0, 155);
  } else {
    desc = `「${word}」の意味・言い換え・類語・対義語・例文・語源を掲載。語彙空間 GOI-Space で意味のつながりを探索できます。`;
  }
  const url = `${SITE}/word/${encodeURIComponent(word)}`;

  const chipList = (arr, cls) => arr.map(w =>
    `<a class="chip ${cls}" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('');

  // 星雲データ由来の「実際によく一緒に辿られた語」
  // 【独自データの主役化】利用者の実探索から生まれた集合知データ。
  // ミニ星図Canvas＝このサイトにしかない体験。滞在時間と差別化の要。
  const totalTraversals = nebulaWords.reduce((s, n) => s + (n.weight || 0), 0);
  const st = (activity && activity.stats) || {};
  const statsStrip = (st.connections || st.thisMonth)
    ? `<div class="stat-strip">${st.connections ? `<span class="stat"><b>${st.connections}</b> 種類の言葉と接続</span>` : ''}${st.thisMonth ? `<span class="stat"><b>${st.thisMonth}</b> 回 今月探索された</span>` : ''}<span class="stat"><b>${totalTraversals}</b> 回 延べ探索</span></div>`
    : '';
  const miniMapData = JSON.stringify({
    center: word,
    nodes: nebulaWords.slice(0, 12).map(n => ({ w: n.word, v: n.weight || 1 })),
  }).replace(/</g, '\\u003c');
  const nebulaChips = nebulaWords.length
    ? `<section class="original-data">
<h2>「${esc(word)}」から実際に辿られた言葉<span class="od-badge">本サイト独自データ</span></h2>
<p class="note">語彙空間 GOI-Space の利用者が「${esc(word)}」を探索した際に、実際に次へ辿った言葉の記録です（延べ${totalTraversals}回の探索から）。辞書の類語とは異なる、人々の連想の実像を映しています。</p>
${statsStrip}
<div class="minimap-wrap">
  <canvas id="miniMap" width="640" height="320"></canvas>
  <div class="minimap-hint">★をクリックすると、その言葉のページへ。中心の「${esc(word)}」をクリックすると星図で本格探索できます。</div>
</div>
<div class="chips">${nebulaWords.map(n => `<a class="chip neb" href="/word/${encodeURIComponent(n.word)}">${esc(n.word)}${n.weight > 1 ? `<span class="neb-w">${n.weight}</span>` : ''}</a>`).join('')}</div>
</section>
<script id="miniMapData" type="application/json">${miniMapData}</script>`
    : '';

  // 構造化データ：DefinedTerm＋FAQPage。
  // FAQPageは「◯◯とは？」「◯◯の言い換えは？」等のQ&Aをリッチリザルト化し、同順位でもCTRを高める狙い。
  const jsonldTerm = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: word,
    description: data.summary || `${word}の類語・関連語`,
    inDefinedTermSet: `${SITE}`,
    url,
  };
  const faqs = [];
  if (data.summary) {
    faqs.push({
      '@type': 'Question',
      name: `${word}とは？意味は？`,
      acceptedAnswer: { '@type': 'Answer', text: `${word}${data.reading ? `（${data.reading}）` : ''}とは、${data.summary}${data.meaning_long ? ` ${data.meaning_long}` : ''}`.slice(0, 300) },
    });
  }
  if (data.synonyms && data.synonyms.length) {
    faqs.push({
      '@type': 'Question',
      name: `${word}の言い換え・類語は？`,
      acceptedAnswer: { '@type': 'Answer', text: `${word}の言い換え・類語には、${data.synonyms.slice(0, 8).join('、')}などがあります。` },
    });
  }
  if (data.antonyms && data.antonyms.length) {
    faqs.push({
      '@type': 'Question',
      name: `${word}の対義語は？`,
      acceptedAnswer: { '@type': 'Answer', text: `${word}の対義語には、${data.antonyms.slice(0, 6).join('、')}などがあります。` },
    });
  }
  if (data.etymology) {
    faqs.push({
      '@type': 'Question',
      name: `${word}の語源・由来は？`,
      acceptedAnswer: { '@type': 'Answer', text: data.etymology.slice(0, 300) },
    });
  }
  if (data.nuance) {
    faqs.push({
      '@type': 'Question',
      name: `${word}と類語の使い分けは？`,
      acceptedAnswer: { '@type': 'Answer', text: data.nuance.slice(0, 300) },
    });
  }
  if (data.usage) {
    faqs.push({
      '@type': 'Question',
      name: `${word}はどんな場面で使う？`,
      acceptedAnswer: { '@type': 'Answer', text: data.usage.slice(0, 300) },
    });
  }
  const jsonldFaq = faqs.length >= 2 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs,
  } : null;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:image" content="${SITE}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index, follow">
<link rel="icon" href="/favicon.svg">
<script type="application/ld+json">${JSON.stringify(jsonldTerm).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>
${jsonldFaq ? `<script type="application/ld+json">${JSON.stringify(jsonldFaq).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>` : ''}
<style>
:root{--bg:#080C18;--surface:#111726;--border:#233047;--text:#E8EDF5;--muted:#8595B3;--amber:#F5A623;--blue:#5B8FDE;--rose:#E06B8B;--green:#4ECBA8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;line-height:1.7}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px}
header{text-align:center;padding:20px 0 10px}
.logo{font-size:14px;color:var(--muted);text-decoration:none;letter-spacing:.1em}
h1{font-size:34px;margin:18px 0 6px;font-weight:700}
.reading{color:var(--muted);font-size:15px;margin-bottom:14px}
.summary{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:8px;padding:14px 16px;font-size:15px;margin-bottom:24px}
.trend-banner{background:linear-gradient(135deg,#241010,#1a1420);border:1px solid rgba(255,90,90,0.4);border-radius:8px;padding:12px 15px;font-size:14px;color:#e8b0b0;margin-bottom:16px;line-height:1.6}
.trend-banner b{color:#ff9a9a}
.cta{display:block;text-align:center;background:var(--amber);color:#080C18;font-weight:700;font-size:16px;text-decoration:none;padding:14px;border-radius:10px;margin:26px 0}
section{margin-bottom:26px}
h2{font-size:18px;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:14px}
.note{font-size:12px;color:var(--muted);margin:-6px 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-block;padding:7px 14px;border-radius:18px;text-decoration:none;font-size:15px;border:1px solid var(--border);background:var(--surface);color:var(--text);transition:all .15s}
.chip:hover{border-color:var(--amber);color:var(--amber)}
.chip.syn{border-color:rgba(78,203,168,0.4)}
.chip.ant{border-color:rgba(224,107,139,0.4)}
.chip.rel{border-color:rgba(91,143,222,0.4)}
.chip.neb{border-color:rgba(245,166,35,0.5);background:rgba(245,166,35,0.06);display:inline-flex;align-items:center;gap:6px}
.neb-w{font-size:10px;color:var(--muted);background:rgba(245,166,35,0.12);border-radius:8px;padding:1px 6px}
.original-data{background:linear-gradient(135deg,rgba(245,166,35,0.05),rgba(91,143,222,0.04));border:1px solid rgba(245,166,35,0.3);border-radius:12px;padding:18px 18px 14px;margin:24px 0}
.original-data h2{border-bottom:none;padding-bottom:0;margin:0 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.od-badge{font-size:10.5px;font-weight:600;color:#080C18;background:var(--amber);border-radius:10px;padding:3px 10px;letter-spacing:.03em}
.minimap-wrap{margin:14px 0}
#miniMap{width:100%;height:auto;border-radius:10px;border:1px solid var(--border);display:block}
.minimap-hint{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}
.stat-strip{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 4px}
.stat{font-size:12px;color:var(--muted)}
.stat b{color:var(--amber);font-size:15px;margin-right:2px}
footer{text-align:center;font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:20px;margin-top:40px}
footer a{color:var(--muted)}
.ad-slot{margin:28px 0;min-height:100px;text-align:center}
.prose{font-size:15px;line-height:1.9;color:var(--text)}
.examples{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.examples li{background:var(--surface);border:1px solid var(--border);border-left:3px solid rgba(91,143,222,0.5);border-radius:8px;padding:10px 14px;font-size:15px;line-height:1.7}
.chip.eng{border-color:rgba(120,200,180,0.4);cursor:default}
.books-sec h2{margin-bottom:6px}
.books{display:flex;flex-direction:column;gap:9px;margin-top:12px}
.book-link{display:block;background:linear-gradient(135deg,#2a1e0e,#1a1408);border:1px solid rgba(245,166,35,0.4);border-radius:10px;padding:13px 16px;text-decoration:none;color:var(--amber);font-size:15px;font-weight:600;transition:all .15s}
.book-link:hover{border-color:var(--amber);background:linear-gradient(135deg,#3a2a12,#241a0c)}
.route-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px}
.route-arrow{color:var(--muted);font-size:12px}
.act-card{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:11px 14px;margin-bottom:9px}
.act-line{font-size:14px;color:var(--text);font-weight:600}
.act-sub{font-size:13px;color:var(--muted);line-height:1.7;margin-top:4px}
</style>
${showAds ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9246118623869056" crossorigin="anonymous"></script>` : ''}
</head>
<body>
<div class="wrap">
<header>
  <a class="logo" href="/">語彙空間 GOI-Space</a>
  <h1>${esc(word)}</h1>
  ${data.reading ? `<div class="reading">${esc(data.reading)}</div>` : ''}
</header>
${data.trendContext ? `<div class="trend-banner">🔥 <b>今話題の言葉</b>：${esc(data.trendContext)}</div>` : ''}
${data.summary ? `<div class="summary">${esc(data.summary)}</div>` : ''}
<a class="cta" href="/?q=${encodeURIComponent(word)}">「${esc(word)}」を星図で探索する →</a>
${data.meaning_long ? `<section><h2>「${esc(word)}」とは？意味を解説</h2><p class="prose">${esc(data.meaning_long)}</p></section>` : ''}
${nebulaChips}
${data.usage ? `<section><h2>「${esc(word)}」の使い方</h2><p class="prose">${esc(data.usage)}</p></section>` : ''}
${data.examples && data.examples.length ? `<section><h2>例文</h2><ul class="examples">${data.examples.map(e => `<li>${esc(e)}</li>`).join('')}</ul></section>` : ''}
${data.synonyms.length ? `<section><h2>「${esc(word)}」の言い換え・類語</h2><div class="chips">${chipList(data.synonyms, 'syn')}</div></section>` : ''}
${showAds ? `<div class="ad-slot">
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-9246118623869056" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>` : ''}
${data.antonyms.length ? `<section><h2>「${esc(word)}」の対義語</h2><div class="chips">${chipList(data.antonyms, 'ant')}</div></section>` : ''}
${data.related.length ? `<section><h2>連想語・周辺概念</h2><div class="chips">${chipList(data.related, 'rel')}</div></section>` : ''}
${data.nuance ? `<section><h2>類語との使い分け・ニュアンスの違い</h2><p class="prose">${esc(data.nuance)}</p></section>` : ''}
${data.etymology ? `<section><h2>語源・由来</h2><p class="prose">${esc(data.etymology)}</p></section>` : ''}
${data.keigo ? `<section><h2>丁寧な言い方・改まった表現</h2><p class="prose">${esc(data.keigo)}</p></section>` : ''}
${data.mistakes ? `<section><h2>よくある誤用・注意点</h2><p class="prose">${esc(data.mistakes)}</p></section>` : ''}
${data.english && data.english.length ? `<section><h2>英語で言うと</h2><div class="chips">${data.english.map(e => `<span class="chip eng">${esc(e)}</span>`).join('')}</div>${data.english_note ? `<p class="prose" style="margin-top:10px">${esc(data.english_note)}</p>` : ''}</section>` : ''}
${data.synonyms && data.synonyms.length ? `<section><h2>「${esc(word)}」との違いを比較する</h2><p class="note">似た言葉との違い・使い分けを解説しています。</p><div class="chips">${data.synonyms.slice(0, 4).map(s => `<a class="chip" href="/compare/${encodeURIComponent(word)}-vs-${encodeURIComponent(s)}">${esc(word)} と ${esc(s)} の違い</a>`).join('')}</div></section>` : ''}
${activityHTML(word, activity)}
<section class="books-sec">
  <h2>「${esc(word)}」をもっと知る本</h2>
  <p class="note">この言葉やそのテーマを深めたい方へ。</p>
  <div class="books">
    <a class="book-link" href="${amazonSearch(word)}" target="_blank" rel="noopener nofollow">📚「${esc(word)}」に関する本を探す</a>
    ${data.book_theme ? `<a class="book-link" href="${amazonSearch(data.book_theme)}" target="_blank" rel="noopener nofollow">📖「${esc(data.book_theme)}」の本を探す</a>` : ''}
    <a class="book-link" href="${amazonSearch(word + ' 語源 由来')}" target="_blank" rel="noopener nofollow">🔍 語源・由来の本を探す</a>
  </div>
</section>
${showAds ? `<div class="ad-slot">
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-9246118623869056" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>` : ''}
<a class="cta" href="/?q=${encodeURIComponent(word)}">語彙の星雲で「${esc(word)}」を探索する →</a>
<footer>
  <p>「${esc(word)}」の意味のつながりを、語彙空間 GOI-Space の星図でインタラクティブに探索できます。</p>
  <p><a href="/">トップページ</a> ・ <a href="/words">語彙さくいん</a> ・ <a href="/guide.html">使い方ガイド</a> ・ <a href="/about.html">サイトについて</a> ・ <a href="/privacy.html">プライバシー</a></p>
</footer>
</div>
<script>
(function(){
  var el=document.getElementById('miniMapData');
  var cv=document.getElementById('miniMap');
  if(!el||!cv)return;
  var data;try{data=JSON.parse(el.textContent)}catch(e){return}
  var ctx=cv.getContext('2d');
  var W=cv.width,H=cv.height,CX=W/2,CY=H/2;
  var maxV=Math.max.apply(null,data.nodes.map(function(n){return n.v}).concat([1]));
  // ノード配置：中心語の周囲に重み順で円状配置（重いほど近い）
  var nodes=data.nodes.map(function(n,i){
    var ang=(i/data.nodes.length)*Math.PI*2-Math.PI/2+(i%2?0.18:-0.12);
    var norm=n.v/maxV;
    var r=70+(1-norm)*80;
    return{w:n.w,v:n.v,x:CX+Math.cos(ang)*r*1.55,y:CY+Math.sin(ang)*r*0.82,rad:4+norm*5};
  });
  var stars=[];for(var i=0;i<60;i++)stars.push({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.1+0.2,tw:Math.random()*Math.PI*2});
  var hover=-1,t=0;
  function draw(){
    t+=0.016;
    ctx.fillStyle='#080C18';ctx.fillRect(0,0,W,H);
    for(var i=0;i<stars.length;i++){var s=stars[i];var a=0.25+0.35*Math.abs(Math.sin(t+s.tw));ctx.fillStyle='rgba(255,255,255,'+a+')';ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,7);ctx.fill();}
    // エッジ
    for(var i=0;i<nodes.length;i++){var n=nodes[i];
      ctx.strokeStyle=i===hover?'rgba(245,166,35,0.7)':'rgba(120,150,220,0.22)';
      ctx.lineWidth=i===hover?1.6:0.8;
      ctx.beginPath();ctx.moveTo(CX,CY);ctx.lineTo(n.x,n.y);ctx.stroke();}
    // 周辺ノード
    ctx.textAlign='center';ctx.textBaseline='top';
    for(var i=0;i<nodes.length;i++){var n=nodes[i];
      var pulse=1+0.12*Math.sin(t*2+i);
      ctx.fillStyle=i===hover?'#F5A623':'#9BB4E8';
      ctx.beginPath();ctx.arc(n.x,n.y,n.rad*pulse,0,7);ctx.fill();
      ctx.fillStyle=i===hover?'#FFD27A':'#C8D4F0';
      ctx.font=(i===hover?'600 ':'')+'12px sans-serif';
      ctx.fillText(n.w,n.x,n.y+n.rad+4);}
    // 中心語
    var cp=1+0.08*Math.sin(t*1.5);
    var grad=ctx.createRadialGradient(CX,CY,0,CX,CY,26*cp);
    grad.addColorStop(0,'rgba(245,166,35,0.9)');grad.addColorStop(1,'rgba(245,166,35,0)');
    ctx.fillStyle=grad;ctx.beginPath();ctx.arc(CX,CY,26*cp,0,7);ctx.fill();
    ctx.fillStyle='#FFE9C0';ctx.beginPath();ctx.arc(CX,CY,7,0,7);ctx.fill();
    ctx.fillStyle='#FFF';ctx.font='600 14px sans-serif';
    ctx.fillText(data.center,CX,CY+14);
    requestAnimationFrame(draw);
  }
  function pick(mx,my){
    var d=Math.hypot(mx-CX,my-CY);if(d<30)return'center';
    for(var i=0;i<nodes.length;i++){if(Math.hypot(mx-nodes[i].x,my-nodes[i].y)<22)return i;}
    return -1;
  }
  function pos(e){var r=cv.getBoundingClientRect();var sx=W/r.width,sy=H/r.height;
    var cx=(e.touches?e.touches[0].clientX:e.clientX),cy=(e.touches?e.touches[0].clientY:e.clientY);
    return{x:(cx-r.left)*sx,y:(cy-r.top)*sy};}
  cv.addEventListener('mousemove',function(e){var p=pos(e);var h=pick(p.x,p.y);hover=(typeof h==='number')?h:-1;cv.style.cursor=(h!==-1&&h!==undefined)?'pointer':'default';});
  cv.addEventListener('click',function(e){var p=pos(e);var h=pick(p.x,p.y);
    if(h==='center'){location.href='/?q='+encodeURIComponent(data.center);}
    else if(typeof h==='number'&&h>=0){location.href='/word/'+encodeURIComponent(nodes[h].w);}});
  draw();
})();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  // 【対策B】遮断対象ボットは、Redisアクセスもページ組み立ても行わずに即返す。
  // robots.txtを無視するスクレイパーからCPU時間を守るための最初の関門。
  if (isBlockedBot(req)) {
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(403).send('Forbidden');
  }

  // 【メンテナンス】既存の永続seopageキャッシュにTTLを付与して容量を段階的に解放する。
  // 使い方: /api/word?cleanup=1&key=<CLEANUP_SECRET>&batch=500
  if (req.query && req.query.cleanup === '1') {
    const secret = process.env.CLEANUP_SECRET || '';
    if (!secret || req.query.key !== secret) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const batch = Math.min(parseInt(req.query.batch, 10) || 500, 2000);
    const ttl = 60 * 60 * 24 * 3; // 3日後に消える
    let processed = 0, expired = 0;
    try {
      const words = await redis('SMEMBERS', 'seo:words') || [];
      for (const w of words.slice(0, batch)) {
        processed++;
        try {
          // TTL未設定（=永続）のものだけにTTLを付ける
          const t = await redis('TTL', `seopage:${w}`);
          if (t === -1) { await redis('EXPIRE', `seopage:${w}`, ttl); expired++; }
        } catch {}
      }
    } catch {}
    return res.status(200).json({ processed, expired, note: `${expired}件にTTL(3日)を付与しました。数日で容量が解放されます。` });
  }

  // 【トレンドジョブ】週次Cronから叩く。Google急上昇語を取得しSEOページを生成、時期つきで記録。
  // 使い方: /api/word?trendjob=1&key=<TREND_SECRET>  （Vercel Cronで週1回）
  // 【施策2】計画生成ジョブ：検索需要のある語をまとめてSEOページ化する。
  // 使い方: POST /api/word?bulkjob=1&key=<TREND_SECRET>  body: {"words":["語1","語2",...]}
  // または GET  /api/word?bulkjob=1&key=...&src=nebula&limit=200
  //   src=nebula … 星雲でよく辿られているのに未生成の語を優先生成（実需のある語）
  // レート制限とは別枠。1回のリクエストで limit 件までを生成する（複数回叩いて積み上げる）。
  if (req.query && req.query.bulkjob === '1') {
    const secret = process.env.TREND_SECRET || '';
    const cronSecret = process.env.CRON_SECRET || '';
    const auth = String(req.headers['authorization'] || '');
    const okByKey = secret && req.query.key === secret;
    const okByCron = cronSecret && auth === `Bearer ${cronSecret}`;
    if (!okByKey && !okByCron) return res.status(403).json({ error: 'forbidden' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300); // 1回あたりの上限（タイムアウト対策）
    let candidates = [];

    if (req.method === 'POST' && req.body && Array.isArray(req.body.words)) {
      // 明示的に語リストを渡された場合
      candidates = req.body.words.map(w => String(w || '').trim()).filter(Boolean).slice(0, 1000);
    } else if (req.query.src === 'nebula') {
      // 星雲でよく辿られている語（＝実際に人が興味を持った語）から、未生成のものを拾う
      try {
        const neb = await redis('ZREVRANGE', 'nebula:words', 0, 4999) || [];
        const generated = new Set(await redis('SMEMBERS', 'seo:words') || []);
        candidates = neb.filter(w => w && !generated.has(w));
      } catch {}
    }

    if (!candidates.length) {
      return res.status(200).json({ ok: true, generated: 0, note: '生成対象の語がありませんでした' });
    }

    // 逐次生成（並列にするとAPIレート制限に当たりやすいので順に処理）
    const target = candidates.slice(0, limit);
    let generated = 0, skipped = 0, failed = 0;
    for (const w of target) {
      const r = await generateAndSaveData(w);
      if (r.status === 'generated') generated++;
      else if (r.status === 'exists') skipped++;
      else failed++;
    }
    return res.status(200).json({
      ok: true, generated, skipped, failed,
      remaining: Math.max(0, candidates.length - target.length),
      note: `${generated}語を新規生成しました。remainingが残っていれば再実行してください。`,
    });
  }

  // 【施策4】深掘りジョブ：既存ページに「使い分け・敬語・英語での言い分け」等を追記して厚くする。
  // 使い方: POST /api/word?deepenjob=1&key=<TREND_SECRET>  body: {"words":["実質的","副次効果",...]}
  // 検索実績のある勝ちページ（Search Consoleの上位語）を指定して、1ページの充実度を上げる。
  if (req.query && req.query.deepenjob === '1') {
    const secret = process.env.TREND_SECRET || '';
    if (!secret || req.query.key !== secret) return res.status(403).json({ error: 'forbidden' });
    if (req.method !== 'POST' || !req.body || !Array.isArray(req.body.words)) {
      return res.status(400).json({ error: 'POSTで {"words":[...]} を渡してください' });
    }
    const target = req.body.words.map(w => String(w || '').trim()).filter(Boolean).slice(0, 50);
    let deepened = 0, failed = 0;
    for (const w of target) {
      try {
        const raw = await redis('GET', `seodata:${w}`);
        if (!raw) { failed++; continue; }
        const data = JSON.parse(raw);
        const extra = await deepenWordData(w, data);
        if (!extra) { failed++; continue; }
        const merged = { ...data, ...extra };
        await redis('SET', `seodata:${w}`, JSON.stringify(merged));
        if (isRichData(merged)) await redis('SADD', 'seo:rich', w);
        await redis('DEL', `seopage:${w}`); // HTMLバッファを消して次回アクセスで再構築
        deepened++;
      } catch { failed++; }
    }
    return res.status(200).json({ ok: true, deepened, failed });
  }

  // 【施策3】比較ページ /compare/A-vs-B （「A B 違い」クエリを狙う）
  if (req.query && req.query.compare) {
    const raw = String(req.query.compare || '');
    const parts = raw.split('-vs-');
    if (parts.length !== 2) return res.status(404).send('Not found');
    const a = decodeURIComponent(parts[0]).trim().slice(0, 30);
    const b = decodeURIComponent(parts[1]).trim().slice(0, 30);
    if (!a || !b || a === b) return res.status(404).send('Not found');

    const key = `cmp:${a}\u0001${b}`;
    // 生成済みデータがあれば、それを使って組み立て（AIを呼ばない）
    let c = null;
    try {
      const saved = await redis('GET', key);
      if (saved) c = JSON.parse(saved);
    } catch {}

    if (!c) {
      // 未生成：ボットには生成させない（コスト暴走防止。人間の訪問のみが生成のトリガー）
      if (isBot(req)) {
        res.setHeader('X-Robots-Tag', 'noindex, follow');
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        return res.status(200).send(buildCompareHTML(a, b, { summary: '', a_desc: '', b_desc: '', difference: '', a_example: '', b_example: '', usage_tip: '' }));
      }
      c = await compareWordsAI(a, b);
      if (!c) return res.status(502).send('生成に失敗しました');
      try {
        await redis('SET', key, JSON.stringify(c)); // 永続保存（軽量）
        await redis('SADD', 'cmp:pairs', `${a}\u0001${b}`);
      } catch {}
    }

    const html = buildCompareHTML(a, b, c);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
    return res.status(200).send(html);
  }

  // 【施策3】比較ページの計画生成ジョブ：星雲でよく一緒に辿られたペアから比較ページを作る。
  // 使い方: GET /api/word?cmpjob=1&key=<TREND_SECRET>&limit=50
  if (req.query && req.query.cmpjob === '1') {
    const secret = process.env.TREND_SECRET || '';
    if (!secret || req.query.key !== secret) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    // 星雲の上位語について、強く結ばれた隣接語とのペアを候補にする（＝実際に関連が深い語の組）
    const pairs = [];
    try {
      const top = await redis('ZREVRANGE', 'nebula:words', 0, 199) || [];
      const done = new Set(await redis('SMEMBERS', 'cmp:pairs') || []);
      for (const w of top) {
        if (pairs.length >= limit) break;
        const adj = await redis('ZREVRANGE', `edge:${w}`, 0, 2) || [];
        for (const o of adj) {
          if (!o || o === w) continue;
          const [a, b] = w < o ? [w, o] : [o, w];
          const k = `${a}\u0001${b}`;
          if (done.has(k)) continue;
          done.add(k);
          pairs.push([a, b]);
          if (pairs.length >= limit) break;
        }
      }
    } catch {}

    if (!pairs.length) return res.status(200).json({ ok: true, generated: 0, note: '候補ペアがありません' });

    let generated = 0, failed = 0;
    for (const [a, b] of pairs) {
      const c = await compareWordsAI(a, b);
      if (!c) { failed++; continue; }
      try {
        await redis('SET', `cmp:${a}\u0001${b}`, JSON.stringify(c));
        await redis('SADD', 'cmp:pairs', `${a}\u0001${b}`);
        generated++;
      } catch { failed++; }
    }
    return res.status(200).json({ ok: true, generated, failed });
  }

  // 【対策2】品質分類バックフィル：既存の全語を検査し、充実データを持つ語をseo:richに登録する。
  // 使い方: GET /api/word?richjob=1&key=<TREND_SECRET>&cursor=0&batch=2000
  // レスポンスの nextCursor を次回の cursor に渡して、全語を数回に分けて処理する。
  if (req.query && req.query.richjob === '1') {
    const secret = process.env.TREND_SECRET || '';
    if (!secret || req.query.key !== secret) return res.status(403).json({ error: 'forbidden' });
    const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
    const batch = Math.min(parseInt(req.query.batch, 10) || 2000, 5000);
    let all = [];
    try { all = (await redis('SMEMBERS', 'seo:words') || []).filter(Boolean).sort(); } catch {}
    const slice = all.slice(cursor, cursor + batch);
    let rich = 0, thin = 0, noData = 0;
    // 並列バッチでseodataを検査（40件ずつ）
    const B = 40;
    for (let i = 0; i < slice.length; i += B) {
      const group = slice.slice(i, i + B);
      const results = await Promise.all(group.map(async (w) => {
        try {
          const raw = await redis('GET', `seodata:${w}`);
          if (!raw) return { w, s: 'nodata' };
          const d = JSON.parse(raw);
          return { w, s: isRichData(d) ? 'rich' : 'thin' };
        } catch { return { w, s: 'nodata' }; }
      }));
      for (const r of results) {
        if (r.s === 'rich') { rich++; try { await redis('SADD', 'seo:rich', r.w); } catch {} }
        else if (r.s === 'thin') thin++;
        else noData++;
      }
    }
    const nextCursor = cursor + slice.length;
    return res.status(200).json({
      ok: true, processed: slice.length, rich, thin, noData,
      nextCursor: nextCursor < all.length ? nextCursor : null,
      total: all.length,
      note: nextCursor < all.length ? `続き: &cursor=${nextCursor}` : '全語の分類が完了しました',
    });
  }

  if (req.query && req.query.trendjob === '1') {
    const secret = process.env.TREND_SECRET || '';
    const cronSecret = process.env.CRON_SECRET || '';
    const auth = String(req.headers['authorization'] || '');
    const okByKey = secret && req.query.key === secret;
    const okByCron = cronSecret && auth === `Bearer ${cronSecret}`;
    if (!okByKey && !okByCron) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const trends = await fetchTrendWords(10);
    if (!trends.length) {
      return res.status(200).json({ ok: false, note: 'トレンド取得に失敗（前回分を維持）' });
    }
    const now = Date.now();
    const results = [];
    for (const t of trends) {
      const w = t.word;
      const r = await generateAndSaveData(w); // 既存ならスキップ、新規のみAI生成
      results.push(r);
      try {
        // トレンド語の記録（取得時刻をscoreに。時期表示・並び替えに使う）
        await redis('ZADD', 'trend:words', now, w);
        // 語ごとの「話題になった時期」を保存（最初の登場時期を優先）
        const seen = await redis('GET', `trend:seen:${w}`);
        if (!seen) await redis('SET', `trend:seen:${w}`, String(now));
        // なぜ話題になったか（関連ニュース見出し）を保存。AIで簡潔な一文の背景に要約する。
        if (t.news && t.news.length) {
          const ctx = await summarizeTrendContext(w, t.news);
          if (ctx) await redis('SET', `trend:ctx:${w}`, ctx);
        }
      } catch {}
    }
    // トレンド一覧は直近60語まで保持（古いものは索引から外す。ページ本体・seodataは残る）
    try { await redis('ZREMRANGEBYRANK', 'trend:words', 0, -61); } catch {}
    return res.status(200).json({ ok: true, count: trends.length, results });
  }

  // 【トレンド語の取得】入口画面・語彙索引で表示するための一覧（新しい順）。
  if (req.query && req.query.trends === '1') {
    try {
      const raw = await redis('ZREVRANGE', 'trend:words', 0, 11, 'WITHSCORES') || [];
      const items = [];
      for (let i = 0; i < raw.length; i += 2) {
        const word = raw[i];
        let ctx = '';
        try { ctx = await redis('GET', `trend:ctx:${word}`) || ''; } catch {}
        items.push({ word, ts: Number(raw[i + 1]), context: ctx });
      }
      res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400');
      return res.status(200).json({ items });
    } catch {
      return res.status(200).json({ items: [] });
    }
  }

  // サイトマップ（/word?sitemap=1 または /sitemap.xml をrewrite）
  // 語彙さくいん（/words）：全語をページ切替・頭文字辞書引き・ランダム注目で閲覧
  if (req.query && req.query.list === '1') {
    const set = new Set();
    try { (await redis('SMEMBERS', 'seo:words') || []).forEach(w => set.add(w)); } catch {}
    try { (await redis('ZREVRANGE', 'nebula:words', 0, 9999) || []).forEach(w => set.add(w)); } catch {}
    let all = [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
    const total = all.length;

    // 頭文字（五十音の個別文字）判定。濁音・半濁音・拗音・小書きは清音の基本形に正規化する。
    const kanaChar = (w) => {
      const c = (w[0] || '');
      const code = c.charCodeAt(0);
      let ch = c;
      // カタカナはひらがなに寄せる
      if (code >= 0x30A1 && code <= 0x30F6) ch = String.fromCharCode(code - 0x60);
      // 濁音・半濁音・拗音・小書きを清音の基本形へ正規化
      const NORM = {
        'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
        'が': 'か', 'ぎ': 'き', 'ぐ': 'く', 'げ': 'け', 'ご': 'こ',
        'ざ': 'さ', 'じ': 'し', 'ず': 'す', 'ぜ': 'せ', 'ぞ': 'そ',
        'だ': 'た', 'ぢ': 'ち', 'づ': 'つ', 'で': 'て', 'ど': 'と', 'っ': 'つ',
        'ば': 'は', 'び': 'ひ', 'ぶ': 'ふ', 'べ': 'へ', 'ぼ': 'ほ',
        'ぱ': 'は', 'ぴ': 'ひ', 'ぷ': 'ふ', 'ぺ': 'へ', 'ぽ': 'ほ',
        'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ',
      };
      if (NORM[ch]) ch = NORM[ch];
      const GOJUON = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
      if (GOJUON.includes(ch)) return ch;
      if (/[0-9０-９]/.test(c)) return '数字';
      if (/[a-zA-Zａ-ｚＡ-Ｚ]/.test(c)) return '英語';
      return '漢字';
    };
    // 行（あ・か・さ…）→ その行に属する個別文字（あいうえお等）
    const GOJUON_ROWS = [
      ['あ', ['あ', 'い', 'う', 'え', 'お']],
      ['か', ['か', 'き', 'く', 'け', 'こ']],
      ['さ', ['さ', 'し', 'す', 'せ', 'そ']],
      ['た', ['た', 'ち', 'つ', 'て', 'と']],
      ['な', ['な', 'に', 'ぬ', 'ね', 'の']],
      ['は', ['は', 'ひ', 'ふ', 'へ', 'ほ']],
      ['ま', ['ま', 'み', 'む', 'め', 'も']],
      ['や', ['や', 'ゆ', 'よ']],
      ['ら', ['ら', 'り', 'る', 'れ', 'ろ']],
      ['わ', ['わ', 'を', 'ん']],
    ];
    const OTHER_CATS = ['数字', '英語', '漢字'];
    const ALL_CHARS = [...GOJUON_ROWS.flatMap(([, cs]) => cs), ...OTHER_CATS];

    // 頭文字フィルタ（個別文字 or 数字/英語/漢字）
    const row = String(req.query.row || '').slice(0, 2);
    if (row && ALL_CHARS.includes(row)) all = all.filter(w => kanaChar(w) === row);
    // row表示用のラベル（数字/英語/漢字はそのまま、五十音は「から始まる」で自然に読めるようにする）
    const rowLabel = row ? (OTHER_CATS.includes(row) ? row : `「${row}」から始まる語`) : '';

    // ページング（1ページ60語）
    const PER = 60;
    const pages = Math.max(1, Math.ceil(all.length / PER));
    let page = parseInt(req.query.page, 10) || 1;
    if (page < 1) page = 1;
    if (page > pages) page = pages;
    const pageWords = all.slice((page - 1) * PER, page * PER);
    const links = pageWords.map(w => `<a class="w" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('');

    // ランダムに注目の言葉を数語ピックアップ（全体から）
    const allArr = [...set].filter(Boolean);
    const featured = [];
    const pick = Math.min(8, allArr.length);
    const used = new Set();
    for (let i = 0; i < pick; i++) {
      let idx = Math.floor(Math.random() * allArr.length);
      let guard = 0;
      while (used.has(idx) && guard++ < 20) idx = Math.floor(Math.random() * allArr.length);
      used.add(idx);
      featured.push(allArr[idx]);
    }
    const featuredLinks = featured.map(w => `<a class="w feat" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('');

    // トレンド語（話題の言葉）を取得して、時期＋なぜ話題かの背景つきで表示
    let trendLinks = '';
    try {
      const traw = await redis('ZREVRANGE', 'trend:words', 0, 11, 'WITHSCORES') || [];
      const titems = [];
      for (let i = 0; i < traw.length; i += 2) {
        const w = traw[i];
        let ctx = '';
        try { ctx = await redis('GET', `trend:ctx:${w}`) || ''; } catch {}
        titems.push({ word: w, ts: Number(traw[i + 1]), context: ctx });
      }
      trendLinks = titems.map(t => {
        const d = new Date(t.ts);
        const ym = `${d.getFullYear()}年${d.getMonth() + 1}月`;
        return `<a class="trend-card" href="/word/${encodeURIComponent(t.word)}">
          <div class="trend-card-head"><span class="trend-card-word">${esc(t.word)}</span><span class="trend-when">${ym}</span></div>
          ${t.context ? `<div class="trend-card-ctx">${esc(t.context)}</div>` : ''}
        </a>`;
      }).join('');
    } catch {}

    // 今月よく探索されている言葉（行動統計に基づく独自ランキング）
    let hotLinks = '';
    try {
      const ym = new Date().toISOString().slice(0, 7);
      const hraw = await redis('ZREVRANGE', `wmonth:${ym}`, 0, 11, 'WITHSCORES') || [];
      const hitems = [];
      for (let i = 0; i < hraw.length; i += 2) hitems.push({ word: hraw[i], n: Number(hraw[i + 1]) });
      hotLinks = hitems.map(h => `<a class="w feat" href="/word/${encodeURIComponent(h.word)}">${esc(h.word)}<span class="hot-n">${h.n}回</span></a>`).join('');
    } catch {}

    // 頭文字タブ（2階層：行グループの中に個別文字。「すべて」＋数字/英語/漢字も）
    const base = '/words';
    const charLink = (c) => `<a class="char-tab ${row === c ? 'on' : ''}" href="${base}?row=${encodeURIComponent(c)}">${esc(c)}</a>`;
    const rowGroups = GOJUON_ROWS.map(([label, chars]) =>
      `<div class="kana-group"><span class="kana-group-label">${label}行</span><div class="kana-group-chars">${chars.map(charLink).join('')}</div></div>`
    ).join('');
    const otherGroup = `<div class="kana-group"><span class="kana-group-label">その他</span><div class="kana-group-chars">${OTHER_CATS.map(charLink).join('')}</div></div>`;
    const rowTabs = `<a class="row-tab all ${!row ? 'on' : ''}" href="${base}">すべて表示</a>` +
      `<div class="kana-groups">${rowGroups}${otherGroup}</div>`;

    // ページャ（前後＋現在地）
    const qRow = row ? `&row=${encodeURIComponent(row)}` : '';
    const rel = (p) => `${base}?page=${p}${qRow}`;
    let pager = '';
    if (pages > 1) {
      const prev = page > 1 ? `<a class="pg" rel="prev" href="${rel(page - 1)}">‹ 前へ</a>` : `<span class="pg disabled">‹ 前へ</span>`;
      const next = page < pages ? `<a class="pg" rel="next" href="${rel(page + 1)}">次へ ›</a>` : `<span class="pg disabled">次へ ›</span>`;
      // 近傍ページ番号
      const nums = [];
      const from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
      if (from > 1) nums.push(`<a class="pgn" href="${rel(1)}">1</a>${from > 2 ? '<span class="pgdot">…</span>' : ''}`);
      for (let p = from; p <= to; p++) nums.push(`<a class="pgn ${p === page ? 'on' : ''}" href="${rel(p)}">${p}</a>`);
      if (to < pages) nums.push(`${to < pages - 1 ? '<span class="pgdot">…</span>' : ''}<a class="pgn" href="${rel(pages)}">${pages}</a>`);
      pager = `<nav class="pager">${prev}<span class="pgnums">${nums.join('')}</span>${next}</nav>`;
    }

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>語彙さくいん${page > 1 ? `（${page}ページ目）` : ''}${row ? `${OTHER_CATS.includes(row) ? row : `「${row}」`}の語` : ''} | 語彙空間 GOI-Space</title>
<meta name="description" content="語彙空間 GOI-Space の語彙辞典さくいん。各語の意味・類語・対義語・例文・語源のページを、頭文字やページ送りで閲覧できます。">
<link rel="canonical" href="${SITE}/words${page > 1 || row ? `?${row ? `row=${encodeURIComponent(row)}` : ''}${row && page > 1 ? '&' : ''}${page > 1 ? `page=${page}` : ''}` : ''}">
<meta name="robots" content="index, follow">
${page > 1 ? `<link rel="prev" href="${SITE}${rel(page - 1)}">` : ''}
${page < pages ? `<link rel="next" href="${SITE}${rel(page + 1)}">` : ''}
<link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#080C18;--surface:#111726;--border:#233047;--text:#E8EDF5;--muted:#8595B3;--amber:#F5A623}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;line-height:1.8}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
.logo{font-size:14px;color:var(--muted);text-decoration:none;letter-spacing:.1em}
h1{font-size:24px;margin:18px 0 8px}
h2{font-size:15px;color:var(--amber);margin:26px 0 10px}
.lead{font-size:14px;color:var(--muted);margin-bottom:20px}
.list{display:flex;flex-wrap:wrap;gap:9px}
.w{display:inline-block;padding:7px 14px;border-radius:16px;text-decoration:none;font-size:14px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.w:hover{border-color:var(--amber);color:var(--amber)}
.w.feat{border-color:rgba(245,166,35,0.4);background:linear-gradient(135deg,#1c1608,#111726);display:inline-flex;align-items:center;gap:7px}
.hot-n{font-size:10px;color:var(--muted);border-left:1px solid var(--border);padding-left:7px}
.trend-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:8px}
.trend-card{display:block;text-decoration:none;border:1px solid rgba(255,90,90,0.4);border-radius:10px;padding:12px 14px;background:linear-gradient(135deg,#241010,#111726);transition:all .15s}
.trend-card:hover{border-color:#ff6b6b;background:linear-gradient(135deg,#301414,#141726)}
.trend-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.trend-card-word{font-size:15px;font-weight:600;color:#e8b0b0}
.trend-when{font-size:10px;color:var(--muted);white-space:nowrap}
.trend-card-ctx{font-size:12px;color:#b9c0d0;line-height:1.6;margin-top:6px}
.rows{margin:8px 0 22px}
.row-tab{display:inline-block;padding:6px 14px;border-radius:14px;text-decoration:none;font-size:13px;border:1px solid var(--border);color:var(--muted);margin-bottom:12px}
.row-tab.all{font-weight:600}
.row-tab.on{background:var(--amber);color:#080C18;border-color:var(--amber);font-weight:600}
.row-tab:hover{border-color:var(--amber);color:var(--text)}
.kana-groups{display:flex;flex-wrap:wrap;gap:14px}
.kana-group{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:7px 10px}
.kana-group-label{font-size:11px;color:var(--muted);white-space:nowrap}
.kana-group-chars{display:flex;gap:4px}
.char-tab{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border-radius:8px;text-decoration:none;font-size:13px;border:1px solid var(--border);color:var(--text);background:var(--bg)}
.char-tab.on{background:var(--amber);color:#080C18;border-color:var(--amber);font-weight:600}
.char-tab:hover{border-color:var(--amber);color:var(--amber)}
.pager{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:30px;flex-wrap:wrap}
.pg{padding:8px 16px;border-radius:8px;text-decoration:none;font-size:14px;border:1px solid var(--border);color:var(--text)}
.pg.disabled{opacity:.35;pointer-events:none}
.pg:hover{border-color:var(--amber)}
.pgnums{display:flex;gap:4px;align-items:center}
.pgn{min-width:30px;text-align:center;padding:6px 8px;border-radius:6px;text-decoration:none;font-size:13px;color:var(--muted)}
.pgn.on{background:var(--surface);color:var(--amber);font-weight:600}
.pgn:hover{color:var(--text)}
.pgdot{color:var(--muted);padding:0 2px}
.meta{font-size:12px;color:var(--muted);text-align:center;margin-top:12px}
footer{text-align:center;font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:20px;margin-top:40px}
footer a{color:var(--muted);margin:0 8px}
</style>
</head>
<body>
<div class="wrap">
<a class="logo" href="/">語彙空間 GOI-Space</a>
<h1>語彙さくいん</h1>
<p class="lead">各語の意味・類語・対義語・例文・語源をまとめた語彙辞典です。利用者の探索によって、ページは日々増えています（全 ${total} 語）。</p>
${!row && page === 1 && trendLinks ? `<h2>🔥 話題の言葉（Googleトレンドより）</h2><div class="trend-grid">${trendLinks}</div>` : ''}
${!row && page === 1 && hotLinks ? `<h2>📈 今月よく探索されている言葉<span style="font-size:11px;color:var(--muted);font-weight:400;margin-left:10px">利用者の実探索データ</span></h2><div class="list">${hotLinks}</div>` : ''}
${!row && page === 1 && featuredLinks ? `<h2>今日の注目の言葉</h2><div class="list">${featuredLinks}</div>` : ''}
<h2>五十音から引く</h2>
<div class="rows">${rowTabs}</div>
<div class="list">${links || '<span style="color:var(--muted)">この頭文字の語はまだありません。</span>'}</div>
${pager}
<p class="meta">${rowLabel ? `${esc(rowLabel)} ` : ''}${all.length} 語中 ${(page - 1) * PER + 1}〜${Math.min(page * PER, all.length)} 語目${pages > 1 ? `（${page} / ${pages} ページ）` : ''}</p>
<footer>
  <a href="/">トップ</a><a href="/guide.html">使い方ガイド</a><a href="/about.html">サイトについて</a><a href="/privacy.html">プライバシー</a>
</footer>
</div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 【対策A】語彙さくいんは8万語のソート・分類を伴う最も重い処理。
    // CDN(s-maxage)で長くキャッシュすれば関数が起動せずCPU消費ゼロになる。
    // stale-while-revalidateで、期限切れ後も古い版を即返しつつ裏で更新（体感速度も維持）。
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=43200, stale-while-revalidate=86400');
    return res.status(200).send(html);
  }

  // 【施策1】サイトマップ分割：1ファイル5万URL上限のため、インデックス＋分割ファイル構成にする。
  // /sitemap.xml        → サイトマップインデックス（子ファイルの一覧）
  // /sitemap-N.xml      → 語ページ2万件ずつの分割サイトマップ
  if (req.query && (req.query.sitemap || req.url?.includes('sitemap'))) {
    const PER_MAP = 20000; // 1ファイルあたりのURL数（上限5万に対し余裕を持たせる）
    let words = [];
    // 【対策2】品質フィルタ：充実データを持つ語（seo:rich）だけをsitemapに載せる。
    // 薄いページをGoogleに提示しないことで、サイト全体の品質評価を守る。
    // seo:richが未整備（バックフィル前）の間は従来のseo:wordsを使う。
    try {
      words = (await redis('SMEMBERS', 'seo:rich') || []).filter(Boolean);
      if (words.length < 100) words = (await redis('SMEMBERS', 'seo:words') || []).filter(Boolean);
    } catch {}
    const chunks = Math.max(1, Math.ceil(words.length / PER_MAP));

    // 子サイトマップ（?sitemap=1&part=N）
    const part = parseInt(req.query.part, 10);
    if (part >= 1 && part <= chunks) {
      const slice = words.slice((part - 1) * PER_MAP, part * PER_MAP);
      const urls = slice.map(w =>
        `<url><loc>${SITE}/word/${encodeURIComponent(w)}</loc><changefreq>weekly</changefreq></url>`
      ).join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
      return res.status(200).send(xml);
    }

    // 親：サイトマップインデックス（固定ページ用の1件＋語ページの分割ファイル群）
    const today = new Date().toISOString().slice(0, 10);
    const maps = [`<sitemap><loc>${SITE}/sitemap-pages.xml</loc><lastmod>${today}</lastmod></sitemap>`];
    for (let i = 1; i <= chunks; i++) {
      maps.push(`<sitemap><loc>${SITE}/sitemap-${i}.xml</loc><lastmod>${today}</lastmod></sitemap>`);
    }
    maps.push(`<sitemap><loc>${SITE}/sitemap-compare.xml</loc><lastmod>${today}</lastmod></sitemap>`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${maps.join('\n')}
</sitemapindex>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).send(xml);
  }

  // 比較ページのサイトマップ
  if (req.query && req.query.sitemapcompare === '1') {
    let pairs = [];
    try { pairs = (await redis('SMEMBERS', 'cmp:pairs') || []).filter(Boolean); } catch {}
    const urls = pairs.slice(0, 45000).map(p => {
      const [a, b] = p.split('\u0001');
      if (!a || !b) return '';
      return `<url><loc>${SITE}/compare/${encodeURIComponent(a)}-vs-${encodeURIComponent(b)}</loc><changefreq>monthly</changefreq></url>`;
    }).filter(Boolean).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).send(xml);
  }

  // 固定ページ用のサイトマップ（トップ・さくいん・about）
  if (req.query && req.query.sitemappages === '1') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
<url><loc>${SITE}/words</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
<url><loc>${SITE}/about.html</loc><changefreq>monthly</changefreq></url>
<url><loc>${SITE}/guide.html</loc><changefreq>monthly</changefreq></url>
</urlset>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).send(xml);
  }

  // 語を取得（/word/孤独 または ?w=孤独）
  let word = '';
  if (req.query && req.query.w) word = req.query.w;
  else if (req.query && req.query.word) word = req.query.word;
  else {
    const m = (req.url || '').match(/\/word\/([^/?#]+)/);
    if (m) { try { word = decodeURIComponent(m[1]); } catch { word = m[1]; } }
  }
  word = String(word || '').trim().slice(0, 40);

  if (!word) {
    res.setHeader('Location', '/');
    return res.status(302).end();
  }

  const dataKey = `seodata:${word}`; // AI生成データ（軽量・永続）
  const cacheKey = `seopage:${word}`; // 組み立て済みHTML（短期バッファのみ）

  // まず組み立て済みHTMLの短期キャッシュを確認（あれば即返す）
  try {
    const cached = await redis('GET', cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
      return res.status(200).send(cached);
    }
  } catch {}

  // 星雲データ・活動データは常に取得（AIを使わない・安価）
  const ym = new Date().toISOString().slice(0, 7);
  const [nebulaWords, activity, connCount, monthCount] = await Promise.all([
    relatedFromNebula(word),
    gatherActivity(word),
    redis('ZCARD', `edge:${word}`).catch(() => 0),
    redis('ZSCORE', `wmonth:${ym}`, word).catch(() => null),
  ]);
  // 行動統計をactivityに載せてbuildHTMLへ渡す
  activity.stats = { connections: Number(connCount) || 0, thisMonth: Number(monthCount) || 0 };

  // トレンド語なら「なぜ話題か」の背景を取得してページ上部に表示する
  let trendContext = '';
  try { trendContext = await redis('GET', `trend:ctx:${word}`) || ''; } catch {}

  // AI生成データが永続保存されていれば、それを使ってHTMLを組み立て直す（AIを呼ばない）。
  // これにより、一度生成した語は常に「完全版」を返せる。容量はHTML全文より遥かに小さい。
  let data = null;
  try {
    const savedRaw = await redis('GET', dataKey);
    if (savedRaw) data = JSON.parse(savedRaw);
  } catch {}

  if (data) {
    if (trendContext) data.trendContext = trendContext;
    const html = buildHTML(word, data, nebulaWords.slice(0, 16), activity);
    // 組み立て済みHTMLは短期バッファとしてのみ保持（実キャッシュはVercel CDN）。
    try {
      await redis('SET', cacheKey, html, 'EX', 60 * 60 * 24 * 3); // 3日バッファ
      await redis('SADD', 'seo:words', word);
    } catch {}
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
    return res.status(200).send(html);
  }

  // ===== ここから先は「初めての語」＝AI生成が必要 =====
  // 【方針A】新規AI生成は人間の実訪問のみをトリガーとする。
  // ボット（クローラー）が未生成の語を踏んでも、AIは呼ばず軽量ページを返す。
  // これにより、8万語規模のクロールでAIコストが青天井になるのを断ち切る。
  // 生成済みの語（seodataあり）は上の分岐で完全版を返すので、SEOインデックスは守られる。
  const light = () => {
    const lightData = { reading: '', summary: '', meaning_long: '', synonyms: [], antonyms: [], related: [], examples: [], etymology: '', english: [], book_theme: '' };
    const lightHtml = buildHTML(word, lightData, nebulaWords.slice(0, 16), activity);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 未生成の軽量ページはインデックスさせない（薄いページの評価を避ける）。
    // 完全版が生成されれば通常の index ページとして扱われる。
    res.setHeader('X-Robots-Tag', 'noindex, follow');
    // 未生成の軽量ページ：ボットが繰り返し叩くのでCDNで長めに保持し、関数起動を抑える。
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).send(lightHtml);
  };

  if (isBot(req)) return light(); // ボットには生成させない

  // 【方針C】新規AI生成のレート上限（人間の実需では超えない低めの天井＝コストの保険）
  const GEN_LIMIT_PER_HOUR = 20;
  let canGenerate = true;
  try {
    const hourKey = `seogen:${new Date().toISOString().slice(0, 13)}`;
    const n = await redis('INCR', hourKey);
    if (n === 1) await redis('EXPIRE', hourKey, 3700);
    if (n > GEN_LIMIT_PER_HOUR) canGenerate = false;
  } catch {}

  if (!canGenerate) return light(); // 上限超過時も軽量ページ（次の訪問で完全版に昇格）

  // 上限内：AIで完全なデータを生成
  const ai = await relatedFromAI(word);
  data = {
    reading: ai.reading,
    summary: ai.summary,
    meaning_long: ai.meaning_long,
    synonyms: ai.synonyms,
    antonyms: ai.antonyms,
    related: ai.related,
    examples: ai.examples,
    etymology: ai.etymology,
    english: ai.english,
    book_theme: ai.book_theme,
  };

  // AIの応答が実質空（生成失敗）なら永続保存しない（次回リトライできるように）
  const generationOk = !!(data.summary || (data.synonyms && data.synonyms.length));
  if (trendContext) data.trendContext = trendContext;
  const html = buildHTML(word, data, nebulaWords.slice(0, 16), activity);

  try {
    if (generationOk) {
      await redis('SET', dataKey, JSON.stringify(data)); // ★AI生成データを永続保存（軽量）
      await redis('SADD', 'seo:words', word);
      if (isRichData(data)) await redis('SADD', 'seo:rich', word);
    }
    await redis('SET', cacheKey, html, 'EX', 60 * 60 * 24 * 3); // HTMLは3日バッファ
  } catch {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
  return res.status(200).send(html);
}
