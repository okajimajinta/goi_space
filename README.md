# 語彙空間 — デプロイ手順書（初学者向け）

---

## ファイル構成

```
goi-space/
├── api/
│   ├── claude.js        ← 語彙生成（Claude API、APIキーを隠す）
│   ├── transitions.js   ← ワード遷移ログの記録＆「よく辿る経路」取得
│   ├── golf.js          ← ワードゴルフ（ペア生成・手の判定・ヒント）
│   ├── daily.js         ← デイリーチャレンジ（お題＆ランキング）
│   └── _redis.js        ← DB接続ヘルパー（共通）
├── public/
│   ├── index.html       ← メインのWebアプリ
│   └── privacy.html     ← プライバシーポリシー（AdSense審査に必須）
├── vercel.json          ← Vercelの設定ファイル
└── README.md            ← この手順書
```

## 実装済みの機能

- **語彙探索**: 言葉を入力すると関連語が星雲状に広がる
- **ダブルクリック検索**: ノードをダブルクリックで外部検索エンジンへ（右上のセレクトで切替）
- **引力の可視化**: 全ユーザーがよく辿る経路ほど線が太く・中心に近く表示される
- **ワードゴルフ**: スタート→ゴールを最少手数でつなぐ。クリアで結果を自動コピー
- **デイリーチャレンジ**: 毎日ランダムな3問。難易度・パー表示
- **マンスリーチャレンジ**: 毎月のお題3問。語の距離が遠い高難度（例：りんご↔鍛造）
- **ランキング**: ハンドルネーム・手数・経路を表示。問題ごとに順位（少ない手数順）
- **共有**: クリア結果やランキングをWeb Share API／クリップボードで共有
- **遷移ログ**: ユーザーの語の辿り方をDBに集計（引力の元データ）

---

## STEP 1｜GitHubにコードを置く

### 1-1. GitHubアカウント作成
https://github.com にアクセスして無料アカウントを作成。

### 1-2. リポジトリを作成
右上の「＋」→「New repository」をクリック。
- Repository name: `goi-space`（なんでもOK）
- Public を選択
- 「Create repository」をクリック

### 1-3. ファイルをアップロード
「uploading an existing file」のリンクをクリック。
このフォルダの中身（api/, public/, vercel.json）をすべてドラッグ＆ドロップ。
「Commit changes」をクリック。

---

## STEP 2｜Vercelにデプロイする

### 2-1. Vercelアカウント作成
https://vercel.com にアクセスして「Sign Up」→「Continue with GitHub」で登録。
（GitHubアカウントでそのまま使えます）

### 2-2. プロジェクトをインポート
Vercelのダッシュボードで「Add New → Project」をクリック。
GitHubのリポジトリ一覧から `goi-space` を選んで「Import」。

### 2-3. 環境変数を設定（重要！）
「Environment Variables」のセクションで以下を追加：

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-xxxxx...`（AnthropicのAPIキー） |

APIキーは https://console.anthropic.com/settings/keys で取得できます。

### 2-4. データベース（Vercel KV）を接続する ★新機能で必須
「よく辿る経路」「ワードゴルフのランキング」「デイリーチャレンジ」には
データベースが必要です。Vercelに統合されたKV（Upstash Redis）を使います。

1. Vercelプロジェクトの「Storage」タブを開く
2. 「Create Database」→「Upstash for Redis」を選択
3. 無料プラン（Free）を選んで「Create」
4. 「Connect to Project」で今のプロジェクトに接続
5. これで `KV_REST_API_URL` と `KV_REST_API_TOKEN` が**自動で環境変数に追加**されます

※ 手動設定は不要。接続すればコード側（api/_redis.js）が自動で読み込みます。
※ 無料枠は1日1万コマンドまで。個人サービスなら十分です。

接続後、再デプロイ（Deployments → 最新 → Redeploy）すれば反映されます。

### 2-4. デプロイ
「Deploy」ボタンをクリック。1〜2分で完了。
`https://goi-space-xxxxx.vercel.app` のようなURLが発行されます。

---

## STEP 3｜独自ドメインを取得する（推奨）

AdSense審査は `vercel.app` の無料サブドメインでも通ることがありますが、
独自ドメインの方が審査に有利です。

### 3-1. ドメインを購入
- **お名前.com**: https://www.onamae.com
- **Xserver Domain**: https://www.xdomain.ne.jp
年1,000〜1,500円程度。例: `goi-space.com`

### 3-2. VercelにドメインをConnect
Vercelのプロジェクト → 「Settings」→「Domains」→ ドメインを入力。
画面の指示に従いDNS設定を変更するだけで完了（難しい操作なし）。

---

## STEP 4｜プライバシーポリシーを編集する

`public/privacy.html` を開いて以下を自分の情報に書き換えてください：

- `2024年XX月XX日` → 実際の公開日
- `your@email.com` → 自分のメールアドレス

---

## STEP 5｜Google AdSenseに申請する

### 5-1. 申請前チェックリスト
- [ ] サイトが公開されている（URLが開ける）
- [ ] プライバシーポリシーページがある（/privacy.html）
- [ ] お問い合わせメールアドレスが載っている
- [ ] コンテンツがある（実際にアプリが動く）

### 5-2. 申請方法
1. https://adsense.google.com にアクセス
2. Googleアカウントでサインイン
3. 「使ってみる」→ サイトのURLを入力
4. AdSenseのスクリプトを `index.html` の `<head>` 内に貼る（指示に従う）
5. 審査を申請（通常1〜2週間）

### 5-3. 審査通過後 — 広告コードを設置する
`index.html` のコメントアウト部分を実際のAdSenseコードに書き換えます。

**サイドバー広告（160×600）の部分：**
```html
<!-- この部分を書き換える -->
<ins class="adsbygoogle"
     style="display:block;width:136px;height:600px"
     data-ad-client="ca-pub-あなたのID"
     data-ad-slot="あなたのスロットID"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
```

**下部バナー広告（728×90）の部分も同様に書き換え。**

---

## よくある質問

**Q: APIキーが漏れないか心配**
A: `api/claude.js` がサーバー上で動き、キーは環境変数から読みます。
ブラウザにはキーが一切送られないので安全です。

**Q: AdSense審査が落ちた**
A: 主な原因は「コンテンツ不足」。しばらく運営してアクセスを増やしてから再申請してください。

**Q: Vercelの無料枠で足りるか**
A: 月10万リクエストまで無料。個人サービスなら十分です。

**Q: APIの料金は？**
A: Anthropic APIは従量課金。Claude Sonnetは入力100万トークンあたり約$3。
1回の探索で約500トークン使用するので、1万回探索しても約$1.5です。

---

## 困ったときのサポート

- Vercel公式ドキュメント: https://vercel.com/docs
- Anthropic APIドキュメント: https://docs.anthropic.com
- AdSenseヘルプ: https://support.google.com/adsense
