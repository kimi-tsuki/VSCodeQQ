import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await build({
  entryPoints: { extension: 'src/extension.ts', 'test/unit': 'tests/unit.ts', 'test/extension': 'tests/extension.ts', 'test/live': 'tests/live.ts', 'test/preview': 'tests/preview.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'],
  sourcemap: true, logLevel: 'info'
});
