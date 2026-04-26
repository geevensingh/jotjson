#!/usr/bin/env node
// Rasterizes the SVG masters under public/icons/ into the PNGs + favicon.ico
// shipped with the app. Run manually when the branding changes:
//
//   npx --yes --package=sharp@0.33.5 --package=png-to-ico@2.1.8 -- \
//     node scripts/generate-icons.mjs
//
// Writes:
//   public/icons/icon-192.png
//   public/icons/icon-512.png
//   public/icons/icon-192-maskable.png
//   public/icons/icon-512-maskable.png
//   public/favicon.ico  (16 + 32 + 48)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicDir = resolve(repoRoot, 'public');
const iconsDir = resolve(publicDir, 'icons');

async function renderPng(svgPath, outPath, size) {
  const svg = await readFile(svgPath);
  const buf = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(outPath, buf);
  console.log(`wrote ${outPath} (${buf.length} bytes)`);
}

async function main() {
  const mainSvg = resolve(iconsDir, 'icon.svg');
  const maskSvg = resolve(iconsDir, 'icon-maskable.svg');

  await renderPng(mainSvg, resolve(iconsDir, 'icon-192.png'), 192);
  await renderPng(mainSvg, resolve(iconsDir, 'icon-512.png'), 512);
  await renderPng(maskSvg, resolve(iconsDir, 'icon-192-maskable.png'), 192);
  await renderPng(maskSvg, resolve(iconsDir, 'icon-512-maskable.png'), 512);

  const svg = await readFile(mainSvg);
  const icoFrames = await Promise.all(
    [16, 32, 48].map((size) =>
      sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer()
    )
  );
  const ico = await pngToIco(icoFrames);
  const icoPath = resolve(publicDir, 'favicon.ico');
  await writeFile(icoPath, ico);
  console.log(`wrote ${icoPath} (${ico.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
