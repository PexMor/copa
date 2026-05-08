#!/usr/bin/env node
// Headless Playwright SVG-to-PNG renderer for icon-gen skill.
//
// Usage:
//   node render-svg.js <svg-file-or-string> <output-dir> <size1> [size2] [size3] ...
//
// Examples:
//   node render-svg.js icon.svg ./out 16 32 128 512
//   node render-svg.js '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚀</text></svg>' ./out 256
//
// For emoji SVGs, the script rescales the viewBox and font-size to match the
// target pixel size so the browser rasterizes the emoji at native resolution
// instead of upscaling a small bitmap.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Below this output size, emoji is scaled down and centered to avoid clipping.
const EMOJI_INSET_THRESHOLD = 48;
// Inset factor by size: smaller size → more padding so the glyph stays fully visible.
function emojiInsetFactor(size) {
  if (size > EMOJI_INSET_THRESHOLD) return 1;
  // 16px → 0.6, 32px → 0.7, 48px → 0.75
  const t = size / EMOJI_INSET_THRESHOLD;
  return 0.6 + t * 0.15;
}

function scaleEmojiSvg(svg, size) {
  const vbMatch = svg.match(/viewBox="(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/);
  const fsMatch = svg.match(/font-size="(\d+)"/);
  if (!vbMatch || !fsMatch) return null;

  const vbW = Number(vbMatch[3]);
  const vbH = Number(vbMatch[4]);
  const scale = size / vbW;
  const useInset = size <= EMOJI_INSET_THRESHOLD;
  let newFontSize = Math.round(Number(fsMatch[1]) * scale);
  if (useInset) {
    newFontSize = Math.round(newFontSize * emojiInsetFactor(size));
  }

  let scaled = svg
    .replace(/viewBox="[^"]*"/, `viewBox="0 0 ${size} ${size}"`)
    .replace(/font-size="[^"]*"/, `font-size="${newFontSize}"`);

  if (useInset) {
    const cx = size / 2;
    const cy = size / 2;
    scaled = scaled.replace(
      /<text[^>]*>([\s\S]*?)<\/text>/,
      (_, content) =>
        `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="${newFontSize}">${content}</text>`
    );
  }

  if (scaled.includes('width=')) {
    scaled = scaled
      .replace(/width="[^"]*"/, `width="${size}"`)
      .replace(/height="[^"]*"/, `height="${size}"`);
  } else {
    scaled = scaled.replace('<svg ', `<svg width="${size}" height="${size}" `);
  }

  return scaled;
}

function scaleRegularSvg(svg, size) {
  if (svg.includes('width=')) {
    return svg
      .replace(/width="[^"]*"/, `width="${size}"`)
      .replace(/height="[^"]*"/, `height="${size}"`);
  }
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: render-svg.js <svg-file-or-string> <output-dir> <size1> [size2] ...');
    process.exit(1);
  }

  const svgInput = args[0];
  const outputDir = args[1];
  const sizes = args.slice(2).map(Number);

  const svg = fs.existsSync(svgInput)
    ? fs.readFileSync(svgInput, 'utf-8').replace(/<\?xml[^?]*\?>\s*/, '')
    : svgInput;

  const isEmoji = svg.includes('<text');

  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const size of sizes) {
    const sized = isEmoji ? scaleEmojiSvg(svg, size) : scaleRegularSvg(svg, size);
    if (!sized) {
      console.error(`Could not scale SVG for size ${size}, skipping`);
      continue;
    }

    const html = [
      '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}</style></head>',
      `<body style="width:${size}px;height:${size}px;overflow:hidden">`,
      sized,
      '</body></html>'
    ].join('');

    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html, { waitUntil: 'networkidle' });

    const outPath = path.join(outputDir, `icon-${size}.png`);
    await page.locator('svg').screenshot({ path: outPath });
    console.log(`Saved ${outPath} (${size}x${size})`);
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
