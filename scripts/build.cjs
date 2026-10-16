'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { build, Platform, Arch } = require('electron-builder');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
process.env.ELECTRON_BUILDER_CACHE = path.join(root, '.cache', 'builder');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const installer = process.argv.includes('--installer');

async function main() {
  await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget(installer ? 'nsis' : 'dir', Arch.x64),
    publish: 'never',
    config: { ...pkg.build, electronDist: path.join(root, 'node_modules', 'electron', 'dist') },
  });
  const output = path.join(root, 'outputs');
  fs.mkdirSync(output, { recursive: true });
  const launcher =
    '@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" /D "%~dp0desktop\\win-unpacked" "%~dp0desktop\\win-unpacked\\Office Notes.exe" "--data-dir=%~dp0..\\data"\r\n';
  fs.writeFileSync(path.join(output, '启动桌面便签.cmd'), launcher, 'utf8');
  console.log('Build ready: outputs/启动桌面便签.cmd');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
