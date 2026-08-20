/* 利用レポート受け取りサーバー（Cloudflare Workers + KV）
 *
 * 無料枠だけで動かす前提で書いてある。
 *   リクエスト 10万/日、KV 書き込み 1000/日、保存 1GB まで無料。
 *   友達1人が月に数回送るだけなので、無料枠の 0.01% も使わない。
 *
 * できること
 *   POST /report          アプリからレポートを受け取って保存する
 *   GET  /admin?key=xxx   受け取った一覧を見る（開発者だけ）
 *   GET  /admin/view?id=  1件の中身を見る
 *   GET  /admin/raw?id=   1件を JSON で落とす
 *
 * 必要な設定（Cloudflare の画面で入れる）
 *   KV 名前空間  REPORTS
 *   変数        ADMIN_KEY    管理画面のパスワード（長い文字列にする）
 *   変数        INGEST_KEY   アプリ側が送るときの合言葉（空なら誰でも送れる）
 *   変数        ALLOW_ORIGIN 送信を許すサイト（例 https://tensaikamo.github.io）
 */

const MAX_BODY = 512 * 1024;   // 512KB。実データ入りでもこれ以下に収まる
const KEEP_DAYS = 180;         // 半年で自動的に消える（KV の TTL 任せ＝掃除の手間なし）
const RATE_PER_HOUR = 20;      // 同じ端末からの連投を止める

const enc = new TextEncoder();

function cors(env, extra) {
  const o = (env.ALLOW_ORIGIN || '*').trim();
  return Object.assign({
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  }, extra || {});
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}
function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 長さの違いで中身を推測されないよう、一定時間で比べる
function safeEqual(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
function jst(ms) {
  // Cloudflare は UTC で動くので日本時間に直して見せる
  return new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/* ---------- 受け取り ---------- */
async function ingest(request, env) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'too large' }, 413, cors(env));

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too large' }, 413, cors(env));

  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad json' }, 400, cors(env)); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' }, 400, cors(env));

  // 合言葉は本文か X-Report-Key のどちらでもよい。
  // ヘッダは英数字しか通せないので、日本語も使える本文側を主にする。
  if (env.INGEST_KEY) {
    const k = body.key || request.headers.get('X-Report-Key') || '';
    if (!safeEqual(k, env.INGEST_KEY)) return json({ ok: false, error: 'bad key' }, 401, cors(env));
  }
  delete body.key;   // 合言葉は保存しない

  if (typeof body.report !== 'string' || !body.report.trim()) {
    return json({ ok: false, error: 'no report' }, 400, cors(env));
  }

  // 連投よけ。IP そのものは残さずハッシュだけ持つ
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const who = await hash(ip + '|' + (env.INGEST_KEY || ''));
  const bucket = 'rate:' + who + ':' + Math.floor(Date.now() / 3600000);
  const used = Number((await env.REPORTS.get(bucket)) || 0);
  if (used >= RATE_PER_HOUR) return json({ ok: false, error: 'too many' }, 429, cors(env));
  await env.REPORTS.put(bucket, String(used + 1), { expirationTtl: 7200 });

  const now = Date.now();
  const id = String(now) + '-' + Math.random().toString(36).slice(2, 8);
  const cf = request.cf || {};
  const rec = {
    id,
    at: now,
    version: String(body.version || '').slice(0, 20),
    ua: String(body.ua || request.headers.get('User-Agent') || '').slice(0, 300),
    memo: String(body.memo || '').slice(0, 2000),
    hasData: !!body.data,
    report: body.report.slice(0, MAX_BODY),
    data: body.data || null,
    from: who,
    region: [cf.country, cf.city].filter(Boolean).join('/')
  };

  const ttl = KEEP_DAYS * 86400;
  // 一覧用の見出しと、本体を分けて置く。一覧は本体を読まずに描ける
  await env.REPORTS.put('r:' + id, JSON.stringify(rec), {
    expirationTtl: ttl,
    metadata: {
      at: now, version: rec.version, hasData: rec.hasData,
      from: who, region: rec.region,
      memo: rec.memo.slice(0, 120),
      lines: rec.report.split('\n').length
    }
  });

  return json({ ok: true, id }, 200, cors(env));
}

