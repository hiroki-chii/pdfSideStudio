# pdfSideStudio

ChromeのサイドパネルでPDFの結合・分割・回転、書き込み、テキストや透かしの追加ができる拡張機能「PDF Side Studio」です。PDFは端末内で処理します。

- [アプリのソースコード・使い方](extension/README.md)
- [Chrome Web Store掲載用スクリーンショット](extension/docs/chrome-web-store/README.md)
- [プライバシーポリシー](index.md)
- [検証記録](extension/TESTING.md)

## ビルド

Node.js 22.12以降（24推奨）を使用してください。

```sh
cd extension
npm ci
npm run check
npm test
npm run build
```

ビルド後、`extension/dist`をChromeの「パッケージ化されていない拡張機能を読み込む」から読み込めます。配布用ZIPは`extension/release/pdf-side-studio.zip`に生成されます。

GitHub Pagesの公開元を`main`の`/(root)`に設定すると、ルートの`index.md`がプライバシーポリシーページになります。アプリのソースコードは`extension/`に置き、ポリシーページの入口を維持しています。
