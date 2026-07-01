// api/word.js
// SEO用ロングテールページ。/word/孤独 のような各語の静的HTMLを返す。
// ハイブリッド方式：初回アクセスで生成→Redisにキャッシュ（7日）。以降はキャッシュを返す。
//   - 関連語は星雲データ（edge:WORD）を優先し、不足分をAI（Haiku）で補完。
//   - Googleにインデックスされることで、「〇〇 類語」等の検索流入を自動化する。

import { redis } from './_redis.js';

const SITE = process.env.SITE_URL || 'https://goispace.app';
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

// AIで語をカテゴリ分類生成（Haiku・安価）
async function relatedFromAI(word) {
  const prompt = `日本語の言葉「${word}」に関連する語を挙げてください。
「${word}」自身は含めないこと。次のJSON形式のみで出力（前後の説明・マークダウン不可）：
{
 "reading":"${word}のよみがな",
 "summary":"${word}という語の意味・ニュアンスの簡潔な説明（60字以内）",
 "synonyms":["類義語・関連語を8語"],
 "antonyms":["対義語・対比となる語を4語"],
 "related":["連想される語・周辺概念を8語"]
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
        max_tokens: 600,
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
      summary: String(p.summary || '').slice(0, 160),
      synonyms: (p.synonyms || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 10),
      antonyms: (p.antonyms || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 6),
      related: (p.related || []).map(w => String(w).slice(0, 30)).filter(Boolean).slice(0, 10),
    };
  } catch {
    return { reading: '', summary: '', synonyms: [], antonyms: [], related: [] };
  }
}

function buildHTML(word, data, nebulaWords) {
  const title = `「${word}」の類語・関連語・対義語 | 語彙空間 GOI-Space`;
  const desc = data.summary
    ? `${word}（${data.reading}）：${data.summary} 類語・関連語・対義語を語彙の星図で探索。`
    : `「${word}」の類語・関連語・対義語・連想語を一覧。語彙空間 GOI-Space で意味のつながりを探索できます。`;
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
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
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
</style>
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
${data.synonyms.length ? `<section><h2>類語・関連語</h2><div class="chips">${chipList(data.synonyms, 'syn')}</div></section>` : ''}
${data.antonyms.length ? `<section><h2>対義語・対比となる語</h2><div class="chips">${chipList(data.antonyms, 'ant')}</div></section>` : ''}
${data.related.length ? `<section><h2>連想語・周辺概念</h2><div class="chips">${chipList(data.related, 'rel')}</div></section>` : ''}
${nebulaChips}
<a class="cta" href="/?q=${encodeURIComponent(word)}">語彙の星雲で「${esc(word)}」を探索する →</a>
<footer>
  <p>「${esc(word)}」の意味のつながりを、語彙空間 GOI-Space の星図でインタラクティブに探索できます。</p>
  <p><a href="/">トップページ</a> ・ <a href="/privacy.html">プライバシー</a></p>
</footer>
</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // サイトマップ（/word?sitemap=1 または /sitemap.xml をrewrite）
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

  // 生成：星雲データ ＋ AI補完
  const [nebulaWords, ai] = await Promise.all([
    relatedFromNebula(word),
    relatedFromAI(word),
  ]);

  const data = {
    reading: ai.reading,
    summary: ai.summary,
    synonyms: ai.synonyms,
    antonyms: ai.antonyms,
    related: ai.related,
  };

  const html = buildHTML(word, data, nebulaWords.slice(0, 16));

  // キャッシュ保存＋sitemap用の語セットに登録
  try {
    await redis('SET', cacheKey, html, 'EX', CACHE_TTL);
    await redis('SADD', 'seo:words', word);
  } catch {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  return res.status(200).send(html);
}
