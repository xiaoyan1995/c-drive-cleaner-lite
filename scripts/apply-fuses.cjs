/**
 * apply-fuses.cjs
 * afterPack hook — 在打包后给 exe 应用 Electron Fuses。
 *
 * 默认（Lite 版）**不启用** Fuses，方便你自己改代码 / 调试构建产物。
 * 仅当检测到已执行过硬化的 .jsc 字节码（即运行了 `npm run build:harden`）时，
 * 才启用 Fuses（禁用 ELECTRON_RUN_AS_NODE / --inspect / devtools 等）。
 *
 * 图标注入（rcedit）始终执行。
 */

const path = require("node:path");
const fs = require("node:fs");

exports.default = async function (context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(context.appOutDir, "C-Drive Cleaner Lite.exe");

  // 判断是否为「加固」构建：存在 V8 字节码产物即视为已硬化
  const hardened = fs.existsSync(path.join(context.packager.projectDir, "out", "main", "index.jsc"));

  if (hardened) {
    const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
    console.log("  • [harden] applying Electron Fuses:", exePath);
    try {
      await flipFuses(exePath, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,                        // 禁止 ELECTRON_RUN_AS_NODE
        [FuseV1Options.EnableCookieEncryption]: true,            // Cookie 加密
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // 禁止 NODE_OPTIONS
        [FuseV1Options.EnableNodeCliInspectArguments]: false,    // 禁止 --inspect/--inspect-brk
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,  // ASAR 完整性验证
        [FuseV1Options.OnlyLoadAppFromAsar]: true,               // 只从 ASAR 加载
      });
      console.log("  • Electron Fuses applied successfully");
    } catch (e) {
      console.error("  • Fuses failed:", e.message);
    }
  } else {
    console.log("  • [plain] skipping Electron Fuses (non-hardened build; debugging stays enabled)");
  }

  // 应用 icon（始终执行，避免 fuses 破坏 icon 时先做也无妨）
  const { rcedit } = require("rcedit");
  const iconPath = "C:/Temp/cdrive-icon.ico";
  if (fs.existsSync(iconPath)) {
    try {
      await rcedit(exePath, { icon: iconPath });
      console.log("  • icon injected successfully");
    } catch (e) {
      console.error("  • icon inject failed:", e.message);
    }
  } else {
    console.log("  • icon not found at", iconPath, "- skipped");
  }
};
