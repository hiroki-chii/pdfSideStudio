const guides = {
  select: {
    title: '選択の使い方',
    steps: ['この編集で追加したテキスト・描画・画像をクリックして選択します。元のPDFの文字や画像は選択できません。',
      'ドラッグまたは方向キーで移動します。Shift＋方向キーでは10ptずつ移動します。Deleteで削除できます。',
      'テキスト同士、またはペン線・図形同士はShift＋クリックで追加選択・解除できます。複数選択したものはまとめて移動・削除できます。',
      '「重なり順」で選択したオブジェクトを前後に移動できます。複数選択したオブジェクト同士の順序は保たれ、透かしは常に最前面です。',
      'テキストはダブルクリックまたはF2で内容を編集できます。Escまたは空白クリックで選択を解除します。'],
    note: '書式を変えるときは対応するツールを開きます。「元に戻す」で移動・削除・書式変更・重なり順の変更を取り消せます。',
  },
  pen: {
    title: 'ペンの使い方',
    steps: ['描く形・色・太さ・透明度を設定します。新しく描画モードを開始すると太さ3pt・透明度0%に戻ります。',
      '新規タブの紙面をドラッグして描きます。設定メニューを開いたまま描画できます。',
      '透明度を上げるとマーカーとして使えます。丸・四角はShiftを押しながらドラッグすると正円・正方形になります。',
      '「選択」またはEscで選択モードに戻ります。描画を選択してペンを開くと、書式をすぐ変更できます。'],
    shortcuts: ['Ctrl＋↑／↓: 太さを1ptずつ増やす／減らす。', 'Ctrl＋←／→: 透明度を1%ずつ下げる／上げる。',
      'Ctrl＋Shift＋↑／↓: 選択した描画を拡大／縮小。'],
    note: 'Shift＋クリックで複数選択すると、太さ・透明度は各描画の元の値に同じ増減を加えます。1つでも上限・下限に達したら全体を止め、差を保ちます。色は選択全体に適用します。',
  },
  text: {
    title: 'テキストの使い方',
    steps: ['新規タブで「ボックスの形」から通常または吹き出しを選び、「文字」「背景」タブで書式を設定します。紙面をクリックして入力します。',
      '「入力を確定」・外側クリック・Ctrl＋Enter・Escで入力を確定します。「入力を取り消す」で入力中の変更を取り消します。',
      '吹き出しの本体かしっぽをクリックすると、枠としっぽが選択されます。しっぽはドラッグで移動でき、先端の丸いハンドルにフォーカスすると方向キーでも移動できます。本文を編集するには、選択後に本体をクリックするかF2を押します。',
      '配置済みの文字はクリック・ダブルクリックまたはF2で編集できます。ドラッグ・方向キーで移動、Deleteで削除します。',
      '編集中の文字書式は選択範囲に、背景は常にボックス全体に適用します。背景は0%で透明、100%で不透明です。'],
    shortcuts: ['Ctrl＋B／I／U: 太字／斜体／下線。', 'Ctrl＋↑／↓: 文字サイズを1ptずつ拡大／縮小。',
      'Ctrl＋←／→: 背景の不透明度を1%ずつ下げる／上げる。'],
    note: 'Shift＋クリックで複数のテキストを選択すると、書式変更・移動・削除をまとめて行えます。文字サイズは元の差を保ち、8〜96ptの最初の境界で全体が止まります。',
  },
  stamp: {
    title: '番号スタンプの使い方',
    steps: ['次の番号・パターン・色・サイズを設定します。丸枠・四角枠や塗りつぶしも選べます。',
      '紙面をクリックするたびに番号を配置し、次の番号を1つ増やします。ページを移動しても連番を続けます。',
      '「元に戻す」で配置と次の番号を戻せます。',
      '「選択」またはEscで選択モードに戻ります。配置した番号は選択モードで移動・削除・テキストとして編集できます。'],
  },
  rotation: {
    title: '回転の使い方',
    steps: ['対象に「表示中のページ」または「すべてのページ」を選びます。',
      '対象の案内を確認し、「左に90°」「右に90°」の方向ボタンを押します。押すたびにすぐ回転します。',
      '「元に戻す」で回転を取り消せます。「選択に戻る」またはEscで終了します。'],
    shortcuts: ['Ctrl＋←／→: 対象ページを左／右に90°ずつ回転。'],
  },
  watermark: {
    title: '透かしの使い方',
    steps: ['テキスト・色・文字サイズを指定し、位置を9か所から選びます。',
      '「適用」で全ページの最前面に透かしを表示します。後から追加したページにも反映されます。',
      '適用後に設定を変更すると、全ページの透かしを更新します。テキストと文字サイズはEnterキーまたは入力欄の外をクリックすると確定します。',
      '「削除」で全ページから透かしを取り除きます。「元に戻す」で適用・変更・削除を取り消せます。'],
    note: '不透明度は20%です。文字サイズは8〜96 ptで変更でき、初期値は36 ptです。小さな用紙では文字が収まるように調整します。',
  },
  save: {
    title: '保存・分割の使い方',
    steps: ['保存するファイル名を入力します。', '「PDFを保存」で、並べ替え・回転・書き込みなどを反映した全ページを1つのPDFに保存します。',
      '分割は「フル機能」から使えます。保存画面の「1ページずつ分割（ZIP）」で全ページを個別のPDFにしてZIPで保存します。'],
    note: '編集はメモリー内だけに保持されます。すべての編集画面を閉じる前に保存してください。元ファイルを残し、保存後のPDFを確認してください。',
  },
};

export function createToolHelp(document) {
  const dialog = document.getElementById('tool-help-dialog');
  const title = document.getElementById('tool-help-title');
  const content = document.getElementById('tool-help-content');
  let opener;
  let pointerStartedOutside = false;
  function isOutside(event) {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  dialog.addEventListener('pointerdown', event => {
    pointerStartedOutside = event.button === 0 && event.isPrimary !== false && isOutside(event);
  });
  dialog.addEventListener('click', event => {
    const dismiss = pointerStartedOutside && isOutside(event);
    pointerStartedOutside = false;
    if (dismiss) {
      event.stopPropagation();
      dialog.close();
    }
  });
  function appendList(tag, items) {
    const list = document.createElement(tag);
    for (const text of items) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    content.append(list);
  }
  for (const button of document.querySelectorAll('[data-tool-help]')) {
    button.addEventListener('click', () => {
      const guide = guides[button.dataset.toolHelp];
      if (!guide || dialog.open) return;
      opener = button;
      title.textContent = guide.title;
      content.replaceChildren();
      appendList('ol', guide.steps);
      if (guide.shortcuts) {
        const heading = document.createElement('h3');
        heading.textContent = 'ショートカット';
        content.append(heading);
        appendList('ul', guide.shortcuts);
      }
      if (guide.note) {
        const note = document.createElement('p');
        note.textContent = guide.note;
        content.append(note);
      }
      dialog.showModal();
    });
  }
  document.getElementById('close-tool-help').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    pointerStartedOutside = false;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
}
