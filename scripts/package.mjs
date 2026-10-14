import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('artifacts', { recursive: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const result = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--out', `artifacts/vscode-qq-${version}.vsix`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
