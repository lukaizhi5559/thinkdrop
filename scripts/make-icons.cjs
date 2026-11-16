/**
 * make-icons.cjs — one-shot icon generator, run via `yarn icons`
 * (npx electron scripts/make-icons.cjs).
 *
 * Renders the ThinkDrop droplet-in-circle mark to PNG through a hidden
 * BrowserWindow + capturePage (no rasterizer deps), producing:
 *
 *   src/main/assets/tray-iconTemplate.png      22×22  — macOS menu-bar Tray
 *   src/main/assets/tray-iconTemplate@2x.png   44×44  (white-on-transparent;
 *                                                     image.setTemplateImage(true)
 *                                                     lets macOS invert it for
 *                                                     light/dark menu bars)
 *   build/icon.iconset/icon_*.png              16–1024 — electron-builder app icon
 *   build/icon.icns                            via `iconutil -c icns`
 *
 * Tray assets live under src/main/ so they fall inside the package.json
 * `files: src/main/**` glob (src/renderer/assets is NOT packaged).
 * Brand colors below approximate src/renderer/assets/logo.jpg — tweak and
 * re-run `yarn icons` to iterate.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN_ASSETS = path.join(ROOT, 'src', 'main', 'assets');
const BUILD_DIR = path.join(ROOT, 'build');
const ICONSET = path.join(BUILD_DIR, 'icon.iconset');

const TEAL = '#1fb0a0';  // droplet + ring (logo.jpg teal)
const NAVY = '#16222e';  // app-icon background (logo.jpg navy)
const RENDER = 1024;     // render once at max size, downscale for every output

// ThinkDropLogo geometry (src/renderer/components/SlideoutDrawer.tsx) scaled to
// a 1024 viewBox: stroked circle r≈10→427, filled droplet.
const appIconSvg = (px) => `
<svg width="${px}" height="${px}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" fill="${NAVY}"/>
  <circle cx="512" cy="512" r="427" fill="none" stroke="${TEAL}" stroke-width="64"/>
  <path d="M512 256c0 0-171 171-171 341c0 94 76 171 171 171s171-77 171-171c0-170-171-341-171-341z" fill="${TEAL}"/>
</svg>`;

// Menu-bar template — white shapes on transparent (macOS uses only the alpha
// channel for template images). Circle ring slightly bolder + droplet slightly
// larger than the logo proportions so it stays legible at 22px.
const trayIconSvg = (px) => `
<svg width="${px}" height="${px}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="9" fill="none" stroke="#ffffff" stroke-width="2.6"/>
  <path d="M12 7c0 0-3.2 3.2-3.2 6.4a3.2 3.2 0 1 0 6.4 0c0-3.2-3.2-6.4-3.2-6.4z" fill="#ffffff"/>
</svg>`;

// One hidden window reused for every render — a temp file:// page avoids the
// data: URL flakiness seen on back-to-back loads (ERR_FAILED on the second
// navigation). transparent+frameless keeps alpha in the captured PNG.
let _win = null;
let _tmpHtml = null;

async function renderPng(svgFn, outSize) {
  if (!_win) {
    _win = new BrowserWindow({
      show: false, frame: false, transparent: true,
      width: RENDER, height: RENDER,
    });
    _tmpHtml = path.join(app.getPath('temp'), 'thinkdrop-icon-render.html');
  }
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svgFn(RENDER)}</body></html>`;
  fs.writeFileSync(_tmpHtml, html);
  await _win.loadFile(_tmpHtml);
  // One beat for SVG raster before capture.
  await new Promise(r => setTimeout(r, 150));
  const img = await _win.webContents.capturePage();
  if (img.isEmpty()) throw new Error('capturePage returned an empty image');
  return img.resize({ width: outSize, height: outSize, quality: 'best' }).toPNG();
}

const ICONSET_SIZES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(MAIN_ASSETS, { recursive: true });
    fs.mkdirSync(ICONSET, { recursive: true });

    // Menu-bar tray templates
    for (const [file, px] of [['tray-iconTemplate.png', 22], ['tray-iconTemplate@2x.png', 44]]) {
      fs.writeFileSync(path.join(MAIN_ASSETS, file), await renderPng(trayIconSvg, px));
      console.log(`[icons] wrote src/main/assets/${file}`);
    }

    // App icon iconset → icon.icns
    for (const [file, px] of ICONSET_SIZES) {
      fs.writeFileSync(path.join(ICONSET, file), await renderPng(appIconSvg, px));
    }
    execSync(`iconutil -c icns "${ICONSET}" -o "${path.join(BUILD_DIR, 'icon.icns')}"`);
    console.log('[icons] wrote build/icon.icns');
  } catch (err) {
    console.error('[icons] failed:', err);
    process.exitCode = 1;
  } finally {
    try { _win?.destroy(); } catch (_) {}
    app.quit();
  }
});
