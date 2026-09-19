import { existsSync, readFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { JunkCategory, SafeLevel } from "../../shared/types";
import type { JunkRule, JunkRuleFile, LoadedRuleSet, RawJunkRule, RuleMatchOptions } from "./types";

const VALID_CATEGORIES = new Set<JunkCategory>([
  "system_cache",
  "browser",
  "app_cache",
  "dev_cache",
  "temp_files",
  "recycle_bin",
  "logs",
  "update_residual"
]);

const VALID_SAFE_LEVELS = new Set<SafeLevel>(["safe", "caution", "danger"]);

function nowSafeLevel(value: unknown): SafeLevel {
  if (typeof value === "string" && VALID_SAFE_LEVELS.has(value as SafeLevel)) {
    return value as SafeLevel;
  }
  return "safe";
}

function normalizeCategory(value: unknown): JunkCategory {
  if (typeof value === "string" && VALID_CATEGORIES.has(value as JunkCategory)) {
    return value as JunkCategory;
  }
  return "temp_files";
}

const DANGEROUS_ROOT_PATHS = new Set([
  "%systemroot%", "%windir%", "%systemdrive%", "%systemdrive%\\",
  "%programfiles%", "%programfiles(x86)%", "%programdata%",
  "%localappdata%", "%appdata%", "%userprofile%", "%temp%",
  "c:\\", "c:\\windows", "c:\\program files", "c:\\program files (x86)",
  "c:\\programdata", "c:\\users"
]);

const WINDOWS_SYSTEM_SUBDIRS = new Set([
  "system32", "syswow64", "winsxs", "servicing", "assembly",
  "inf", "drivers", "config", "spool", "tasks", "logs",
  "prefetch", "installer", "temp", "debug", "diagnostics"
]);

function isSafeRulePath(p: string): boolean {
  const lower = p.toLowerCase().replace(/[/\\]+$/, "").trim();
  if (DANGEROUS_ROOT_PATHS.has(lower)) return false;

  const isWindowsRoot = /%systemroot%|%windir%/.test(lower);
  const afterExpand = lower
    .replace(/%systemroot%/g, "c:\\windows")
    .replace(/%windir%/g, "c:\\windows")
    .replace(/%systemdrive%/g, "c:")
    .replace(/%programfiles\(x86\)%/g, "c:\\pf86")
    .replace(/%programfiles%/g, "c:\\pf")
    .replace(/%programdata%/g, "c:\\programdata")
    .replace(/%localappdata%/g, "c:\\users\\x\\appdata\\local")
    .replace(/%appdata%/g, "c:\\users\\x\\appdata\\roaming")
    .replace(/%userprofile%/g, "c:\\users\\x")
    .replace(/%temp%/g, "c:\\users\\x\\appdata\\local\\temp");

  const segments = afterExpand.split(/[\\/]/).filter(Boolean);

  if (isWindowsRoot) {
    if (segments.length < 4) return false;
    const immediateChild = segments[2];
    if (immediateChild && WINDOWS_SYSTEM_SUBDIRS.has(immediateChild) && segments.length < 4) return false;
  } else {
    if (segments.length <= 2) return false;
  }

  const immediateChild = segments[segments.length - 2] ?? "";
  if (isWindowsRoot && WINDOWS_SYSTEM_SUBDIRS.has(immediateChild) && segments.length === 3) return false;

  return true;
}

function normalizePaths(value: unknown, source?: "builtin" | "custom" | "community"): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => source === "community" ? isSafeRulePath(item) : true);
}

function normalizeRule(raw: RawJunkRule, source: "builtin" | "custom" | "community", index: number): JunkRule | null {
  const paths = normalizePaths(raw.paths, source);
  if (paths.length === 0) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `${source}-rule-${index}`;
  const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : id;
  const safeLevel = nowSafeLevel(raw.safeLevel ?? raw.safe_level);
  const description = typeof raw.description === "string" && raw.description.trim().length > 0
    ? raw.description.trim()
    : `${name} 匹配项`;
  const pattern = typeof raw.pattern === "string" && raw.pattern.trim().length > 0 ? raw.pattern.trim() : undefined;
  const detectPath = typeof raw.detectPath === "string" && raw.detectPath.trim().length > 0 ? raw.detectPath.trim() : undefined;
  const regKeys = Array.isArray(raw.regKeys) ? raw.regKeys.filter((k): k is string => typeof k === "string" && k.length > 0) : undefined;
  return {
    id,
    name,
    category: normalizeCategory(raw.category),
    paths,
    pattern,
    detectPath,
    safeLevel,
    description,
    builtin: raw.builtin ?? source === "builtin",
    enabled: raw.enabled !== false,
    source,
    ...(regKeys && regKeys.length > 0 ? { regKeys } : {})
  };
}

