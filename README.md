# pdfSideStudio

Chrome拡張機能「PDF Side Studio」です。サイドパネルでPDFの結合・並べ替え・コピー・削除・回転ができ、「フル機能」から新規タブを開くと分割・ペン・テキスト・透かしなどのすべての編集機能を使えます。PDFは端末内で処理します。

- [アプリのソースコード・使い方](extension/README.md)
- [Chrome Web Store掲載用スクリーンショット](extension/docs/chrome-web-store/README.md)
- [プライバシーポリシー](index.md)
- [検証記録](extension/TESTING.md)
- [A4・600 dpiの読み込みテスト用PDF（2ページ）](extension/docs/a4-600dpi-test.pdf)

## ビルド

Node.js 22.13以降の22系、または24以降（24推奨）を使用してください。

```sh
cd extension
npm ci
npm run check
npm test
npm run build
```

ビルド後、`extension/dist`をChromeの「パッケージ化されていない拡張機能を読み込む」から読み込めます。配布用ZIPは`extension/release/pdf-side-studio.zip`に生成されます。

GitHub Pagesの公開元を`main`の`/(root)`に設定すると、ルートの`index.md`がプライバシーポリシーページになります。アプリのソースコードは`extension/`に置き、ポリシーページの入口を維持しています。
