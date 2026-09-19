const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const rendererPath = path.join(projectRoot, "src", "renderer", "src", "App.tsx");
const mainPath = path.join(projectRoot, "src", "main", "index.ts");

const rendererSource = fs.readFileSync(rendererPath, "utf8");

/** Concatenate all main-process .ts sources so handlers defined in ipc/*.ts are seen too. */
function collectAllMainSource(dir) {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out += collectAllMainSource(full);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out += "\n" + fs.readFileSync(full, "utf8");
    }
  }
  return out;
}
const mainSource = collectAllMainSource(path.join(projectRoot, "src", "main")) + "\n" + fs.readFileSync(mainPath, "utf8");
const rendererFile = ts.createSourceFile(rendererPath, rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function collectDeadButtons() {
  const rows = [];
  function hasAttr(node, name) {
    return node.attributes.properties.some(
      (item) => ts.isJsxAttribute(item) && item.name.text === name
    );
  }
  function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(rendererFile) === "button") {
      if (!hasAttr(node, "onClick") && !hasAttr(node, "onChange") && !hasAttr(node, "disabled")) {
        const line = rendererFile.getLineAndCharacterOfPosition(node.getStart(rendererFile)).line + 1;
        rows.push(line);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(rendererFile);
  return rows;
}

function collectRendererInvokeChannels() {
  const channels = new Set();
  const re = /invoke(?:<[^>]*>)?\(\s*"([^"]+)"/g;
  let match = re.exec(rendererSource);
  while (match) {
    channels.add(match[1]);
    match = re.exec(rendererSource);
  }
  return channels;
}

function collectMainHandlers() {
  const channels = new Set();
  const re = /ipcMain\.handle\(\s*"([^"]+)"/g;
  let match = re.exec(mainSource);
  while (match) {
    channels.add(match[1]);
    match = re.exec(mainSource);
  }
  return channels;
}

function verifyNoMockPayloadDefaults() {
  const forbidden = [
    /const\s+trendData\s*:\s*/m,
    /const\s+defaultActivityLogs\s*=\s*\[\s*\{[^]*?\}\s*\]/m
  ];
  return forbidden.filter((re) => re.test(rendererSource)).map((re) => re.toString());
}

function main() {
  const deadButtons = collectDeadButtons();
  const rendererChannels = collectRendererInvokeChannels();
  const mainHandlers = collectMainHandlers();
  const missingHandlers = [...rendererChannels].filter((channel) => !mainHandlers.has(channel));
  const mockDefaults = verifyNoMockPayloadDefaults();

  if (deadButtons.length > 0) {
    console.error(`[ui-contract] dead buttons found at lines: ${deadButtons.join(", ")}`);
    process.exit(1);
  }
  if (missingHandlers.length > 0) {
    console.error(`[ui-contract] missing ipc handlers: ${missingHandlers.join(", ")}`);
    process.exit(1);
  }
  if (mockDefaults.length > 0) {
    console.error(`[ui-contract] mock payload defaults detected: ${mockDefaults.join(" | ")}`);
    process.exit(1);
  }

  console.log(`[ui-contract] ok; renderer channels=${rendererChannels.size}, main handlers=${mainHandlers.size}`);
}

main();
