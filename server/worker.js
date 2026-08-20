/* 利用レポート受け取りサーバー（Cloudflare Workers + KV）
 *
 * 無料枠だけで動かす前提で書いてある。
 *   リクエスト 10万/日、KV 書き込み 1000/日、保存 1GB まで無料。
 *   友達1人が月に数回送るだけなので、無料枠の 0.01% も使わない。
 *
 * できること
 *   POST /report          アプリからレポートを受け取って保存する
 *   GET  /admin           管理キーでログインして一覧を見る（開発者だけ）
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
function originAllowed(request, env) {
  const allowed = String(env.ALLOW_ORIGIN || '*').trim();
  if (!allowed || allowed === '*') return true;
  return request.headers.get('Origin') === allowed;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}
function securityHeaders(extra) {
  return Object.assign({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  }, extra || {});
}
function html(body, status, headers) {
  return new Response(body, {
    status: status || 200,
    headers: securityHeaders(Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers || {}))
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
  let d = x.length ^ y.length;
  for (let i = 0, n = Math.max(x.length, y.length); i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
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
  const device = String(body.device || '').replace(/[^\w-]/g, '').slice(0, 40) || who;
  const rec = {
    id,
    at: now,
    device,
    auto: !!body.auto,
    why: String(body.why || '').slice(0, 40),
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
  const meta = {
    at: now, version: rec.version, hasData: rec.hasData,
    device, auto: rec.auto, region: rec.region,
    memo: rec.memo.slice(0, 120),
    scale: summarize(body.data)
  };
  // 一覧用の見出しと、本体を分けて置く。一覧は本体を読まずに描ける
  await env.REPORTS.put('r:' + id, JSON.stringify(rec), { expirationTtl: ttl, metadata: meta });

  // 端末ごとの「いちばん新しい状態」。一覧の先頭に出す用。
  // 実データの無いレポートで上書きすると規模の表示が消えてしまうので、
  // そのときは前回わかっている数字と、それが取れた回を引き継ぐ。
  const summary = { id, ...meta };
  if (!summary.scale) {
    try {
      const prev = await env.REPORTS.get('d:' + device);
      if (prev) {
        const o = JSON.parse(prev);
        if (o.scale) { summary.scale = o.scale; summary.dataId = o.dataId || o.id; }
      }
    } catch (e) { /* 引き継げなくても受信自体は成立させる */ }
  } else {
    summary.dataId = id;
  }
  await env.REPORTS.put('d:' + device, JSON.stringify(summary), { expirationTtl: ttl });

  return json({ ok: true, id }, 200, cors(env));
}

function canonicalRecords(records) {
  const byDay = new Map();
  (Array.isArray(records) ? records : []).forEach(r => byDay.set(`${r && r.employeeId}|${r && r.date}`, r));
  return [...byDay.values()];
}

