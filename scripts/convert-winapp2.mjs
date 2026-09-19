#!/usr/bin/env node
/**
 * winapp2.ini → junk-rules-community.json 转换脚本
 *
 * 用法: node scripts/convert-winapp2.mjs
 *
 * 1. 从 GitHub 下载最新 winapp2.ini
 * 2. 解析 INI 格式
 * 3. 按路径关键词分类（junk / privacy / registry）
 * 4. 只保留 junk 类（缓存、临时文件、日志）
 * 5. 输出为 rules/junk-rules-community.json
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const WINAPP2_URLS = [
  "https://ghproxy.com/https://raw.githubusercontent.com/MoscaDotTo/Winapp2/master/Non-CCleaner/Winapp2.ini",
  "https://mirror.ghproxy.com/https://raw.githubusercontent.com/MoscaDotTo/Winapp2/master/Non-CCleaner/Winapp2.ini",
  "https://raw.gitmirror.com/MoscaDotTo/Winapp2/master/Non-CCleaner/Winapp2.ini",
  "https://raw.githubusercontent.com/MoscaDotTo/Winapp2/master/Non-CCleaner/Winapp2.ini",
];
const CACHE_PATH = resolve(PROJECT_ROOT, "scripts", ".winapp2-cache.ini");
const OUTPUT_JUNK    = resolve(PROJECT_ROOT, "rules", "junk-rules-community.json");
const OUTPUT_PRIVACY = resolve(PROJECT_ROOT, "rules", "privacy-rules-community.json");
const OUTPUT_REG     = resolve(PROJECT_ROOT, "rules", "registry-rules-community.json");

// ---------------------------------------------------------------------------
// Download / cache
// ---------------------------------------------------------------------------

async function fetchWinapp2() {
  if (existsSync(CACHE_PATH)) {
    const stat = await import("node:fs/promises").then((m) => m.stat(CACHE_PATH));
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours < 24) {
      console.log("[info] Using cached winapp2.ini (age: %.1f hours)", ageHours);
      return readFileSync(CACHE_PATH, "utf-8");
    }
  }
  for (const url of WINAPP2_URLS) {
    try {
      console.log("[info] Trying: %s", url.slice(0, 60) + "...");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        console.log("[warn] HTTP %d, trying next...", res.status);
        continue;
      }
      const text = await res.text();
      writeFileSync(CACHE_PATH, text, "utf-8");
      console.log("[info] Downloaded %.1f KB from %s", text.length / 1024, new URL(url).host);
      return text;
    } catch (err) {
      console.log("[warn] %s — trying next mirror...", err.cause?.code || err.message);
    }
  }
  throw new Error("All download mirrors failed. Place winapp2.ini manually at: " + CACHE_PATH);
}

// ---------------------------------------------------------------------------
// Parse winapp2.ini
// ---------------------------------------------------------------------------

/**
 * Parse winapp2.ini into entries.
 * Each entry: { name, detect[], fileKeys[], regKeys[], section, warning }
 */
function parseWinapp2(text) {
  const entries = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;

    // Section header: [AppName *]
    const headerMatch = line.match(/^\[(.+)\]$/);
    if (headerMatch) {
      if (current) entries.push(current);
      current = {
        name: headerMatch[1].replace(/\s*\*\s*$/, "").trim(),
        detect: [],
        fileKeys: [],
        regKeys: [],
        section: "",
        warning: "",
      };
      continue;
    }

    if (!current) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const value = line.slice(eqIdx + 1).trim();

    if (key === "section" || key === "langsecref") {
      current.section = value;
    } else if (key.startsWith("detect") && !key.startsWith("detectos")) {
      current.detect.push(value);
    } else if (key.startsWith("filekey")) {
      current.fileKeys.push(value);
    } else if (key.startsWith("regkey")) {
      current.regKeys.push(value);
    } else if (key === "warning") {
      current.warning = value;
    }
  }
  if (current) entries.push(current);
  return entries;
}

// ---------------------------------------------------------------------------
// Classify entries
// ---------------------------------------------------------------------------

const JUNK_PATH_KEYWORDS = [
  "cache", "caches", "temp", "tmp", "logs", "log",
  "crashdumps", "crash", "gpucache", "code cache",
  "shader", "blob_storage", "databases", "service worker",
  "thumbnails", "thumbs", "prefetch", "recent",
  "inetcache", "webcache", "officefilecache",
  "update", "installer", "patch",
];

