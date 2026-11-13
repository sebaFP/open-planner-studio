#!/usr/bin/env node
// Builds `headless/pyc-motor/` (CPM, leveling and the P6/MS Project/CSV adapters behind a plain-JSON
// model) as a standalone ESM package `@pyc/ops-motor` in `dist-pyc-motor/`. Platform-neutral: it runs
// in Node 22 and in a Web Worker (no DOM; the reader installs its own XML parser).
//
//   node scripts/build-pyc-motor.mjs [--out <dir>]
//
// Same library boundary as scripts/build-core.mjs (React, Tauri, the app store, UI components and the
// i18n UI config must not end up in the bundle). License: LGPL-3.0-or-later.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { forbiddenInputs, headlessStubPlugin, metafileInputs } from './lib/headless-bundle.mjs';
import { thirdPartyNotices } from './lib/third-party-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const outDir = resolve(outIdx >= 0 ? process.argv[outIdx + 1] : join(root, 'dist-pyc-motor'));
const appPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NAME = '@pyc/ops-motor';
let commit = 'unknown';
try { commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(root, 'headless/pyc-motor/index.ts')],
  bundle: true,
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  format: 'esm',
  outfile: join(outDir, 'index.mjs'),
  alias: { '@': join(root, 'src') },
  plugins: [headlessStubPlugin(root, NAME)],
  metafile: true,
  legalComments: 'eof',
  logLevel: 'warning',
  banner: { js: `// ${NAME} — Open Planner Studio ${appPkg.version} (${commit}) — ${appPkg.license}. Built by scripts/build-pyc-motor.mjs; do not edit.` },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.MODE': '"production"',
    '__OPS_DEV_INSTANCE__': '"core"',
    '__OPS_CORE_VERSION__': JSON.stringify(appPkg.version),
  },
});

const inputs = metafileInputs(result.metafile);
const leaks = forbiddenInputs(inputs);
if (leaks.length > 0) {
  console.error(`XX the bundle contains ${leaks.length} forbidden input(s):\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
const nodeBuiltins = inputs.filter((p) => p.startsWith('node:'));
if (nodeBuiltins.length) {
  console.error(`XX the bundle imports Node built-ins (must run in a Web Worker): ${nodeBuiltins.join(', ')}`);
  process.exit(1);
}

copyFileSync(join(root, 'headless/pyc-motor/api.ts'), join(outDir, 'api.d.ts'));
writeFileSync(join(outDir, 'index.d.ts'), `export type * from './api.js';
import type { Modelo, ResultadoProgramacion, ResultadoNivelacion, ResultadoLectura, ResultadoEscritura, FormatoEscritura, CodigoErrorMotor } from './api.js';
export declare const VERSION_OPS: string;
export declare class ErrorMotor extends Error { readonly codigo: CodigoErrorMotor; constructor(codigo: CodigoErrorMotor, mensaje: string); }
export declare function programar(modelo: Modelo): ResultadoProgramacion;
export declare function nivelar(modelo: Modelo, opciones?: { soloHolgura?: boolean; recursoIds?: string[] }): ResultadoNivelacion;
export declare function leerArchivo(nombre: string, bytes: Uint8Array): Promise<ResultadoLectura>;
export declare function escribir(modelo: Modelo, formato: FormatoEscritura): ResultadoEscritura;
`);
const notices = thirdPartyNotices(inputs);
writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.md'), `# Third-party notices\n\n\`index.mjs\` of ${NAME} bundles: ${notices.packages.join(', ')}.\n\n${notices.sections}`);
const pkg = {
  name: NAME,
  version: appPkg.version.replace(/^(\d+)\.(\d+)\.(\d+)$/, '$1.$2.$3'),
  description: 'Scheduling core of Open Planner Studio (CPM, leveling, P6/MS Project/CSV) behind a plain-JSON model.',
  license: appPkg.license,
  repository: { type: 'git', url: 'https://github.com/sebaFP/open-planner-studio', directory: 'headless/pyc-motor' },
  opsCommit: commit,
  type: 'module',
  main: './index.mjs',
  types: './index.d.ts',
  exports: { '.': { types: './index.d.ts', default: './index.mjs' }, './package.json': './package.json' },
  sideEffects: false,
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
copyFileSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'));
copyFileSync(join(root, 'LICENSE.GPL'), join(outDir, 'LICENSE.GPL'));
writeFileSync(join(outDir, 'README.md'), `# ${NAME}

Scheduling core of [Open Planner Studio](https://github.com/OpenAEC-Foundation/open-planner-studio)
${appPkg.version}, commit \`${commit}\`, built from the fork https://github.com/sebaFP/open-planner-studio
(branch \`pyc\`, entry \`headless/pyc-motor/\`). License ${appPkg.license} (LICENSE, LICENSE.GPL); the
\`.mpp\` reader derives from MPXJ (LGPL-2.1). The complete corresponding source is that fork and commit.
This package is a separate, replaceable module: rebuild it from the source with
\`node scripts/build-pyc-motor.mjs\` and drop the output in place of this folder.
`);
const kb = (result.metafile.outputs[relative(process.cwd(), join(outDir, 'index.mjs')).replace(/\\/g, '/')]?.bytes ?? 0) / 1024;
console.log(`OK — ${NAME} built in ${relative(root, outDir)} (${inputs.length} modules${kb ? `, ${kb.toFixed(0)} KB` : ''}).`);
