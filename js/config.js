/* TemporaryMyMap の設定（サイト設置者向け）
 * このファイルが無い場合や、項目を省略した場合は既定値で動作する。
 */
window.TEMPORARY_MY_MAP_CONFIG = {
  // 閲覧専用の埋め込み表示（他サイトの iframe 内での表示）を許可するか。
  //   true : 「保存」タブに埋め込み用HTMLの作成機能が表示され、?embed=1 付きのURLで閲覧専用表示ができる
  //   false: 埋め込み機能を隠し、閲覧専用URLも表示しない。このアプリを iframe 内で開いた場合も表示を拒否する
  embed: false,

  // UI の表示言語の既定値。'auto'（ブラウザの言語。日本語以外なら英語）/ 'ja' / 'en'。
  // 利用者が画面で切り替えた言語と、URL の ?lang=ja / ?lang=en のほうが優先される。
  language: 'auto',

  // ---- 以下はセルフホスト向け（省略時は OpenFreeMap を使う） ----

  // ベース地図（MapLibre スタイル JSON の URL）。先頭が既定。
  // OpenMapTiles スキーマのタイルを使うこと（ラベルの種類分け・日本語名の優先表示がこのスキーマ前提）。
  // id は保存データに記録されるので、運用開始後は変えない（一覧に無い id のデータは先頭の地図で開く）。
  // styles: [
  //   { id: 'liberty',  name: '標準',     url: 'https://tiles.openfreemap.org/styles/liberty' },
  //   { id: 'positron', name: 'ライト',   url: 'https://tiles.openfreemap.org/styles/positron' },
  //   { id: 'bright',   name: 'ブライト', url: 'https://tiles.openfreemap.org/styles/bright' },
  // ],

  // 出典表記（プレーンテキスト）。通常はスタイルに含まれる出典が自動で表示・画像に書き込まれるので、
  // スタイル側に出典が入っていない場合だけ指定する。
  // attribution: '© OpenStreetMap contributors',

  // アプリが描くラベル（ポイント名・矢印・固定ラベルなど）の書体名。
  // ベース地図のスタイルの glyphs で配信されている書体名に合わせる（日本語は端末の書体で描画される）。
  // fonts: { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] },

  // 保存データが無いときに最初に表示する場所と縮尺。
  // initialView: { center: [139.7671, 35.6812], zoom: 14 },
};