/* ---------- 管理画面 ---------- */
const STYLE = `
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;
      margin:0;padding:24px;max-width:960px;margin-inline:auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{opacity:.6;font-size:13px;margin-bottom:20px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th,td{text-align:left;padding:10px 8px;border-bottom:1px solid rgba(128,128,128,.25);vertical-align:top}
 th{font-size:12px;opacity:.6;font-weight:600}
 tr:hover td{background:rgba(128,128,128,.08)}
 a{color:#0a84ff;text-decoration:none}
 a:hover{text-decoration:underline}
 .tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;
      background:rgba(255,159,10,.2);color:#c76e00}
 pre{white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.1);
     padding:16px;border-radius:12px;font-size:13px;line-height:1.6}
 .empty{opacity:.5;padding:40px 0;text-align:center}
 .back{display:inline-block;margin-bottom:16px}
</style>`;

async function adminList(env, key) {
  const list = await env.REPORTS.list({ prefix: 'r:', limit: 200 });
  const rows = list.keys
    .map(k => ({ id: k.name.slice(2), m: k.metadata || {} }))
    .sort((a, b) => (b.m.at || 0) - (a.m.at || 0));

  const body = rows.length ? `
  <table>
    <tr><th>受信</th><th>版</th><th>要望・困りごと</th><th>実データ</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td>${esc(jst(r.m.at || 0))}<div style="opacity:.5;font-size:11px">${esc(r.m.region || '')}</div></td>
      <td>${esc(r.m.version || '-')}</td>
      <td>${esc(r.m.memo || '')}</td>
      <td>${r.m.hasData ? '<span class="tag">あり</span>' : ''}</td>
      <td><a href="/admin/view?key=${encodeURIComponent(key)}&id=${encodeURIComponent(r.id)}">中身</a></td>
    </tr>`).join('')}
  </table>` : '<div class="empty">まだ届いていません</div>';

  return html(`${STYLE}<h1>利用レポート</h1>
    <div class="sub">${rows.length} 件 ／ ${KEEP_DAYS}日で自動削除</div>${body}`);
}

async function adminView(env, key, id) {
  const raw = await env.REPORTS.get('r:' + id);
  if (!raw) return html(`${STYLE}<div class="empty">見つかりません</div>`, 404);
  const rec = JSON.parse(raw);
  const dl = rec.data
    ? `<p><a href="/admin/raw?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}">実データ（JSON）を落とす</a></p>`
    : '';
  return html(`${STYLE}
    <a class="back" href="/admin?key=${encodeURIComponent(key)}">← 一覧</a>
    <h1>${esc(jst(rec.at))}</h1>
    <div class="sub">${esc(rec.version)} ／ ${esc(rec.ua)}</div>
    ${dl}
    <pre>${esc(rec.report)}</pre>`);
}

async function adminRaw(env, id) {
  const raw = await env.REPORTS.get('r:' + id);
  if (!raw) return json({ error: 'not found' }, 404);
  const rec = JSON.parse(raw);
  return new Response(JSON.stringify(rec.data || {}, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="report-${id}.json"`,
      'Cache-Control': 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (p === '/report' && request.method === 'POST') {
      if (!env.REPORTS) return json({ ok: false, error: 'KV not bound' }, 500, cors(env));
      try { return await ingest(request, env); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500, cors(env)); }
    }

    if (p.startsWith('/admin')) {
      if (!env.ADMIN_KEY) return html(`${STYLE}<div class="empty">ADMIN_KEY が未設定です</div>`, 500);
      const key = url.searchParams.get('key') || '';
      if (!safeEqual(key, env.ADMIN_KEY)) return new Response('Not found', { status: 404 });
      if (!env.REPORTS) return html(`${STYLE}<div class="empty">KV が未接続です</div>`, 500);
      const id = url.searchParams.get('id') || '';
      if (p === '/admin/view') return adminView(env, key, id);
      if (p === '/admin/raw') return adminRaw(env, id);
      return adminList(env, key);
    }

    if (p === '/health') return json({ ok: true, kv: !!env.REPORTS });

    return new Response('Not found', { status: 404 });
  }
};
