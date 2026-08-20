# 利用レポート受け取りサーバー

アプリから送られた「利用レポート」を受け取って、開発者が一覧で見るための小さなサーバー。

## なぜ Cloudflare Workers か

無料で動かしたいので、次の条件で探した。

- クレジットカード登録なしで使える
- 無料枠が「使い切ったら止まる」型（勝手に課金されない）
- サーバーを常時起動しなくていい（寝かせておいても無料）
- 保存先も無料枠に含まれる

| 候補 | 無料枠 | 落とし穴 |
|---|---|---|
| **Cloudflare Workers + KV** | 10万req/日・KV書込1000/日・1GB | カード不要。無料枠を超えると止まるだけ |
| Vercel / Netlify Functions | 実行は無料 | 保存先（DB）が別課金になりがち |
| Render / Railway | 無料枠あり | 15分で寝る＋起動に数十秒／無料枠廃止の流れ |
| Google Apps Script | 完全無料 | CORS が扱いづらく POST がリダイレクトされる |
| Firebase | 無料枠あり | 従量課金の紐付けが必要になる場面がある |

想定する使用量は「友達1人が月に数回送る」なので、**無料枠の 0.01% も使わない**。
半年経ったレポートは KV の TTL で勝手に消えるので、掃除の運用もいらない。

## 置くもの

- `worker.js` … サーバー本体（これ1ファイルだけ）
- `wrangler.toml` … CLI で入れる人向けの設定

## 入れ方（ブラウザだけ・約5分）

CLI もビルドもいらない。スマホからでもできる。

1. https://dash.cloudflare.com/ でアカウントを作る（無料・カード不要）
2. 左メニュー **Storage & Databases → KV** →「Create namespace」
   - 名前は `reports` などでよい
3. 左メニュー **Compute (Workers)** →「Create」→「Start with Hello World!」→ 適当な名前で Deploy
4. その Worker の **Edit code** を開き、中身を全部消して `worker.js` の中身を貼り付け → Deploy
5. Worker の **Settings** タブで
   - **Bindings → Add → KV namespace**
     - Variable name: `REPORTS`
     - KV namespace: さっき作ったもの
   - **Variables and Secrets → Add**（3つ。Secret 型にしておく）

| 名前 | 中身 | 役割 |
|---|---|---|
| `ADMIN_KEY` | 長いランダム文字列 | 管理画面のパスワード |
| `INGEST_KEY` | 長いランダム文字列 | アプリが送るときの合言葉 |
| `ALLOW_ORIGIN` | `https://tensaikamo.github.io` | ここからの送信だけ許す |

ランダム文字列は Safari のアドレスバーに
`javascript:` は使えないので、適当に 32 文字以上の英数字を打てばよい。

6. Deploy し直す

## 使う

- アプリ側：設定 → 開発者へのレポート → 「送信先」に
  `https://<worker名>.<アカウント名>.workers.dev/report`、
  「合言葉」に `INGEST_KEY` を入れる
- 開発者側：`https://<worker名>.<アカウント名>.workers.dev/admin?key=<ADMIN_KEY>`

`/health` を開くと KV がつながっているか確認できる。

## CLI で入れる場合

```sh
npm i -g wrangler
wrangler login
wrangler kv namespace create reports      # 出た id を wrangler.toml に書く
wrangler secret put ADMIN_KEY
wrangler secret put INGEST_KEY
wrangler deploy
```

## 中身と扱い

- 保存するもの：レポート本文、アプリ版、UA、要望メモ、（任意で）バックアップ JSON
- **IP は保存しない**。連投よけのためにハッシュだけ持つ
- 180 日で自動削除
- 1 時間に 20 件までしか受け取らない
- 1 件 512KB まで
- 管理画面のパスワードが違うときは 404 を返す（存在を隠すため）

実データには従業員の氏名・給与額・取引先・銀行口座が入る。
**送信は利用者が自分でボタンを押したときだけ**で、アプリが勝手に送ることはない。
送る前に何が入るか画面に全部出る。
