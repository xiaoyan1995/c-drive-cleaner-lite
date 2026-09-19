import { existsSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { JunkGroup, JunkItem, JunkScanResult, SafeLevel } from "../../shared/types";
import { expandEnv, filenamePatternToRegex, loadRules, resolveRuleTargets } from "./rule-engine";

const DOWNLOAD_AGE_DAYS = 7;

const DOWNLOAD_EXT_MAP: Record<string, string> = {};
for (const ext of [".exe", ".msi", ".apk", ".appx", ".msix", ".pkg"]) DOWNLOAD_EXT_MAP[ext] = "应用程序";
for (const ext of [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".cab", ".iso"]) DOWNLOAD_EXT_MAP[ext] = "压缩文件";
for (const ext of [".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".rmvb", ".ts", ".mpg", ".mpeg"]) DOWNLOAD_EXT_MAP[ext] = "视频文件";
for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".heic", ".svg"]) DOWNLOAD_EXT_MAP[ext] = "图片文件";

async function scanDownloadsFolder(): Promise<JunkItem[]> {
  const downloadsPath = resolve(expandEnv("%USERPROFILE%"), "Downloads");
  if (!existsSync(downloadsPath)) return [];

  const cutoff = Date.now() - DOWNLOAD_AGE_DAYS * 24 * 60 * 60 * 1000;
  const items: JunkItem[] = [];

  let dir;
  try {
    dir = await opendir(downloadsPath);
  } catch {
    return [];
  }

  for await (const entry of dir) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = resolve(downloadsPath, entry.name);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (fileStat.mtimeMs > cutoff) continue;

    const ext = extname(entry.name).toLowerCase();
    const typeLabel = DOWNLOAD_EXT_MAP[ext];
    if (!typeLabel) continue;

    items.push({
      path: fullPath,
      size: fileStat.size,
      count: 1,
      ruleName: `${typeLabel} (${DOWNLOAD_AGE_DAYS}天以前)`,
      category: "downloads",
      safeLevel: "caution",
      description: `下载文件夹中 ${DOWNLOAD_AGE_DAYS} 天前的${typeLabel}，请确认不再需要后再删除。`
    });
  }

  return items;
}

interface DetectJunkOptions {
  timeoutMs?: number;
  maxFilesPerTarget?: number;
  maxMatchesPerPathPattern?: number;
  customRuleFilePath?: string;
  communityRuleFilePath?: string;
}

interface ScanBudget {
  startedAt: number;
  timeoutMs: number;
  maxFiles: number;
  scannedFiles: number;
}

const safeRank: Record<SafeLevel, number> = {
  safe: 0,
  caution: 1,
  danger: 2
};

function budgetExpired(budget: ScanBudget): boolean {
  if (Date.now() - budget.startedAt > budget.timeoutMs) {
    return true;
  }
  return budget.scannedFiles >= budget.maxFiles;
}

async function collectPathStats(targetPath: string, budget: ScanBudget, filenameMatcher?: RegExp): Promise<{ size: number; count: number }> {
  if (budgetExpired(budget)) {
    return { size: 0, count: 0 };
  }

  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    return { size: 0, count: 0 };
  }

  if (fileStat.isFile()) {
    budget.scannedFiles += 1;
    if (filenameMatcher && !filenameMatcher.test(basename(targetPath))) {
      return { size: 0, count: 0 };
    }
    return { size: fileStat.size, count: 1 };
  }

  if (!fileStat.isDirectory()) {
    return { size: 0, count: 0 };
  }

  let dir;
  try {
    dir = await opendir(targetPath);
  } catch {
    return { size: 0, count: 0 };
  }

  // Collect all non-symlink entries first, then stat them in parallel
  const entries: string[] = [];
  for await (const entry of dir) {
    if (entry.isSymbolicLink()) continue;
    entries.push(resolve(targetPath, entry.name));
  }

  if (budgetExpired(budget)) return { size: 0, count: 0 };

  const childResults = await Promise.all(
    entries.map(childPath => collectPathStats(childPath, budget, filenameMatcher))
  );

  let size = 0;
  let count = 0;
  for (const child of childResults) {
    size += child.size;
    count += child.count;
  }
  return { size, count };
}

function groupItems(items: JunkItem[]): JunkGroup[] {
  const grouped = new Map<JunkGroup["category"], JunkGroup>();
  for (const item of items) {
    const group = grouped.get(item.category) ?? {
      category: item.category,
      size: 0,
      count: 0,
      safeLevel: item.safeLevel,
      items: []
    };
    group.size += item.size;
    group.count += item.count ?? 0;
    if (safeRank[item.safeLevel] > safeRank[group.safeLevel]) {
      group.safeLevel = item.safeLevel;
    }
    group.items.push(item);
    grouped.set(item.category, group);
  }

  return [...grouped.values()].sort((a, b) => b.size - a.size);
}

