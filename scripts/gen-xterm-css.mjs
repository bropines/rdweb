// Writes src/react/xtermCss.ts from @xterm/xterm's stylesheet (run after upgrading it).
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8");
const { version } = JSON.parse(readFileSync("node_modules/@xterm/xterm/package.json", "utf8"));
writeFileSync(
  "src/react/xtermCss.ts",
  `// xterm.css of @xterm/xterm ${version} (MIT, Copyright (c) 2014-2016 SourceLair Private Company, 2017-2019 The xterm.js authors),\n` +
    `// injected when a terminal opens so hosts need no extra stylesheet.\n` +
    `// Regenerate after upgrading @xterm/xterm: npm run gen:xterm-css.\n` +
    `export const XTERM_CSS = ${JSON.stringify(css)};\n`,
);
