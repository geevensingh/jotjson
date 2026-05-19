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
//   public/favicon.ico            (16 + 32 + 48)
//
//   public/icons/icon-nonprod-192.png  -- env-indicator nonprod variant
//   public/favicon-nonprod.ico         (16 + 32 + 48)
//
// Nonprod outputs are rasterized from `icon-nonprod.svg`. The SVG
// itself is the source for the `<link rel="icon" type="image/svg+xml">`
// swap; the PNG covers `apple-touch-icon`; the ICO covers legacy
// bookmark / tab UIs and browsers that ignore the SVG link.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

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
  const nonprodSvg = resolve(iconsDir, 'icon-nonprod.svg');

  await renderPng(mainSvg, resolve(iconsDir, 'icon-192.png'), 192);
  await renderPng(mainSvg, resolve(iconsDir, 'icon-512.png'), 512);
  await renderPng(maskSvg, resolve(iconsDir, 'icon-192-maskable.png'), 192);
  await renderPng(maskSvg, resolve(iconsDir, 'icon-512-maskable.png'), 512);

  // Env-indicator variant: matches the apple-touch-icon size only.
  // We do NOT ship a nonprod 512px PWA install icon -- the installed
  // PWA continues to show prod branding, which is deliberate (see
  // plan.md "Variants considered").
  await renderPng(nonprodSvg, resolve(iconsDir, 'icon-nonprod-192.png'), 192);

  await renderIco(mainSvg, resolve(publicDir, 'favicon.ico'));
  await renderIco(nonprodSvg, resolve(publicDir, 'favicon-nonprod.ico'));
}

async function renderIco(svgPath, outPath) {
  const svg = await readFile(svgPath);
  const icoFrames = await Promise.all(
    [16, 32, 48].map((size) =>
      sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    ),
  );
  const ico = await pngToIco(icoFrames);
  await writeFile(outPath, ico);
  console.log(`wrote ${outPath} (${ico.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
