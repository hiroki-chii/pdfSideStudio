import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

for (const directory of ['src', 'public', 'scripts']) {
  for (const file of await readdir(directory)) {
    if (!/\.(m?js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('All application and build scripts passed syntax checks.');
const lint = new ESLint();
const results = await lint.lintFiles(['src/**/*.js', 'public/**/*.js']);
const formatted = (await lint.loadFormatter('stylish')).format(results);
if (formatted) console.log(formatted);
if (results.some(result => result.errorCount)) process.exit(1);
console.log('Application lint checks passed.');
