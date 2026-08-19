# 請求書アプリ堅牢化 — 組織監査計画

統括: Issue #2 / 最終監査PR: #4
基準点: main `0f0ebad870919263c717181f8d951c7e3e0e7a78`

## 役割分離

### 1. 実装班
- 1回の変更テーマを1つに限定する
- main は直接変更しない
- 既存IndexedDB schemaを無断変更しない
- 金額変更には必ず再現テストを付ける

### 2. テスト班
- 実際の `app.js` を対象に回帰テストする
- 正常系だけでなく境界値・破損データ・重複・保存失敗を確認する
- 既知不具合はテストで再現してから修正する

### 3. 監査班
- main とPRの差分を独立確認する
- 金額、期間、データ互換性、発行履歴、復元、PWA、印刷を別々に判定する
- 実装コメントやREADMEではなく実コードを根拠にする

### 4. リリース管理
- PRは最終監査完了までDraftのまま
- 全ゲートPASS前にmainへマージしない
- バージョン、Service Workerキャッシュ、manifest表記を同時確認する

## 並行作業の隔離ルール

旧PR #3 の作業ブランチでは、複数の書込workflow/エージェントが同じbranchへ変更を加え、一時監査ファイルが削除後に再生成される競合を確認した。

そのため最終監査は、CI成功済みcommit `444f3ebb164439a423284d04e7c4041ec488b115` から分岐した `agent/invoice-hardening-final-audit` / PR #4 のみを正本とする。

- 旧 `agent/invoice-hardening-phase0` には新規実装を加えない
- 一時的に `contents: write` を持つworkflowは検証成功commit内で自己削除する
- 最終差分に書込用workflow・パッチスクリプトを残さない
- branch headが想定外に動いた場合は実装を止め、差分監査を先に行う

## Workstream A — 会計コア

- [x] 28日締めの2月境界重複を修正
- [x] 1〜28日締めの連続性テスト
- [x] 同一従業員・同一日の二重請求防御
- [x] 発行履歴保存完了後にのみ印刷
- [x] Safari/WebKitで保存待ち中に操作状態が失効した場合の再タップ導線
- [x] 新規請求番号を年次連番化
- [x] 固定seedのランダム金額不変条件を追加
- [x] 365日分の期間合計と日計合計を照合

## Workstream B — データ完全性

- [x] バックアップをSTATE変更前に全件検証
- [x] 復元を1 IndexedDB transactionで永続化
- [x] 不正ID・孤立参照・重複勤怠・異常値・未来schemaを拒否
- [x] 10,000件の正常バックアップ境界テスト
- [x] トップレベル/発行snapshotの件数上限テスト
- [x] 発行snapshot内部の型・ID・重複・金額整合性を検査
- [x] schemaVersion=1 は現行計算ルール・現行入力上限で厳格検証
- [x] schemaVersionなしの旧発行snapshotは当時の計算結果を監査証跡として保持
- [x] 旧発行snapshotの過去上限超過値を、構造安全性を保ったまま復元可能にする
- [x] 旧発行snapshot内の過去設定値も現在の入力上限で破棄せず証跡として保持

## Workstream C — 監査証跡

- [x] 元の発行記録を変更しない取消方式へ整理
- [x] 取消理由・日時・処理担当者を記録
- [x] 取消元ID・取消金額・重複取消を相互照合
- [x] 発行小計・税・合計とsnapshotを相互照合
- [x] 発行履歴の取引先/発行者とsnapshot設定を照合
- [x] snapshot勤怠が請求期間内にあることを検査
- [x] 事務処理規程から「削除不能システム」という誤表現を除去
- [x] READMEでアプリ単体の法令適合を保証しないことを明記

## Workstream D — PWA / 出力

- [x] 「最新に更新」のcache削除を `invoice-*` に限定
- [x] 現ページのService Worker registrationだけを解除
- [x] UI上の「PDF生成」表現を実際の印刷/PDF保存動作に合わせる
- [x] 角印を印刷DOMにも反映
- [x] APP_VERSION / manifest / Service Worker cache世代を同期

## Final Gate

以下をすべて満たすまでマージ禁止。

- [ ] 最終headの通常CIが全PASS
- [x] mainとの差分が説明済み10ファイルのみ
- [x] 一時/書込用workflow・パッチスクリプトが最終差分に残っていない
- [x] 既存IndexedDBのDB名・store名・schema versionを変更しない
- [x] 旧請求番号を一括書換しない
- [x] 旧発行snapshotの後方互換テストPASS
- [x] 旧発行snapshot設定値の後方互換テストPASS
- [x] 金額・締め期間の境界/不変条件テストPASS
- [x] バックアップ破損時はSTATE変更前に拒否
- [x] 発行保存失敗時に印刷開始しない
- [x] PWA更新で他アプリのcache/SWを一括削除しない
- [ ] PR本文と最終実装状態を一致させる
- [ ] 第三者視点の最終監査判定を記録

**Final Gate完了前にmainへマージしない。**
