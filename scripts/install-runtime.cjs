'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const installer = path.join(root, 'node_modules', 'electron', 'install.js');
if (fs.existsSync(installer)) {
  const result = spawnSync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, electron_config_cache: path.join(root, '.cache', 'electron') },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
