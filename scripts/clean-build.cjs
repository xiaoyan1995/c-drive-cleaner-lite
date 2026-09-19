const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const targets = [
  path.join(root, "out")
];

function removeTree(target) {
  if (!fs.existsSync(target)) return;

  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }

  for (const entry of fs.readdirSync(target)) {
    removeTree(path.join(target, entry));
  }
  fs.rmdirSync(target);
}

for (const target of targets) {
  removeTree(target);
}
