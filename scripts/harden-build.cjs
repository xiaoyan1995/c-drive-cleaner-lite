/**
 * harden-build.cjs
 * 在 electron-vite build 之后、electron-builder 打包之前运行：
 * 1. 用 javascript-obfuscator 混淆 out/main/index.js
 * 2. 用 bytenode 编译成 V8 字节码 out/main/index.jsc
 * 3. 替换 out/main/index.js 为 bytenode loader
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN_JS = path.join(ROOT, "out", "main", "index.js");
const MAIN_JSC = path.join(ROOT, "out", "main", "index.jsc");
const OBFUSCATED = path.join(ROOT, "out", "main", "index.obf.js");

console.log("\n[harden] Starting hardening pipeline...");

// ---------- Step 1: Obfuscate ----------
console.log("[harden] Step 1: Obfuscating main process JS...");

const JavaScriptObfuscator = require("javascript-obfuscator");
const source = fs.readFileSync(MAIN_JS, "utf8");

const obfResult = JavaScriptObfuscator.obfuscate(source, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false, // keep console for error tracking
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false, // don't rename globals - breaks electron APIs
  rotateStringArray: true,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ["rc4"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 5,
  stringArrayWrappersType: "function",
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  target: "node",
});

fs.writeFileSync(OBFUSCATED, obfResult.getObfuscatedCode(), "utf8");
console.log(`[harden] Obfuscated: ${(fs.statSync(OBFUSCATED).size / 1024).toFixed(0)} KB`);

// ---------- Step 2: Bytenode compile ----------
console.log("[harden] Step 2: Compiling to V8 bytecode...");

// bytenode needs to run with the same electron binary
const bytenodePath = path.join(ROOT, "node_modules", ".bin", "bytenode");
const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

// compile obfuscated JS to .jsc using electron's V8
const compileScript = `
const bytenode = require('bytenode');
bytenode.compileFile({
  filename: ${JSON.stringify(OBFUSCATED)},
  output: ${JSON.stringify(MAIN_JSC)},
  electron: true,
});
console.log('Bytecode compiled OK');
`;

const compileScriptPath = path.join(ROOT, "out", "main", "_compile.cjs");
fs.writeFileSync(compileScriptPath, compileScript);

try {
  execSync(`"${electronPath}" "${compileScriptPath}"`, {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
} finally {
  fs.unlinkSync(compileScriptPath);
  fs.unlinkSync(OBFUSCATED);
}

// ---------- Step 3: Replace index.js with self-verifying loader ----------
console.log("[harden] Step 3: Installing self-verifying bytenode loader...");

const crypto = require("node:crypto");
const jscHash = crypto.createHash("sha256").update(fs.readFileSync(MAIN_JSC)).digest("hex");
console.log(`[harden] .jsc SHA256: ${jscHash}`);

const loader = `'use strict';
const _c=require('node:crypto'),_f=require('node:fs'),_p=require('node:path');
const _h=${JSON.stringify(jscHash)};
const _j=_p.join(__dirname,'index.jsc');
try{const _d=_f.readFileSync(_j);const _x=_c.createHash('sha256').update(_d).digest('hex');if(_x!==_h){process.exit(0);}require('bytenode');require('./index.jsc');}catch{process.exit(0);}
`;

fs.writeFileSync(MAIN_JS, loader, "utf8");
console.log("[harden] Main process: self-verifying loader installed");
console.log("[harden] Hardening complete!\n");
