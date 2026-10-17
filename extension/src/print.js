import './print.css';
import { readPrintJob, deletePrintJob } from './print-job.js';

const button = document.getElementById('print-document');
const status = document.getElementById('print-status');
const urls = [];
button.addEventListener('click', () => window.print());
window.addEventListener('pagehide', () => urls.forEach(url => URL.revokeObjectURL(url)));

async function prepare() {
  const id = new URL(location.href).searchParams.get('job');
  const job = id && await readPrintJob(id);
  if (!job?.pages?.length) throw new Error('印刷データが見つかりません。編集画面の印刷アイコンからやり直してください。');
  document.title = job.title;
  const style = document.createElement('style');
  document.head.append(style);
  for (const [index, page] of job.pages.entries()) {
    const url = URL.createObjectURL(page.blob); urls.push(url);
    const image = document.createElement('img');
    image.alt = `${index + 1}ページ`;
    image.src = url;
    image.style.cssText = `width:${page.width}pt;height:${page.height}pt;page:sheet${index}`;
    style.textContent += `@page sheet${index}{size:${page.width}pt ${page.height}pt;margin:0}`;
    document.getElementById('print-pages').append(image);
    await image.decode();
  }
  await deletePrintJob(id);
  button.disabled = false;
  status.textContent = 'ダイアログが開かない場合は「印刷」を押してください。';
  // Wait for the normal browser tab to finish laying out all decoded pages.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}

prepare().catch(error => { console.error(error); status.textContent = error.message || '印刷の準備に失敗しました。'; });
