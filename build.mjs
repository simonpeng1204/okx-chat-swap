import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesBase } from './hosting.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--pages')) {
  throw new Error('Usage: node build.mjs [--pages APPROVED_REPOSITORY]');
}
const publicBase = args.length ? pagesBase(args[1]) : null;
const outputDir = join(dir, publicBase ? 'dist-pages' : 'dist');
const staticFiles = ['app.mjs', 'confirmation.mjs', 'hosting.mjs', 'icon.png', 'semantics.mjs',
  'solana-wire.mjs', 'styles.css', 'wallet.mjs'];

let sdk;
let html = await readFile(join(dir, 'index.html'), 'utf8');
if (publicBase) {
  const { build } = await import('esbuild');
  const bundled = await build({
    absWorkingDir: dir, entryPoints: ['wallet-sdk.mjs'], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: 'es2022', outfile: 'wallet-sdk.mjs',
    minify: true, legalComments: 'eof',
  });
  sdk = bundled.outputFiles.find(file => file.path.endsWith('/wallet-sdk.mjs'));
  if (!sdk || bundled.outputFiles.length !== 1) throw new Error('Expected one self-contained OKX SDK module');
  html = html.replace("connect-src 'self';",
    "connect-src 'self' https://*.okx.com wss://*.okx.com https://*.walletconnect.com "
    + 'wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org;');
}

await mkdir(outputDir, { recursive: true });
for (const filename of staticFiles) await copyFile(join(dir, filename), join(outputDir, filename));
await writeFile(join(outputDir, 'index.html'), html);
await writeFile(join(outputDir, 'deployment.mjs'), 'export const deployment = Object.freeze('
  + JSON.stringify({ publicBase }) + ');\n');
if (sdk) await writeFile(join(outputDir, 'wallet-sdk.mjs'), sdk.contents);
else await copyFile(join(dir, 'wallet-sdk.mjs'), join(outputDir, 'wallet-sdk.mjs'));
await writeFile(join(outputDir, '.nojekyll'), '');
console.log(publicBase
  ? 'Built web/dist-pages with the OKX SDK bundled. Public availability still requires verification.'
  : 'Built web/dist for local review. Public origin is unset and wallet connection is disabled.');