function buildStats(groups: JunkGroup[]): NonNullable<JunkScanResult["stats"]> {
  let safeSize = 0;
  let cautionSize = 0;
  let dangerSize = 0;
  let safeCount = 0;
  let cautionCount = 0;
  let dangerCount = 0;

  for (const group of groups) {
    for (const item of group.items) {
      const count = item.count ?? 0;
      if (item.safeLevel === "safe") {
        safeSize += item.size;
        safeCount += count;
      } else if (item.safeLevel === "caution") {
        cautionSize += item.size;
        cautionCount += count;
      } else {
        dangerSize += item.size;
        dangerCount += count;
      }
    }
  }

  return {
    safeSize,
    cautionSize,
    dangerSize,
    safeCount,
    cautionCount,
    dangerCount,
    totalSize: safeSize + cautionSize + dangerSize,
    totalCount: safeCount + cautionCount + dangerCount
  };
}

export async function detectJunk(
  ruleFilePath = resolve(process.cwd(), "rules", "junk-rules.json"),
  options: DetectJunkOptions = {}
): Promise<JunkScanResult> {
  if (!existsSync(ruleFilePath)) {
    return {
      scannedAt: new Date().toISOString(),
      totalSize: 0,
      totalCount: 0,
      stats: {
        safeSize: 0,
        cautionSize: 0,
        dangerSize: 0,
        safeCount: 0,
        cautionCount: 0,
        dangerCount: 0,
        totalSize: 0,
        totalCount: 0
      },
      groups: []
    };
  }

  const ruleSet = loadRules(ruleFilePath, options.customRuleFilePath, options.communityRuleFilePath);
  const timeoutMs = options.timeoutMs ?? Infinity;
  const maxFiles = options.maxFilesPerTarget ?? 12000;
  const maxMatches = options.maxMatchesPerPathPattern ?? 800;

  // Scan a single rule and return its items
  async function scanRule(rule: (typeof ruleSet.merged)[number]): Promise<JunkItem[]> {
    if (rule.detectPath) {
      const expanded = expandEnv(rule.detectPath);
      if (!expanded || !existsSync(expanded)) return [];
    }

    const targets = await resolveRuleTargets(rule, { maxMatchesPerPathPattern: maxMatches, timeoutMs });
    if (targets.length === 0) return [];

    const filenameMatcher = rule.pattern ? filenamePatternToRegex(rule.pattern) : undefined;

    // All targets for this rule in parallel
    const targetResults = await Promise.all(
      targets.map(async (targetPath) => {
        const budget: ScanBudget = {
          startedAt: Date.now(),
          timeoutMs,
          maxFiles,
          scannedFiles: 0
        };
        const stats = await collectPathStats(targetPath, budget, filenameMatcher);
        if (stats.size <= 0 && stats.count <= 0) return null;
        const item: JunkItem = {
          path: targetPath,
          size: stats.size,
          count: stats.count,
          ruleName: rule.name,
          category: rule.category,
          safeLevel: rule.safeLevel,
          description: rule.description,
          detectPath: rule.detectPath
        };
        return item;
      })
    );

    return targetResults.filter((x): x is NonNullable<typeof x> => x !== null);
  }

  // Run all rules in parallel with a concurrency limit to avoid too many open file handles
  const RULE_CONCURRENCY = 24;
  const allRules = ruleSet.merged;
  const ruleItems: JunkItem[][] = new Array(allRules.length).fill(null);

  async function worker(idxRef: { v: number }): Promise<void> {
    while (true) {
      const i = idxRef.v++;
      if (i >= allRules.length) return;
      ruleItems[i] = await scanRule(allRules[i]);
    }
  }

  const idxRef = { v: 0 };
  await Promise.all(
    Array.from({ length: Math.min(RULE_CONCURRENCY, allRules.length) }, () => worker(idxRef))
  );

  const items: JunkItem[] = ruleItems.flat();
  const downloadItems = await scanDownloadsFolder();
  items.push(...downloadItems);

  const groups = groupItems(items);
  const stats = buildStats(groups);
  return {
    scannedAt: new Date().toISOString(),
    totalSize: stats.totalSize,
    totalCount: stats.totalCount,
    stats,
    groups
  };
}
