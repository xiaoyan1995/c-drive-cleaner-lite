const { spawn } = require("node:child_process");
const { join } = require("node:path");

delete process.env.ELECTRON_RUN_AS_NODE;

const executable = process.platform === "win32" ? "electron-vite.cmd" : "electron-vite";
const bin = join(__dirname, "..", "node_modules", ".bin", executable);
const args = process.argv.slice(2);
const command = process.platform === "win32" ? "cmd.exe" : bin;
const spawnArgs = process.platform === "win32" ? ["/d", "/c", "call", bin, ...args] : args;
const child = spawn(command, spawnArgs, {
  stdio: "inherit",
  env: process.env,
  shell: false
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
