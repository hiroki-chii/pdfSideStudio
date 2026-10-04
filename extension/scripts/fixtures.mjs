import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('tmp', { recursive: true });
for (const [filename, title, count] of [['sample-a.pdf', 'DESIGN NOTES', 2], ['sample-b.pdf', 'PROJECT PLAN', 1]]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let n = 0; n < count; n++) {
    const page = doc.addPage([420, 560]);
    page.drawRectangle({ x: 0, y: 440, width: 420, height: 120, color: rgb(.94, .92, .98) });
    page.drawText('SIDE STUDIO / SAMPLE', { x: 35, y: 519, font, size: 9, color: rgb(.43, .36, .65) });
    page.drawText(title, { x: 35, y: 474, font: bold, size: 25, color: rgb(.22, .18, .32) });
    page.drawText(`0${n + 1}  A little space for your ideas.`, { x: 35, y: 405, font: bold, size: 13 });
    const lines = ['Collect your documents in one place.', 'Keep only the pages that matter.', 'Add a note. Make it yours.'];
    lines.forEach((line, index) => page.drawText(line, { x: 35, y: 365 - index * 24, font, size: 11, color: rgb(.4, .4, .48) }));
    page.drawRectangle({ x: 35, y: 115, width: 350, height: 150, borderColor: rgb(.83, .8, .91), borderWidth: 1 });
    page.drawText('YOUR NOTES', { x: 49, y: 239, font, size: 9, color: rgb(.55, .5, .65) });
    page.drawText(`${filename} / ${n + 1}`, { x: 35, y: 40, font, size: 9, color: rgb(.55, .5, .65) });
    if (n === 1) page.setRotation(degrees(90));
  }
  await writeFile(`tmp/${filename}`, await doc.save());
}
await writeFile('tmp/broken.pdf', 'This is not a PDF.');
console.log('Created local test fixtures.');