function loadRuleFile(path: string, source: "builtin" | "custom" | "community"): { file: JunkRuleFile; rules: JunkRule[] } {
  if (!existsSync(path)) {
    return { file: { rules: [] }, rules: [] };
  }
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as JunkRuleFile;
  const rules = (parsed.rules ?? [])
    .map((item, index) => normalizeRule(item, source, index))
    .filter((item): item is JunkRule => item !== null)
    .filter((item) => item.enabled);
  return { file: parsed, rules };
}

function mergeRules(builtin: JunkRule[], custom: JunkRule[]): JunkRule[] {
  const merged = new Map<string, JunkRule>();
  for (const rule of builtin) {
    merged.set(rule.id, rule);
  }
  for (const rule of custom) {
    merged.set(rule.id, rule);
  }
  return [...merged.values()];
}

function hasGlobChars(value: string): boolean {
  return /[*?]/.test(value);
}

function escapeRegex(source: string): string {
  return source.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  let regex = "^";
  const normalized = glob.replace(/\//g, "\\");
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^\\\\/]*";
      }
      continue;
    }
    if (ch === "?") {
      regex += "[^\\\\/]";
      continue;
    }
    if (ch === "\\" || ch === "/") {
      regex += "[\\\\/]";
      continue;
    }
    regex += escapeRegex(ch);
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function getGlobRoot(glob: string): string {
  const normalized = glob.replace(/\//g, "\\");
  const segments = normalized.split("\\");
  const rootParts: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 && rootParts.length === 0) {
      continue;
    }
    if (hasGlobChars(segment)) {
      break;
    }
    rootParts.push(segment);
  }
  if (rootParts.length === 0) {
    return dirname(resolve(glob));
  }
  let root = rootParts.join("\\");
  if (/^[a-zA-Z]:$/.test(root)) {
    root += "\\";
  }
  return root;
}

async function collectGlobMatches(glob: string, options: Required<RuleMatchOptions>): Promise<string[]> {
  const root = getGlobRoot(glob);
  if (!existsSync(root)) {
    return [];
  }
  const matcher = globToRegex(glob);
  const startedAt = Date.now();
  const matches: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (Date.now() - startedAt > options.timeoutMs) {
      break;
    }
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (matcher.test(current)) {
      matches.push(current);
      if (matches.length >= options.maxMatchesPerPathPattern) {
        break;
      }
    }

    let dir;
    try {
      dir = await opendir(current);
    } catch {
      continue;
    }

    for await (const entry of dir) {
      if (Date.now() - startedAt > options.timeoutMs) {
        break;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = resolve(current, entry.name);
      if (matcher.test(child)) {
        matches.push(child);
        if (matches.length >= options.maxMatchesPerPathPattern) {
          break;
        }
      }
      if (entry.isDirectory()) {
        queue.push(child);
      }
    }

    if (matches.length >= options.maxMatchesPerPathPattern) {
      break;
    }
  }

  return [...new Set(matches)];
}

export function expandEnv(input: string): string {
  return input.replace(/%([^%]+)%/g, (_match, key: string) => {
    const direct = process.env[key];
    if (direct !== undefined) {
      return direct;
    }
    return process.env[key.toUpperCase()] ?? "";
  });
}

export function loadRules(
  builtinRuleFilePath = resolve(process.cwd(), "rules", "junk-rules.json"),
  customRuleFilePath = resolve(process.cwd(), "rules", "custom-junk-rules.json"),
  communityRuleFilePath = resolve(process.cwd(), "rules", "junk-rules-community.json")
): LoadedRuleSet {
  const builtinLoaded = loadRuleFile(builtinRuleFilePath, "builtin");
  const customLoaded = loadRuleFile(customRuleFilePath, "custom");
  const communityLoaded = loadRuleFile(communityRuleFilePath, "community");
  const merged = mergeRules(builtinLoaded.rules, customLoaded.rules);
  // Community rules are appended (lower priority, won't override builtin/custom by id)
  const communityNew = communityLoaded.rules.filter((r) => !merged.some((m) => m.id === r.id));
  return {
    version: builtinLoaded.file.version,
    updatedAt: builtinLoaded.file.updatedAt,
    builtin: builtinLoaded.rules,
    custom: customLoaded.rules,
    merged: [...merged, ...communityNew]
  };
}

export function filenamePatternToRegex(pattern: string): RegExp {
  return globToRegex(basename(pattern).replace(/\//g, "\\"));
}

export async function resolveRuleTargets(
  rule: JunkRule,
  rawOptions: RuleMatchOptions = {}
): Promise<string[]> {
  const options: Required<RuleMatchOptions> = {
    maxMatchesPerPathPattern: rawOptions.maxMatchesPerPathPattern ?? 300,
    timeoutMs: rawOptions.timeoutMs ?? 1200
  };

  // Resolve all paths in parallel
  const results = await Promise.all(
    rule.paths.map(async (sourcePath) => {
      const expanded = expandEnv(sourcePath);
      if (!expanded) return [];
      if (!hasGlobChars(expanded)) {
        return existsSync(expanded) ? [resolve(expanded)] : [];
      }
      return collectGlobMatches(expanded, options);
    })
  );

  return [...new Set(results.flat())];
}

