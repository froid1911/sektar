#!/usr/bin/env node
// Sektar brand assets for the Connect, PWA and desktop hosts, rendered from
// the design system's SVGs with sharp. Output: icons/ (referenced from
// powerhouse.config.json and hosts/desktop/app.json).
//
//   node scripts/build-icons.mjs [path/to/design-system]
//
// sharp is resolved from the linked monorepo (it is not a project dependency):
// $POWERHOUSE_DIR when set, else the sibling ../powerhouse.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const D = path.resolve(
  process.argv[2] ??
    process.env.SEKTAR_DESIGN_SYSTEM ??
    path.join(root, "..", "sektar-design-elements", "design-system"),
  "assets",
);
const OUT = path.join(root, "icons");
fs.mkdirSync(OUT, { recursive: true });

function loadSharp() {
  const monorepo = path.resolve(
    root,
    process.env.POWERHOUSE_DIR || "../powerhouse",
  );
  const candidates = [
    path.join(root, "node_modules", "sharp", "package.json"),
    path.join(monorepo, "node_modules", "sharp", "package.json"),
  ];
  const pnpm = path.join(monorepo, "node_modules", ".pnpm");
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) {
      if (d.startsWith("sharp@"))
        candidates.push(path.join(pnpm, d, "node_modules", "sharp", "package.json"));
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return createRequire(c)("./lib/index.js");
  }
  throw new Error("sharp not found; install it or link the monorepo");
}
const sharp = loadSharp();

const svg = (p) => fs.readFileSync(path.join(D, p));
const png = (buf, w, h = w) =>
  sharp(buf, { density: 600 })
    .resize(w, h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();

// App icon master + favicon/PWA sizes (Forest colourway, light background)
const appIcon = svg("app-icons/sektar-app-icon-forest-light.svg");
for (const s of [1024, 512, 192, 64, 32, 16]) {
  await png(appIcon, s).toFile(
    path.join(OUT, s === 1024 ? "sektar.png" : `sektar_${s}x${s}.png`),
  );
}

// Symbol (sidebar / drive icon) at 64 and 128; favicon.svg copied as is
const symbol = svg("logos/sektar-symbol-light.svg");
await png(symbol, 128).toFile(path.join(OUT, "sektar_symbol_128x128.png"));
await png(symbol, 64).toFile(path.join(OUT, "sektar_symbol_64x64.png"));
fs.copyFileSync(path.join(D, "favicon.svg"), path.join(OUT, "favicon.svg"));

// Splash: the design system's primary lockup with the tagline — symbol,
// wordmark, and the product line under the wordmark, with the geometry of
// `.sk-lockup` (h = wordmark height; symbol 1.634h, gap 0.306h, wordmark
// top 0.369h, tagline 0.186h tall, tracked 0.26em, starting 0.069h in).
// Transparent, one per colour scheme; the desktop loading page picks one.
const PRODUCT = "FINANCE OPERATIONS";
async function lockup(tone, taglineColor) {
  const h = 186;
  const symW = Math.round(h * 1.634 * (167 / 152));
  const symH = Math.round(h * 1.634);
  const wordW = Math.round(h * (321 / 93));
  const gap = Math.round(h * 0.306);
  const wordTop = Math.round(h * 0.369);
  const tagSize = h * 0.186;
  const tagTop = wordTop + h + Math.round(h * 0.17);
  const pad = 24;
  const width = pad + symW + gap + wordW + pad;
  const height = Math.max(symH, tagTop + Math.round(tagSize * 1.7)) + pad * 2;
  const symbol = await png(svg(`logos/sektar-symbol-${tone}.svg`), symW, symH).toBuffer();
  const wordmark = await png(svg(`logos/sektar-wordmark-${tone}.svg`), wordW, h).toBuffer();
  const tagline = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${wordW}" height="${Math.round(tagSize * 1.7)}">
         <text x="${(h * 0.069).toFixed(1)}" y="${(tagSize * 1.2).toFixed(1)}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif"
               font-size="${tagSize.toFixed(1)}" font-weight="500" letter-spacing="${(tagSize * 0.26).toFixed(1)}" fill="${taglineColor}">${PRODUCT}</text>
       </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: symbol, left: pad, top: pad },
      { input: wordmark, left: pad + symW + gap, top: pad + wordTop },
      { input: tagline, left: pad + symW + gap, top: pad + tagTop },
    ])
    .png()
    .toBuffer();
}
await sharp(await lockup("light", "#57615C")).toFile(path.join(OUT, "sektar_lockup_light.png"));
await sharp(await lockup("dark", "#C4CFC9")).toFile(path.join(OUT, "sektar_lockup_dark.png"));
// The loading page's corner art: the double-curved growth mark, flush to the corner.
for (const tone of ["light", "dark"]) {
  await png(svg(`shapes/sektar-growth-double-curved-${tone}.svg`), 1040, 1040).toFile(
    path.join(OUT, `sektar_growth_${tone}.png`),
  );
}

// Home background: brand photo, cover-cropped, webp
const photo = fs.readFileSync(path.join(D, "photos/workspace-with-lush-greenery.jpg"));
await sharp(photo)
  .resize(2048, 1152, { fit: "cover", position: "centre" })
  .webp({ quality: 82, effort: 6 })
  .toFile(path.join(OUT, "sektar_background_2048x1152.webp"));

// Explorer icons from the sprite, with the light-theme tones baked in
const sprite = fs.readFileSync(path.join(D, "icons.svg"), "utf8");
const tones = { 1: "#1F3A2E", 2: "#6B8F73", 3: "#BFD7BD" };
function fromSprite(id) {
  const m = new RegExp('<symbol[^>]*id="' + id + '"[^>]*>([^]*?)</symbol>').exec(sprite);
  if (!m) throw new Error(`no symbol ${id}`);
  const body = m[1]
    .replace(/var\(--sk-icon-(\d)\)/g, (_, n) => tones[n])
    .replace(/currentColor/g, tones[1]);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${body}</svg>`,
  );
}
for (const [id, name] of [
  ["i-folder", "folder"],
  ["i-invoice", "invoice"],
  ["i-reports", "document"],
  ["i-bank", "bank"],
  ["i-wallet", "expense"],
  ["i-customers", "contact"],
  ["i-card", "card"],
]) {
  await png(fromSprite(id), 128).toFile(path.join(OUT, `sektar_${name}_128x128.png`));
}
for (const f of fs.readdirSync(OUT).sort()) {
  console.log(f.padEnd(36), fs.statSync(path.join(OUT, f)).size);
}
