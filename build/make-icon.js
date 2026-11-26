// Renders build/icon.svg to PNGs with Chromium (Playwright) and packs them into build/icon.icns.
// Usage: node build/make-icon.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ICNS_TYPES = [ // [type, pixel size]
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pngs = {};
  for (const size of [...new Set(ICNS_TYPES.map((t) => t[1]))]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
    pngs[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), pngs[1024]);
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'drag.png'), pngs[64]);
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const data = pngs[size];
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(__dirname, 'icon.icns'), Buffer.concat([header, body]));
  console.log('wrote build/icon.icns and build/icon.png');
})();
