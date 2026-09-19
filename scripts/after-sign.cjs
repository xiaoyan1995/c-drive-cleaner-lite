const { rcedit } = require("rcedit");
const path = require("path");

exports.default = async function(context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(context.appOutDir, "C-Drive Cleaner Lite.exe");
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");

  console.log("  • injecting icon after sign:", exePath);
  try {
    await rcedit(exePath, { icon: iconPath });
    console.log("  • icon injected successfully");
  } catch (e) {
    console.error("  • icon inject failed:", e.message);
  }
};
