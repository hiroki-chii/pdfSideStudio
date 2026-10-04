import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync } from 'fflate';

for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, { recursive: true });
}
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6553c7'; ctx.beginPath(); ctx.roundRect(0, 0, size, size, size * 0.22); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = `bold ${size * 0.74}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('P', size * 0.49, size * 0.55);
  await writeFile(`dist/icons/icon${size}.png`, canvas.toBuffer('image/png'));
}
let licenses = '# Third-party licenses\n\n';
for (const name of ['pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako', 'pdfjs-dist', 'fflate']) {
  const path = `node_modules/${name}`;
  const files = await readdir(path);
  const license = files.find(file => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!license) throw new Error(`Missing license: ${name}`);
  licenses += `## ${name}\n\n${await readFile(join(path, license), 'utf8')}\n\n`;
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses);
await cp('README.md', 'dist/README.md');
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
for (const path of [manifest.side_panel.default_path, manifest.background.service_worker, ...Object.values(manifest.icons)]) await readFile(join('dist', path));
const archive = {};
async function collect(directory, prefix = '') {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + file.name;
    if (file.isDirectory()) await collect(join(directory, file.name), relative + '/');
    else archive[relative] = new Uint8Array(await readFile(join(directory, file.name)));
  }
}
await collect('dist');
await mkdir('release', { recursive: true });
await writeFile('release/pdf-side-studio.zip', zipSync(archive));
console.log(`Packaged ${Object.keys(archive).length} local files into release/pdf-side-studio.zip`);