// 実データが付いていたら規模だけ取り出す。一覧で中身を開かずに様子が分かるように
function summarize(data) {
  if (!data || typeof data !== 'object') return null;
  try {
    const emps = Array.isArray(data.employees) ? data.employees : [];
    const recs = canonicalRecords(data.records);
    let att = 0, last = '';
    recs.forEach(r => {
      att += (Number(r.attendance) || 0) + (Number(r.nightAttendance) || 0);
      if (typeof r.date === 'string' && r.date > last) last = r.date;
    });
    return {
      emps: emps.length, recs: recs.length,
      att: Math.round(att * 10) / 10, last,
      logs: Array.isArray(data.invoiceLog) ? data.invoiceLog.length : 0
    };
  } catch (e) { return null; }
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
 th,td{text-align:left;padding:10px 12px 10px 0;border-bottom:1px solid rgba(128,128,128,.25);
       vertical-align:top;white-space:nowrap}
 th{font-size:12px;opacity:.6;font-weight:600}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;padding-right:0}
 td.memo{white-space:normal;min-width:200px;max-width:340px}
 tr:hover td{background:rgba(128,128,128,.08)}
 a{color:#0a84ff;text-decoration:none}
 a:hover{text-decoration:underline}
 .tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;
      background:rgba(255,159,10,.2);color:#c76e00}
 pre{white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.1);
     padding:16px;border-radius:12px;font-size:13px;line-height:1.6}
 .empty{opacity:.5;padding:40px 0;text-align:center}
 .back{display:inline-block;margin-bottom:16px}
 .card{border:1px solid rgba(128,128,128,.3);border-radius:14px;padding:16px 18px;margin-bottom:18px}
 .card h2{font-size:15px;margin:0 0 2px}
 .kpi{display:flex;gap:22px;flex-wrap:wrap;margin:12px 0 2px}
 .kpi div{font-size:12px;opacity:.6}
 .kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums;opacity:1}
 .fresh{color:#30a46c;font-weight:700}
 .stale{color:#e5484d;font-weight:700}
 .auto{background:rgba(10,132,255,.18);color:#0a6fd8}
 .wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
 .wrap>table{width:max-content;min-width:100%}
</style>`;

// 最後に届いてからどれくらい経ったか。自動送信が止まったらここで気づける
function ago(at) {
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 60) return { t: m + '分前', ok: true };
  const h = Math.floor(m / 60);
  if (h < 48) return { t: h + '時間前', ok: h < 30 };
  return { t: Math.floor(h / 24) + '日前', ok: false };
}

async function adminList(env) {
  const devs = await env.REPORTS.list({ prefix: 'd:', limit: 100 });
  const latest = (await Promise.all(devs.keys.map(async k => {
    const v = await env.REPORTS.get(k.name);
    return v ? Object.assign(JSON.parse(v), { device: k.name.slice(2) }) : null;
  }))).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));

  const cards = latest.map(d => {
    const a = ago(d.at || 0);
    const s = d.scale;
    return `<div class="card">
      <h2>端末 ${esc(d.device.slice(0, 8))}
        <span class="${a.ok ? 'fresh' : 'stale'}" style="font-size:12px">● ${esc(a.t)}</span></h2>
      <div class="sub" style="margin:0">${esc(jst(d.at || 0))} ／ ${esc(d.version || '-')}${d.auto ? ' ／ 自動' : ''}</div>
      ${s ? `<div class="kpi">
        <div>従業員<b>${s.emps}</b></div>
        <div>勤怠<b>${s.recs}</b></div>
        <div>のべ出勤<b>${s.att}</b></div>
        <div>請求書<b>${s.logs}</b></div>
        <div>最新の勤怠<b style="font-size:15px">${esc(s.last || '-')}</b></div>
      </div>` : '<div class="sub" style="margin:8px 0 0">実データなし（記録だけ）</div>'}
      <p style="margin:12px 0 0">
        <a href="/admin/view?id=${encodeURIComponent(d.id)}">最新のレポートを読む</a>
        ${s ? ` ・ <a href="/admin/data?id=${encodeURIComponent(d.dataId || d.id)}">データを見る</a>` : ''}
      </p></div>`;
  }).join('');

  const list = await env.REPORTS.list({ prefix: 'r:', limit: 300 });
  const rows = list.keys
    .map(k => ({ id: k.name.slice(2), m: k.metadata || {} }))
    .sort((a, b) => (b.m.at || 0) - (a.m.at || 0));

  const body = rows.length ? `<div class="wrap"><table>
    <tr><th>受信</th><th>端末</th><th>版</th><th>要望・困りごと</th><th>実データ</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td>${esc(jst(r.m.at || 0))}${r.m.auto ? ' <span class="tag auto">自動</span>' : ''}
        <div style="opacity:.5;font-size:11px">${esc(r.m.region || '')}</div></td>
      <td style="font-size:12px;opacity:.7">${esc(String(r.m.device || '').slice(0, 8))}</td>
      <td>${esc(r.m.version || '-')}</td>
      <td class="memo">${esc(r.m.memo || '')}</td>
      <td>${r.m.hasData ? `<a href="/admin/data?id=${encodeURIComponent(r.id)}">見る</a>` : ''}</td>
      <td><a href="/admin/view?id=${encodeURIComponent(r.id)}">中身</a></td>
    </tr>`).join('')}
  </table></div>` : '<div class="empty">まだ届いていません</div>';

  return html(`${STYLE}<h1>利用レポート</h1>
    <div class="sub">${latest.length} 台 ／ ${rows.length} 件 ／ ${KEEP_DAYS}日で自動削除</div>
    ${cards}${body}`);
}

async function adminView(env, id) {
  const raw = await env.REPORTS.get('r:' + id);
  if (!raw) return html(`${STYLE}<div class="empty">見つかりません</div>`, 404);
  const rec = JSON.parse(raw);
  const dl = rec.data ? `<p>
      <a href="/admin/data?id=${encodeURIComponent(id)}">データを見る</a> ・
      <a href="/admin/raw?id=${encodeURIComponent(id)}">JSONで落とす</a></p>` : '';
  return html(`${STYLE}
    <a class="back" href="/admin">← 一覧</a>
    <h1>${esc(jst(rec.at))}${rec.auto ? ' <span class="tag auto">自動</span>' : ''}</h1>
    <div class="sub">${esc(rec.version)} ／ 端末 ${esc(String(rec.device || '').slice(0, 8))} ／ ${esc(rec.ua)}</div>
    ${dl}
    <pre>${esc(rec.report)}</pre>`);
}

/* 実データを人が読める形で出す。JSONを落として開かなくても様子が分かるように */
async function adminData(env, id) {
  const raw = await env.REPORTS.get('r:' + id);
  if (!raw) return html(`${STYLE}<div class="empty">見つかりません</div>`, 404);
  const rec = JSON.parse(raw);
  const d = rec.data;
  if (!d) return html(`${STYLE}<div class="empty">この回に実データはありません</div>`, 404);
  const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString('en-US');

  const emps = Array.isArray(d.employees) ? d.employees : [];
  const recs = canonicalRecords(d.records);
  const byId = new Map(emps.map(e => [e.id, e]));

  // 月ごとに、誰が何日出て請求がいくらになったかをまとめる
  const months = new Map();
  recs.forEach(r => {
    const ym = String(r.date || '').slice(0, 7);
    if (!ym) return;
    if (!months.has(ym)) months.set(ym, new Map());
    const per = months.get(ym);
    const e = byId.get(r.employeeId);
    const nm = e ? e.name : '（削除済み）';
    const cur = per.get(nm) || { att: 0, ot: 0, tr: 0, total: 0 };
    const day = Number(e && e.dailyWage) || 0, night = Number(e && e.nightWage) || 0;
    const a = Number(r.attendance) || 0, na = Number(r.nightAttendance) || 0;
    const oh = a > 0 ? (Number(r.overtimeHours) || 0) : 0;
    const nh = na > 0 ? (Number(r.nightOvertimeHours) || 0) : 0;
    const tr = Number(r.transportFee) || 0;
    const man = Number(r.manualTotal) || 0;
    const auto = Math.round(day * a) + Math.round(day / 8 * 1.25 * oh)
      + Math.round(night * na) + Math.round(night / 8 * 1.25 * nh) + Math.round(tr);
    cur.att += a + na; cur.ot += oh + nh; cur.tr += tr;
    cur.total += man > 0 ? Math.round(man) : auto;
    per.set(nm, cur);
  });
  const ms = [...months.keys()].sort().reverse().slice(0, 12);

  const s = d.settings || {};
  const iss = s.issuer || {}, cli = s.client || {}, bank = s.bank || {};

  return html(`${STYLE}
    <a class="back" href="/admin">← 一覧</a>
    <h1>データの中身</h1>
    <div class="sub">${esc(jst(rec.at))} ／ 端末 ${esc(String(rec.device || '').slice(0, 8))}
      ／ <a href="/admin/raw?id=${encodeURIComponent(id)}">JSONで落とす</a></div>

    <div class="card"><h2>設定</h2><div class="wrap"><table>
      <tr><th>屋号</th><td>${esc(iss.companyName)}</td><th>登録番号</th><td>${esc(iss.invoiceNumber)}</td></tr>
      <tr><th>請求先</th><td>${esc(cli.companyName)}</td><th>担当</th><td>${esc(cli.contactName)}</td></tr>
      <tr><th>口座</th><td>${esc(bank.bankName)} ${esc(bank.branchName)} ${esc(bank.accountType)} ${esc(bank.accountNumber)}</td>
          <th>名義</th><td>${esc(bank.accountHolder)}</td></tr>
      <tr><th>締め日</th><td>${s.closingDay === 31 ? '月末' : esc(s.closingDay) + '日'}</td>
          <th>税率・車代</th><td>${esc(s.taxRate)}% ／ ${yen(s.defaultTransportFee)}</td></tr>
    </table></div></div>

    <div class="card"><h2>従業員 ${emps.length}名</h2><div class="wrap"><table>
      <tr><th>名前</th><th class="num">日給（請求）</th><th class="num">夜間</th>
          <th class="num">日給（支払）</th><th class="num">夜間</th><th class="num">単価履歴</th></tr>
      ${emps.map(e => `<tr><td>${esc(e.name)}</td><td class="num">${yen(e.dailyWage)}</td><td class="num">${yen(e.nightWage)}</td>
        <td class="num">${e.payWage ? yen(e.payWage) : '-'}</td><td class="num">${e.payNightWage ? yen(e.payNightWage) : '-'}</td>
        <td class="num">${Array.isArray(e.wageHistory) ? e.wageHistory.length + '件' : '-'}</td></tr>`).join('')}
    </table></div></div>

    <div class="card"><h2>月ごとの出面と請求</h2>
      ${ms.length ? ms.map(ym => {
        const per = months.get(ym);
        const sum = [...per.values()].reduce((a, v) => a + v.total, 0);
        return `<div style="margin-bottom:14px"><b>${esc(ym)}</b> 合計 ${yen(sum)}
          <div class="wrap"><table>
            <tr><th>名前</th><th class="num">出勤</th><th class="num">残業</th><th class="num">車代</th><th class="num">請求額</th></tr>
            ${[...per.entries()].sort((a, b) => b[1].total - a[1].total).map(([nm, v]) => `<tr><td>${esc(nm)}</td><td class="num">${v.att}日</td>
              <td class="num">${v.ot}h</td><td class="num">${yen(v.tr)}</td><td class="num">${yen(v.total)}</td></tr>`).join('')}
          </table></div></div>`;
      }).join('') : '<div class="sub">勤怠がありません</div>'}
    </div>

    <div class="card"><h2>発行した請求書 ${Array.isArray(d.invoiceLog) ? d.invoiceLog.length : 0}件</h2>
      <div class="wrap"><table>
      ${(Array.isArray(d.invoiceLog) ? d.invoiceLog : []).slice(-20).reverse()
        .map(l => `<tr><td>${esc(l.issuedAt || l.date || '')}</td><td>${esc(l.period || '')}</td>
          <td class="num">${yen(l.total || l.amount || 0)}</td></tr>`).join('') || '<tr><td class="sub">なし</td></tr>'}
    </table></div></div>`);
}

async function adminRaw(env, id) {
  const raw = await env.REPORTS.get('r:' + id);
  if (!raw) return json({ error: 'not found' }, 404);
  const rec = JSON.parse(raw);
  return new Response(JSON.stringify(rec.data || {}, null, 2), {
    headers: securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="report-${id}.json"`
    })
  });
}

const ADMIN_COOKIE = 'invoice_admin';
function adminCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  const found = raw.split(';').map(x => x.trim()).find(x => x.startsWith(ADMIN_COOKIE + '='));
  if (!found) return '';
  try { return decodeURIComponent(found.slice(ADMIN_COOKIE.length + 1)); } catch (e) { return ''; }
}
function adminSession(key, location) {
  return new Response(null, { status: 303, headers: securityHeaders({
    'Location': location,
    'Set-Cookie': `${ADMIN_COOKIE}=${encodeURIComponent(key)}; Path=/admin; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`
  }) });
}
function adminLogin(message) {
  return html(`${STYLE}<h1>管理画面</h1>${message ? `<div class="sub">${esc(message)}</div>` : ''}
    <form method="post" action="/admin/login" class="card">
      <label for="key">管理キー</label><br>
      <input id="key" name="key" type="password" autocomplete="current-password" required
        style="font:inherit;padding:8px;width:min(420px,90%);margin:8px 0">
      <button type="submit" style="font:inherit;padding:8px 14px">ログイン</button>
    </form>`, 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      if (!originAllowed(request, env)) return new Response('Forbidden', { status: 403 });
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (p === '/report' && request.method === 'POST') {
      if (!originAllowed(request, env)) return json({ ok: false, error: 'bad origin' }, 403, cors(env));
      if (!env.REPORTS) return json({ ok: false, error: 'KV not bound' }, 500, cors(env));
      try { return await ingest(request, env); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500, cors(env)); }
    }

    if (p.startsWith('/admin')) {
      if (!env.ADMIN_KEY) return html(`${STYLE}<div class="empty">ADMIN_KEY が未設定です</div>`, 500);
      if (p === '/admin/login' && request.method === 'POST') {
        const form = await request.formData(), key = String(form.get('key') || '');
        return safeEqual(key, env.ADMIN_KEY) ? adminSession(key, '/admin') : adminLogin('管理キーが違います');
      }
      const queryKey = url.searchParams.get('key') || '';
      if (queryKey && safeEqual(queryKey, env.ADMIN_KEY)) {
        url.searchParams.delete('key');
        return adminSession(queryKey, url.pathname + (url.search ? url.search : ''));
      }
      if (!safeEqual(adminCookie(request), env.ADMIN_KEY)) return adminLogin('管理キーを入力してください');
      if (!env.REPORTS) return html(`${STYLE}<div class="empty">KV が未接続です</div>`, 500);
      const id = url.searchParams.get('id') || '';
      if (p === '/admin/view') return adminView(env, id);
      if (p === '/admin/data') return adminData(env, id);
      if (p === '/admin/raw') return adminRaw(env, id);
      return adminList(env);
    }

    if (p === '/health') return json({ ok: true, kv: !!env.REPORTS });

    return new Response('Not found', { status: 404 });
  }
};
