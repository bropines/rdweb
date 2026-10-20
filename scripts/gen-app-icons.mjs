// Renders the standalone app's install icons (app/public/icons/*.png) from
// app/public/favicon.svg with resvg; the PNGs are committed. Usage:
//   node scripts/gen-app-icons.mjs
// (fetches @resvg/resvg-js-cli through npx; it is not a project dependency).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const RESVG = "@resvg/resvg-js-cli@2.6.2-beta.1";
const OUT = "app/public/icons";

// favicon.svg: a rounded square (the first <rect>) with the monitor glyph on top.
const svg = readFileSync("app/public/favicon.svg", "utf8");
const m = /^<svg[^>]*>\s*(<rect[^>]*fill="(#[0-9a-fA-F]{3,8})"[^>]*\/>)([\s\S]*)<\/svg>\s*$/.exec(svg.trim());
if (!m) throw new Error("unexpected favicon.svg layout: expected <rect fill=…/> followed by the glyph");
const [, , bg, glyph] = m;

const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
// Full-bleed square with the glyph scaled around the centre (the glyph is centred
// at about 16,16.5): maskable icons keep it inside the 40%-radius safe circle,
// iOS rounds the corners of the apple-touch-icon itself and fills transparency black.
const square = (scale) => wrap(`<rect width="32" height="32" fill="${bg}"/><g transform="translate(16 16) scale(${scale}) translate(-16 -16.5)">${glyph}</g>`);

const icons = [
  { file: "icon-192.png", size: 192, svg },
  { file: "icon-512.png", size: 512, svg },
  { file: "icon-maskable-512.png", size: 512, svg: square(0.72) },
  { file: "apple-touch-icon.png", size: 180, svg: square(0.8) },
];

mkdirSync(OUT, { recursive: true });
for (const icon of icons) {
  execFileSync("npx", ["-y", RESVG, "--no-system-font", "--fit-width", String(icon.size), "-", `${OUT}/${icon.file}`], {
    input: icon.svg,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`${OUT}/${icon.file} (${icon.size}px)`);
}
