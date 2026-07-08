// api/word.js
// SEO用ロングテールページ。/word/孤独 のような各語の静的HTMLを返す。
// ハイブリッド方式：初回アクセスで生成→Redisにキャッシュ（7日）。以降はキャッシュを返す。
//   - 関連語は星雲データ（edge:WORD）を優先し、不足分をAI（Haiku）で補完。
//   - Googleにインデックスされることで、「〇〇 類語」等の検索流入を自動化する。

import { redis } from './_redis.js';

const SITE = process.env.SITE_URL || 'https://goispace.app';
const AMAZON_TAG = process.env.AMAZON_TAG || 'goispacead-22';

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

function buildHTML(word, data, nebulaWords, activity) {
  const title = `「${word}」の意味・類語・対義語・例文・語源 | 語彙空間 GOI-Space`;
  const desc = data.summary
    ? `${word}（${data.reading}）の意味：${data.summary} 類語・対義語・例文・語源・英語も。語彙の星図で探索。`
    : `「${word}」の意味・類語・対義語・例文・語源・英語訳。語彙空間 GOI-Space で意味のつながりを探索できます。`;
  const url = `${SITE}/word/${encodeURIComponent(word)}`;

  const chipList = (arr, cls) => arr.map(w =>
    `<a class="chip ${cls}" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('');

  // 星雲データ由来の「実際によく一緒に辿られた語」
  const nebulaChips = nebulaWords.length
    ? `<section><h2>よく一緒に辿られる語</h2><p class="note">GOI-Spaceの利用者が「${esc(word)}」から実際に辿った語です。</p><div class="chips">${nebulaWords.map(n => `<a class="chip neb" href="/word/${encodeURIComponent(n.word)}">${esc(n.word)}</a>`).join('')}</div></section>`
    : '';

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: word,
    description: data.summary || `${word}の類語・関連語`,
    inDefinedTermSet: `${SITE}`,
    url,
  };

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
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>
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
.chip.neb{border-color:rgba(245,166,35,0.5);background:rgba(245,166,35,0.06)}
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9246118623869056" crossorigin="anonymous"></script>
</head>
<body>
<div class="wrap">
<header>
  <a class="logo" href="/">語彙空間 GOI-Space</a>
  <h1>${esc(word)}</h1>
  ${data.reading ? `<div class="reading">${esc(data.reading)}</div>` : ''}
</header>
${data.summary ? `<div class="summary">${esc(data.summary)}</div>` : ''}
<a class="cta" href="/?q=${encodeURIComponent(word)}">「${esc(word)}」を星図で探索する →</a>
${data.meaning_long ? `<section><h2>「${esc(word)}」の意味</h2><p class="prose">${esc(data.meaning_long)}</p></section>` : ''}
${data.examples && data.examples.length ? `<section><h2>例文</h2><ul class="examples">${data.examples.map(e => `<li>${esc(e)}</li>`).join('')}</ul></section>` : ''}
${data.synonyms.length ? `<section><h2>類語・関連語</h2><div class="chips">${chipList(data.synonyms, 'syn')}</div></section>` : ''}
<div class="ad-slot">
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-9246118623869056" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>
${data.antonyms.length ? `<section><h2>対義語・対比となる語</h2><div class="chips">${chipList(data.antonyms, 'ant')}</div></section>` : ''}
${data.related.length ? `<section><h2>連想語・周辺概念</h2><div class="chips">${chipList(data.related, 'rel')}</div></section>` : ''}
${data.etymology ? `<section><h2>語源・由来</h2><p class="prose">${esc(data.etymology)}</p></section>` : ''}
${data.english && data.english.length ? `<section><h2>英語で言うと</h2><div class="chips">${data.english.map(e => `<span class="chip eng">${esc(e)}</span>`).join('')}</div></section>` : ''}
${nebulaChips}
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
<div class="ad-slot">
<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-9246118623869056" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>
<a class="cta" href="/?q=${encodeURIComponent(word)}">語彙の星雲で「${esc(word)}」を探索する →</a>
<footer>
  <p>「${esc(word)}」の意味のつながりを、語彙空間 GOI-Space の星図でインタラクティブに探索できます。</p>
  <p><a href="/">トップページ</a> ・ <a href="/words">語彙さくいん</a> ・ <a href="/about.html">サイトについて</a> ・ <a href="/privacy.html">プライバシー</a></p>
</footer>
</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // サイトマップ（/word?sitemap=1 または /sitemap.xml をrewrite）
  // 語彙さくいん（/words）：審査員・クローラーが語彙ページ群を発見できるHTML一覧
  if (req.query && req.query.list === '1') {
    const set = new Set();
    try { (await redis('SMEMBERS', 'seo:words') || []).forEach(w => set.add(w)); } catch {}
    try { (await redis('ZREVRANGE', 'nebula:words', 0, 999) || []).forEach(w => set.add(w)); } catch {}
    const words = [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja')).slice(0, 1000);
    const links = words.map(w => `<a class="w" href="/word/${encodeURIComponent(w)}">${esc(w)}</a>`).join('');
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>語彙さくいん | 語彙空間 GOI-Space</title>
<meta name="description" content="語彙空間 GOI-Space の語彙辞典さくいん。各語の意味・類語・対義語・例文・語源のページ一覧。">
<link rel="canonical" href="${SITE}/words">
<meta name="robots" content="index, follow">
<link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#080C18;--surface:#111726;--border:#233047;--text:#E8EDF5;--muted:#8595B3;--amber:#F5A623}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;line-height:1.8}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
.logo{font-size:14px;color:var(--muted);text-decoration:none;letter-spacing:.1em}
h1{font-size:24px;margin:18px 0 8px}
.lead{font-size:14px;color:var(--muted);margin-bottom:24px}
.list{display:flex;flex-wrap:wrap;gap:9px}
.w{display:inline-block;padding:7px 14px;border-radius:16px;text-decoration:none;font-size:14px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.w:hover{border-color:var(--amber);color:var(--amber)}
footer{text-align:center;font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:20px;margin-top:40px}
footer a{color:var(--muted);margin:0 8px}
</style>
</head>
<body>
<div class="wrap">
<a class="logo" href="/">語彙空間 GOI-Space</a>
<h1>語彙さくいん</h1>
<p class="lead">各語の意味・類語・対義語・例文・語源をまとめた語彙辞典です。利用者の探索によって、ページは日々増えていきます（現在 ${words.length} 語）。</p>
<div class="list">${links || '<span style="color:var(--muted)">まだ語彙ページがありません。</span>'}</div>
<footer>
  <a href="/">トップ</a><a href="/about.html">サイトについて</a><a href="/privacy.html">プライバシー</a>
</footer>
</div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=21600');
    return res.status(200).send(html);
  }

  if (req.query && (req.query.sitemap || req.url?.includes('sitemap'))) {
    const set = new Set();
    // 生成済みのSEOページ
    try { (await redis('SMEMBERS', 'seo:words') || []).forEach(w => set.add(w)); } catch {}
    // 星雲でよく辿られている語（未生成でもsitemapに載せてクロールを促す）
    try {
      const neb = await redis('ZREVRANGE', 'nebula:words', 0, 4999) || [];
      neb.forEach(w => set.add(w));
    } catch {}
    const words = [...set].filter(Boolean);
    const urls = words.slice(0, 50000).map(w =>
      `<url><loc>${SITE}/word/${encodeURIComponent(w)}</loc><changefreq>weekly</changefreq></url>`
    ).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
<url><loc>${SITE}/words</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
<url><loc>${SITE}/about.html</loc><changefreq>monthly</changefreq></url>
${urls}
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

  const cacheKey = `seopage:${word}`;

  // キャッシュ確認
  try {
    const cached = await redis('GET', cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.status(200).send(cached);
    }
  } catch {}

  // ===== 生成レート制限 =====
  // 新規AI生成を1時間あたり上限までに制限し、機械的な大量クロールによる暴走を防ぐ。
  // 閾値は人間の閲覧速度では到達しない高さ。超過時はAIを呼ばず、
  // 星雲データだけの軽量ページを短期キャッシュで返す（負荷が落ち着けば後で完全版に昇格）。
  const GEN_LIMIT_PER_HOUR = 120; // 1時間あたりの新規AI生成の上限
  let canGenerate = true;
  try {
    const hourKey = `seogen:${new Date().toISOString().slice(0, 13)}`; // 例: seogen:2026-07-07T14
    const n = await redis('INCR', hourKey);
    if (n === 1) await redis('EXPIRE', hourKey, 3700);
    if (n > GEN_LIMIT_PER_HOUR) canGenerate = false;
  } catch {}

  // 星雲データ・活動データは常に取得（AIを使わない・安価）
  const [nebulaWords, activity] = await Promise.all([
    relatedFromNebula(word),
    gatherActivity(word),
  ]);

  if (!canGenerate) {
    // 上限超過：AIを呼ばず、星雲データだけの軽量ページを返す。
    // 短期キャッシュ（1時間）にして、負荷が落ち着いた頃の再訪で完全版に生成し直す。
    const lightData = { reading: '', summary: '', meaning_long: '', synonyms: [], antonyms: [], related: [], examples: [], etymology: '', english: [], book_theme: '' };
    const lightHtml = buildHTML(word, lightData, nebulaWords.slice(0, 16), activity);
    try {
      await redis('SET', cacheKey, lightHtml, 'EX', 3600); // 1時間だけ保持（永続にしない）
      await redis('SADD', 'seo:words', word);
    } catch {}
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=1800');
    return res.status(200).send(lightHtml);
  }

  // 上限内：AI補完で完全なページを生成
  const ai = await relatedFromAI(word);

  const data = {
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

  const html = buildHTML(word, data, nebulaWords.slice(0, 16), activity);

  // キャッシュ保存（永続・TTLなし）＋sitemap用の語セットに登録
  // 一度生成した語のページは生涯1回だけAI生成すればよく、再生成コストが発生しない。
  try {
    await redis('SET', cacheKey, html);
    await redis('SADD', 'seo:words', word);
  } catch {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  return res.status(200).send(html);
}