const PRIVACY_PATH_KEYWORDS = [
  "history", "cookies", "login data", "passwords",
  "sessions", "form history", "places.sqlite",
  "web data", "bookmarks", "signons",
];

function classifyFileKey(fileKey) {
  const lower = fileKey.toLowerCase();
  if (PRIVACY_PATH_KEYWORDS.some((kw) => lower.includes(kw))) return "privacy";
  if (JUNK_PATH_KEYWORDS.some((kw) => lower.includes(kw))) return "junk";
  // Default: if path contains common junk patterns
  if (/\|?\*\.\*\|?/i.test(fileKey)) return "junk"; // wildcard deletion = likely cache
  return "junk"; // default to junk for file cleaners
}

function classifyEntry(entry) {
  // If it only has regKeys, it's registry
  if (entry.fileKeys.length === 0 && entry.regKeys.length > 0) return "registry";
  // Classify by file keys
  const classifications = entry.fileKeys.map(classifyFileKey);
  if (classifications.includes("privacy")) return "privacy";
  return "junk";
}

// ---------------------------------------------------------------------------
// Convert FileKey to our path format
// ---------------------------------------------------------------------------

/**
 * FileKey format: path|pattern|flags
 * Example: %AppData%\discord\Cache|*.*|RECURSE
 * We extract just the directory path.
 */
const DANGEROUS_EXACT_PATHS = new Set([
  "%systemroot%", "%windir%", "%systemdrive%", "%systemdrive%\\",
  "%programfiles%", "%programfiles(x86)%", "%programdata%",
  "%localappdata%", "%appdata%", "%userprofile%", "%temp%",
]);

const WIN_SYSTEM_SUBDIRS = new Set([
  "system32", "syswow64", "winsxs", "servicing", "assembly",
  "inf", "drivers", "config", "spool", "tasks", "logs",
  "prefetch", "installer", "temp", "debug", "diagnostics"
]);

function pathDepthOk(rawPath) {
  const lower = rawPath.toLowerCase().replace(/[/\\]+$/, "").trim();
  if (DANGEROUS_EXACT_PATHS.has(lower)) return false;
  const isWinRoot = /%systemroot%|%windir%/.test(lower);
  const expanded = lower
    .replace(/%systemroot%/g, "c:\\windows").replace(/%windir%/g, "c:\\windows")
    .replace(/%systemdrive%/g, "c:").replace(/%programfiles(\(x86\))?%/g, "c:\\pf")
    .replace(/%programdata%/g, "c:\\programdata").replace(/%localappdata%/g, "c:\\la")
    .replace(/%appdata%/g, "c:\\ar").replace(/%userprofile%/g, "c:\\up")
    .replace(/%temp%/g, "c:\\tmp");
  const segments = expanded.split(/[/\\]/).filter(Boolean);
  if (isWinRoot) return segments.length >= 4;
  if (isWinRoot && segments[2] && WIN_SYSTEM_SUBDIRS.has(segments[2]) && segments.length < 4) return false;
  return segments.length > 2;
}

function fileKeyToPath(fileKey) {
  const parts = fileKey.split("|");
  const rawPath = parts[0].trim();
  if (!rawPath) return null;
  if (!pathDepthOk(rawPath)) return null;
  // Normalize env var casing
  return rawPath
    .replace(/%localappdata%/gi, "%LOCALAPPDATA%")
    .replace(/%appdata%/gi, "%APPDATA%")
    .replace(/%temp%/gi, "%TEMP%")
    .replace(/%systemroot%/gi, "%SystemRoot%")
    .replace(/%systemdrive%/gi, "%SystemDrive%")
    .replace(/%programfiles%/gi, "%ProgramFiles%")
    .replace(/%programdata%/gi, "%ProgramData%")
    .replace(/%userprofile%/gi, "%USERPROFILE%")
    .replace(/%windir%/gi, "%SystemRoot%");
}

function guessSafeLevel(entry) {
  if (entry.warning) return "caution";
  const lower = entry.fileKeys.join(" ").toLowerCase();
  if (lower.includes("cache") || lower.includes("temp") || lower.includes("tmp")) return "safe";
  if (lower.includes("log")) return "safe";
  return "caution";
}

