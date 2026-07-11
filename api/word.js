// api/word.js
// SEO用ロングテールページ。/word/孤独 のような各語の静的HTMLを返す。
// ハイブリッド方式：初回アクセスで生成→Redisにキャッシュ（7日）。以降はキャッシュを返す。
//   - 関連語は星雲データ（edge:WORD）を優先し、不足分をAI（Haiku）で補完。
//   - Googleにインデックスされることで、「〇〇 類語」等の検索流入を自動化する。

import { redis } from './_redis.js';

const SITE = process.env.SITE_URL || 'https://goispace.app';
const AMAZON_TAG = process.env.AMAZON_TAG || 'goispacead-22';

// クローラー（ボット）判定。新規AI生成を人間の実訪問だけに限定するために使う。
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
  } catch {}
  return { word, status: 'generated' };
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
${data.trendContext ? `<div class="trend-banner">🔥 <b>今話題の言葉</b>：${esc(data.trendContext)}</div>` : ''}
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
      res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=3600');
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
.w.feat{border-color:rgba(245,166,35,0.4);background:linear-gradient(135deg,#1c1608,#111726)}
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
${!row && page === 1 && featuredLinks ? `<h2>今日の注目の言葉</h2><div class="list">${featuredLinks}</div>` : ''}
<h2>五十音から引く</h2>
<div class="rows">${rowTabs}</div>
<div class="list">${links || '<span style="color:var(--muted)">この頭文字の語はまだありません。</span>'}</div>
${pager}
<p class="meta">${rowLabel ? `${esc(rowLabel)} ` : ''}${all.length} 語中 ${(page - 1) * PER + 1}〜${Math.min(page * PER, all.length)} 語目${pages > 1 ? `（${page} / ${pages} ページ）` : ''}</p>
<footer>
  <a href="/">トップ</a><a href="/about.html">サイトについて</a><a href="/privacy.html">プライバシー</a>
</footer>
</div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=3600');
    return res.status(200).send(html);
  }

  if (req.query && (req.query.sitemap || req.url?.includes('sitemap'))) {
    const set = new Set();
    // 【方針B】生成済み（完全版データがある）SEOページのみをsitemapに載せる。
    // 未生成の語をクローラーに宣伝しないことで、新規生成の連鎖クロールを断つ。
    // 既に8万語規模の生成済み資産があるため、これで十分な検索網が保たれる。
    try { (await redis('SMEMBERS', 'seo:words') || []).forEach(w => set.add(w)); } catch {}
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

  const dataKey = `seodata:${word}`; // AI生成データ（軽量・永続）
  const cacheKey = `seopage:${word}`; // 組み立て済みHTML（短期バッファのみ）

  // まず組み立て済みHTMLの短期キャッシュを確認（あれば即返す）
  try {
    const cached = await redis('GET', cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.status(200).send(cached);
    }
  } catch {}

  // 星雲データ・活動データは常に取得（AIを使わない・安価）
  const [nebulaWords, activity] = await Promise.all([
    relatedFromNebula(word),
    gatherActivity(word),
  ]);

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
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
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
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
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
    }
    await redis('SET', cacheKey, html, 'EX', 60 * 60 * 24 * 3); // HTMLは3日バッファ
  } catch {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  return res.status(200).send(html);
}
