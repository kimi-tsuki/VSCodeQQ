'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.test-profile');
const extensions = path.join(root, '.test-extensions');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.mkdirSync(extensions, { recursive: true });
fs.rmSync(path.join(profile, 'User', 'globalStorage', 'rynxis.vscode-qq'), { recursive: true, force: true });
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'qq.autoConnect': false, 'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
  'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'window.restoreWindows': 'none'
}));
const isolated = path.join(root, '.vscode-test', 'runtime', 'Code.exe');
const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : 'code');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
const result = spawnSync(executable, [
  '--new-window', '--disable-updates', '--skip-welcome', '--skip-release-notes',
  '--remote-debugging-port=19222', '--remote-debugging-address=127.0.0.1',
  '--user-data-dir', profile, '--extensions-dir', extensions,
  `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist', 'test', 'extension.cjs')}`
], { cwd: root, env, stdio: 'inherit', timeout: 180000 });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