function guessCategory(entry) {
  const lower = (entry.fileKeys.join(" ") + " " + entry.name).toLowerCase();
  if (lower.includes("browser") || lower.includes("chrome") || lower.includes("firefox") || lower.includes("edge")) return "browser";
  if (lower.includes("update") || lower.includes("installer") || lower.includes("patch")) return "update_residual";
  if (lower.includes("log") || lower.includes("crash")) return "logs";
  if (lower.includes("temp") || lower.includes("tmp")) return "temp_files";
  if (lower.includes("npm") || lower.includes("yarn") || lower.includes("pip") || lower.includes("gradle") || lower.includes("cargo")) return "dev_cache";
  return "app_cache";
}

function guessPrivacyCategory(entry) {
  const lower = (entry.fileKeys.join(" ") + " " + entry.name).toLowerCase();
  if (lower.includes("chrome") || lower.includes("firefox") || lower.includes("edge") ||
      lower.includes("ie") || lower.includes("internet explorer") || lower.includes("browser")) return "browser_privacy";
  if (lower.includes("recent") || lower.includes("mru") || lower.includes("clipboard") ||
      lower.includes("history") || lower.includes("run") || lower.includes("search")) return "system_privacy";
  return "software_privacy";
}

function guessRegCategory(entry) {
  const lower = entry.name.toLowerCase();
  if (lower.includes("startup") || lower.includes("autorun") || lower.includes("run")) return "startup";
  if (lower.includes("mru") || lower.includes("recent") || lower.includes("history")) return "mru";
  return "registry_residual";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function convertEntries(entries, categoryFn, defaultDesc) {
  const rules = [];
  const seenIds = new Set();
  for (const entry of entries) {
    const paths = entry.fileKeys
      .map(fileKeyToPath)
      .filter((p) => p !== null && p.length > 0);
    const regKeys = entry.regKeys.filter((k) => k && k.length > 0);
    if (paths.length === 0 && regKeys.length === 0) continue;
    const uniquePaths = [...new Set(paths)];
    let id = "community-" + entry.name
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (seenIds.has(id)) id += `-${seenIds.size}`;
    seenIds.add(id);
    const detectPath = entry.detect.length > 0
      ? fileKeyToPath(entry.detect[0]) || undefined : undefined;
    const rule = {
      id,
      name: entry.name,
      category: categoryFn(entry),
      paths: uniquePaths,
      detectPath,
      safeLevel: guessSafeLevel(entry),
      description: entry.warning || `${entry.name} ${defaultDesc}`,
      builtin: false,
      enabled: true,
      source: "community",
    };
    if (regKeys.length > 0) rule.regKeys = regKeys;
    rules.push(rule);
  }
  return rules;
}

function writeOutput(outputPath, description, rules) {
  const output = {
    version: "community-1.0.0",
    updatedAt: new Date().toISOString().slice(0, 10),
    source: "https://github.com/MoscaDotTo/Winapp2",
    description,
    rules,
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.log("[done] %s → %d rules (%.1f KB)",
    outputPath.split(/[\\/]/).pop(), rules.length, JSON.stringify(output).length / 1024);
}

async function main() {
  const text = await fetchWinapp2();
  const entries = parseWinapp2(text);
  console.log("[info] Parsed %d entries from winapp2.ini", entries.length);

  const junkEntries     = entries.filter((e) => classifyEntry(e) === "junk");
  const privacyEntries  = entries.filter((e) => classifyEntry(e) === "privacy");
  const registryEntries = entries.filter((e) => classifyEntry(e) === "registry");

  console.log("[info] Classified: %d junk, %d privacy, %d registry",
    junkEntries.length, privacyEntries.length, registryEntries.length);

  const junkRules     = convertEntries(junkEntries,     guessCategory,         "缓存与临时文件");
  const privacyRules  = convertEntries(privacyEntries,  guessPrivacyCategory,  "使用痕迹与隐私数据");
  const registryRules = convertEntries(registryEntries, guessRegCategory,      "注册表残留");

  writeOutput(OUTPUT_JUNK,    "Auto-converted junk rules from winapp2.ini",     junkRules);
  writeOutput(OUTPUT_PRIVACY, "Auto-converted privacy rules from winapp2.ini",  privacyRules);
  writeOutput(OUTPUT_REG,     "Auto-converted registry rules from winapp2.ini", registryRules);
}

main().catch((err) => {
  console.error("[error]", err);
  process.exit(1);
});
