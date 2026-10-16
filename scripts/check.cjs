'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let count = 0;
function check(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) check(file);
    else if (/\.(?:cjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status !== 0) {
        console.error(result.stderr);
        process.exit(1);
      }
      count += 1;
    }
  }
}
for (const folder of ['src', 'scripts', 'test']) check(path.join(root, folder));
console.log(`${count} JavaScript files passed syntax checks.`);
