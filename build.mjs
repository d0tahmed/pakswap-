import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
const root = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const bundle = async (artifact) => {
  const res = await build({
    entryPoints: [path.join(root, 'src/main.js')], bundle: true, format: 'iife', minify: true, target: 'es2020',
    write: false, legalComments: 'none', logLevel: 'warning', define: { __ARTIFACT__: artifact ? 'true' : 'false' },
    loader: { '.txt': 'text', '.wasm': 'binary' },
  });
  return res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
};
const jsArtifact = await bundle(true);
const jsApp = await bundle(false);
const font = (pkg, file, family, weight) => {
  const p = path.join(root, 'node_modules/@fontsource', pkg, 'files', file);
  const b64 = fs.readFileSync(p).toString('base64');
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");}`;
};
const fonts = [
  font('chakra-petch', 'chakra-petch-latin-500-normal.woff2', 'Chakra Petch', 500),
  font('chakra-petch', 'chakra-petch-latin-600-normal.woff2', 'Chakra Petch', 600),
  font('chakra-petch', 'chakra-petch-latin-700-normal.woff2', 'Chakra Petch', 700),
  font('archivo', 'archivo-latin-400-normal.woff2', 'Archivo', 400),
  font('archivo', 'archivo-latin-500-normal.woff2', 'Archivo', 500),
  font('archivo', 'archivo-latin-600-normal.woff2', 'Archivo', 600),
  font('archivo', 'archivo-latin-700-normal.woff2', 'Archivo', 700),
  font('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2', 'JetBrains Mono', 400),
].join('\n');
const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const body = tpl.replace('{{FONTS_CSS}}', () => fonts).replace('{{APP_JS}}', () => jsApp);
const bodyArtifact = tpl.replace('{{FONTS_CSS}}', () => fonts).replace('{{APP_JS}}', () => jsArtifact);
fs.writeFileSync(path.join(dist, 'pakswap-artifact.html'), bodyArtifact);
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${body.replace(/<div class="app"[\s\S]*$/, '')}</head>\n<body>\n${body.slice(body.indexOf('<div class="app"'))}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(dist, 'index.html'), full);
console.log('js', (jsApp.length / 1024).toFixed(0) + 'KB', 'artifact', (body.length / 1024).toFixed(0) + 'KB', 'full', (full.length / 1024).toFixed(0) + 'KB');
