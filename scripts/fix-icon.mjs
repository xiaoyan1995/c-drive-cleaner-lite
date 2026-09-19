import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rcedit } = require("rcedit");

const exePath = "release/win-unpacked/C-Drive Cleaner.exe";
const iconPath = "build/icon.ico";

console.log("注入图标...");
rcedit(exePath, { icon: iconPath })
  .then(() => console.log("图标注入成功！"))
  .catch((e) => console.error("失败:", e.message));
