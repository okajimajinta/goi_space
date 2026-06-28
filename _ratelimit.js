// api/_wordpool.js
// ゴルフのお題用の語プール。多様な分野から集めた一般的な名詞。
// ここから2語をランダムに選ぶことで、AI任せより遥かに高いランダム性を確保する。

export const WORD_POOL = [
  // 自然・天体
  '海','山','川','森','空','雲','雷','虹','滝','砂漠','氷河','火山','洞窟','星','月','太陽','彗星','銀河','潮','霧',
  // 動物
  '象','鯨','蟻','鷹','狼','亀','蛸','蝶','梟','馬','猫','蛙','鮫','駱駝','蜂','蛍','狐','熊','鹿','鰻',
  // 植物・食物
  'りんご','稲','竹','苔','薔薇','向日葵','椎茸','人参','蜂蜜','味噌','胡椒','珈琲','葡萄','麦','茄子','西瓜','昆布','山葵','栗','筍',
  // 工業・道具
  '鍛造','溶接','歯車','旋盤','鋳型','螺子','溶鉱炉','錆','鋼','鉄塔','滑車','蒸気','配管','工具','釘','鑿','鋸','錨','発電機','潤滑油',
  // 建築・場所
  '橋','灯台','城','神社','倉庫','迷路','階段','煙突','井戸','広場','市場','埠頭','地下道','屋根','柱','門','塔','堤防','回廊','地下室',
  // 乗り物
  '船','汽車','気球','潜水艦','自転車','馬車','凧','筏','帆船','戦車','宇宙船','貨物','橇','艀','索道',
  // 芸術・文化
  '絵本','彫刻','陶器','版画','楽譜','仮面','刺繍','漆','屏風','水墨','舞台','旋律','詩','書道','織物','花火','祭り','人形','茶道','和歌',
  // 抽象・感情
  '郷愁','静寂','混沌','均衡','余韻','黄昏','孤独','陶酔','焦燥','憧憬','郷土','記憶','幻影','宿命','調和',
  // 身体・生活
  '骨','心臓','睫毛','指紋','寝床','財布','鍵','眼鏡','傘','時計','鏡','枕','箒','蝋燭','硝子',
  // 気象・季節
  '吹雪','陽炎','木枯らし','梅雨','霜','稲妻','夕立','薄氷','五月雨','残暑',
  // 科学・概念
  '重力','磁石','結晶','化石','遺伝子','原子','化学反応','摩擦','光速','真空','電流','波長','酵素','細胞','螺旋',
  // 金融・社会
  '為替','株式','利子','貿易','関税','契約','貨幣','商標','保険','債券',
  // 楽器・音
  '太鼓','三味線','風鈴','尺八','琴','鈴','笛','鐘','鼓','銅鑼',
  // 色・素材
  '藍','朱','金箔','真珠','琥珀','翡翠','水晶','大理石','黒曜石','象牙',
];

// ランダムに2語を選んでペアにする（重複なし）
export function randomPair() {
  const i = Math.floor(Math.random() * WORD_POOL.length);
  let j = Math.floor(Math.random() * WORD_POOL.length);
  while (j === i) j = Math.floor(Math.random() * WORD_POOL.length);
  return { start: WORD_POOL[i], goal: WORD_POOL[j] };
}

// 距離が遠いペア（マンスリー用）：分野インデックスが離れた2語を選ぶ
export function randomDistantPair() {
  // プールを前半・後半に分けて、各から1語ずつ選ぶと分野が離れやすい
  const half = Math.floor(WORD_POOL.length / 2);
  const i = Math.floor(Math.random() * half);
  const j = half + Math.floor(Math.random() * (WORD_POOL.length - half));
  // ランダムに順序を入れ替え
  return Math.random() < 0.5
    ? { start: WORD_POOL[i], goal: WORD_POOL[j] }
    : { start: WORD_POOL[j], goal: WORD_POOL[i] };
}

// 種となる語からAIで関連語を生成し、その中からランダムに1語選ぶ。
// プール語そのものではなく派生語をお題にすることで多様性を高める。
export async function expandWord(seed, anthropicKey) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        temperature: 1,
        messages: [{ role: 'user', content: `日本語の語「${seed}」から連想される、関連の深い具体的な名詞を8個挙げてください。一般的で誰でも知っている語にしてください。JSON配列のみで返答：["語1","語2",...]` }],
      }),
    });
    const data = await resp.json();
    const raw = data.content.map(c => c.text || '').join('');
    const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(arr) && arr.length > 0) {
      // 種語自身は除外
      const filtered = arr.filter(w => w !== seed && typeof w === 'string');
      const pool = filtered.length > 0 ? filtered : arr;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch {}
  return seed; // 失敗時は種語をそのまま使う
}
