# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

説明用の地図を即興で作る静的 Web アプリ（Google マイマップ風）。ビルド・依存パッケージ・テストなし。
`index.html` + `css/style.css` + `js/app.js`（単一の IIFE、クラシックスクリプト）だけで動く。
UI 文言・コメントはすべて日本語。PC / スマホ / タブレット対応（767px 以下はボトムシート UI）。

- 地図ライブラリ: MapLibre GL JS 5.24.0（unpkg から読込、バージョン固定）
- タイル: OpenFreeMap（`https://tiles.openfreemap.org/styles/{liberty|positron|bright}`、OpenMapTiles スキーマ、API キー不要）
- ラベルの個別表示制御が要件なので **ラスタータイルには置き換えられない**（ベクタータイル必須）

## 開発コマンド

```sh
npx http-server -p 8080 -a 127.0.0.1 -c-1   # → http://127.0.0.1:8080/
node --check js/app.js                     # 構文チェック（唯一の静的検査）
```

自動テストはない。動作確認はブラウザ（chrome-devtools MCP など）で行う。スクリプトから操作する場合:
- 地図操作は `.maplibregl-canvas` に `MouseEvent`（mousedown→mouseup→click）/ `TouchEvent` を dispatch する
- `setData()` 直後は `queryRenderedFeatures` にまだ反映されないため、連続タップの間に 300ms 程度待つ
- 状態は IIFE 内なので外から見えない。`localStorage['temporarymymap:autosave']` か DOM（`#list-*`, `#editor`）で確認する

## アーキテクチャ

### 状態とデータの流れ

- `state`（永続化対象）: `title, style, lang, fade, labels{place,poi,road,water,other}, points[], arrows[], lines[], pins[], nextId`
- `ui`（非永続）: `mode`（select/point/arrow/draw/pin）, `sel {type,id}`, `arrowFrom`, `draft`（描画中の線）, `exporting` など
- 変更の定型: `pushUndo()`（または連続入力は `pushUndoCoalesced(key)`）→ `state` を変更 → `render()` → `renderPanel()` / `renderLists()` / `renderEditor()` → `scheduleSave()`
- 元に戻すは `state` 全体の JSON スナップショット。`restoreSnapshot` は `{...newState(), ...snapshot}` で古い形にも耐える
- 保存形式は `toDoc()` / `stateFromDoc()` の 1 系統のみ。JSON ファイル・URL ハッシュ（`#m=` deflate-raw + base64url、`#j=` 非圧縮）・localStorage 自動保存すべて同じドキュメント
- `stateFromDoc` は `pick(src, DEFAULTS)` で **DEFAULTS と同じ型のキーだけ** 取り込む。新しいプロパティは `*_DEFAULTS` に追加すれば旧データも自動で既定値補完される

### 地図レイヤー（すべて `mm-` 接頭辞）

- ベース地図の切替（`map.setStyle(..., {diff:false})`）で自前のソース・レイヤー・画像はすべて消える。`style.load` → `setupStyle()` が毎回 `addStaticImages()` / `addSource` / `addCustomLayers()` を作り直すので、**レイヤーやソースの追加は必ずここ経由**にする
- 描画は GeoJSON ソースへの `setData`（`renderPoints` / `renderStrokes` / `renderPins` / `renderDraft`）。`styleReady` が false の間は描画しない
- 追加順 = 重なり順: fade → 線・図形 → 矢印 → ポイント → ラベル → 固定ラベル → 下書き
- 当たり判定 `hitTest()` は `HIT_LAYERS` を一括クエリし、**各フィーチャの `t` プロパティ（'point'|'pin'|'arrow'|'line'）で種類を判別**する。新しいフィーチャには必ず `id` と `t` を入れる
- 自前ラベルは `text-allow-overlap: true` かつ `text-ignore-placement: false`。これで自前ラベルは常に表示され、重なるベース地図のラベルは衝突判定で自動的に隠れる（重複表示の防止）。ポイントの `mm-pt-inner` は透明アイコン `mm-blank` でマーカー範囲を確保している

### MapLibre の制約に合わせた実装上の決まり

- GeoJSON プロパティの配列を `text-offset` / `icon-offset` に渡さない。代わりにラベル位置は `text-anchor` + `text-radial-offset`、矢じりの後退量は画像に余白を焼き込む（`headImageId(color, size, gap)` → `styleimagemissing` で `makeHeadImage` がオンデマンド生成）
- `line-dasharray` はデータ駆動不可なので、実線と破線は別レイヤー（filter で `dash` を分岐）
- 矢印・線の端は矢じりの下で止めるため、ピクセル量をメルカトル距離に換算して切り詰める（`addStroke` / `trimEnd`）。ズーム依存なので `zoom` イベントで `renderStrokes` を再実行している
- 回転・ピッチは無効化（`bearingOf` などは北上前提）
- 画像出力は `preserveDrawingBuffer` 前提。`renderImage()` が選択解除・当たり判定レイヤー非表示・`setPixelRatio(scale)` → `idle` 待ち → キャンバス合成（タイトル・縮尺バー・出典表記）→ 復元、の順で行う。出力に出したくない表示は `ui.exporting` を見て消す

### ラベル固定と表示制御

- `baseLabelLayers`: ベーススタイルの全 symbol レイヤーを `source-layer` で 5 カテゴリに分類（`labelCategory`）。`applyBaseSettings()` が表示/非表示・言語（`name:ja` 優先）・淡さを反映する
- 固定ラベル（`pins`）はタップ地点の `queryRenderedFeatures` 結果から名前と座標をコピーし、自前レイヤーで常時表示する。POI のアイコンはベーススタイルのスプライト名（`subclass` / `class`）を再利用

### 線（手描き）

- 線モードでは左ドラッグ／1 本指を描画に使う。`onPointerDown/Move/Up` が `mode === 'draw'` のとき `drawDown/drawMove/drawUp` に委譲する。PC の地図移動は右・中ボタンドラッグ（`bindDrawModePan`）、スマホは 2 本指
- 手描き軌跡は画面座標で Ramer–Douglas–Peucker（`simplifyPath`, 許容 `SIMPLIFY_PX`）で間引いてから経緯度に変換。保存時は小数 5 桁に丸める
- 描画中は `ui.draft`（未確定、`state` 外）。`finishDraft()` で初めて `state.lines` に入り undo 対象になる

## 要素の種類を追加するときのチェックリスト

`js/app.js` と `index.html` の複数箇所に手を入れる必要がある（既存の `lines` 追加がそのまま参考になる）:

1. `*_DEFAULTS`、必要なら `NUM_FIELDS` / `BOOL_FIELDS`、`newState()`、`getObj()`
2. `toDoc()` / `stateFromDoc()`（入力検証と ID 振り直し）
3. `setupStyle()` のソース一覧、`addCustomLayers()`、描画関数（`render()` から呼ぶ）、`HIT_LAYERS`
4. `deleteSel()`、`setField()`（前回スタイルの記憶）、`renderEditor()`、`renderLists()`、`revealItem()`、`fitAll()`
5. モードを追加する場合: ツールバーの `data-mode` ボタン、`setMode()`、`onMapClick()`、`updateHint()`、キーボードの `keyModes`、`#map.mode-*` のカーソル CSS
6. `index.html` の一覧（`#list-*` / `#count-*`）、README の機能表

## 外部要件

- 出典表記（`ATTRIBUTION_TEXT` と画面の AttributionControl）は OSM / OpenMapTiles / OpenFreeMap のライセンス上必須。画像出力からも消さない
- `location.protocol === 'file:'` でも動くが、URL 共有は Web サーバー上でないと他端末で開けない
