// api/_redis.js
// Upstash Redis (Vercel KV) のREST APIを叩く軽量ヘルパー。
// 環境変数 KV_REST_API_URL と KV_REST_API_TOKEN を使う（Vercel KV連携で自動設定される）。

const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

// Redisコマンドを1つ実行する
export async function redis(...command) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

// 複数コマンドをまとめて実行（pipeline）
export async function redisPipe(commands) {
  const res = await fetch(`${URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis pipeline error: ${res.status}`);
  const data = await res.json();
  return data.map(d => d.result);
}

// 共通CORSヘッダーを設定
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
