import { app, ipcMain, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { detectJunk } from "../junk/detector";
import { buildCleanupPlan, buildCleanupPlanFromItems, executeCleanupPlanWithProgress } from "../cleanup/executor";
import { createSystemRestorePoint } from "../cleanup/restore-point";
import { findLockers, shutdownLockers } from "../cleanup/restart-manager";
import { unlink } from "node:fs/promises";
import type { CleanupPlan, CleanupProgress } from "../../shared/types";
import type { RawJunkRule } from "../junk/types";
import type { IpcContext } from "./context";

const execFileAsync = promisify(execFile);

const iconCache = new Map<string, string>();

// ── Local icon pack (resources/app-icons) ────────────────────────────────────
let localIconManifest: Record<string, string> | null = null; // slug → displayName
let localIconSlugIndex: Map<string, string> | null = null;  // lowerLabel → slug

function getLocalIconDir(): string {
  return resolve(app.getAppPath(), "resources", "app-icons");
}

function loadLocalIconManifest(): void {
  if (localIconManifest) return;
  try {
    const manifestPath = resolve(getLocalIconDir(), "manifest.json");
    if (!existsSync(manifestPath)) { localIconManifest = {}; localIconSlugIndex = new Map(); return; }
    localIconManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, string>;
    localIconSlugIndex = new Map();
    for (const [slug, displayName] of Object.entries(localIconManifest)) {
      localIconSlugIndex.set(displayName.toLowerCase(), slug);
      // Also index the slug itself as a key
      localIconSlugIndex.set(slug.replace(/-/g, " "), slug);
    }
  } catch {
    localIconManifest = {};
    localIconSlugIndex = new Map();
  }
}

function findLocalSlug(lbl: string): string | null {
  if (!localIconSlugIndex) return null;
  // 1. Exact match
  let slug = localIconSlugIndex.get(lbl) ?? null;
  if (slug) return slug;
  // 2. Partial match: index key is a substring of label or vice versa
  for (const [key, s] of localIconSlugIndex) {
    if (key.length >= 2 && (lbl.includes(key) || key.includes(lbl))) {
      return s;
    }
  }
  // 3. Prefix fallback: strip last word/segment and retry
  //    e.g. "qq游戏大厅" → "qq游戏" → "qq"
  const parts = lbl.split(/[\s\-_·]+/);
  for (let i = parts.length - 1; i >= 1; i--) {
    const shorter = parts.slice(0, i).join("");
    const s = localIconSlugIndex.get(shorter) ?? null;
    if (s) return s;
    for (const [key, sv] of localIconSlugIndex) {
      if (key.length >= 2 && shorter.includes(key)) return sv;
    }
  }
  return null;
}

function getLocalIconDataUrl(label: string): string | null {
  loadLocalIconManifest();
  if (!localIconSlugIndex || !localIconManifest) return null;
  const lbl = label.toLowerCase().trim();
  const slug = findLocalSlug(lbl);
  if (!slug) return null;
  const pngPath = resolve(getLocalIconDir(), `${slug}.png`);
  if (!existsSync(pngPath)) return null;
  try {
    const buf = readFileSync(pngPath);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

interface RegistryApp {
  DisplayName: string;
  DisplayIcon?: string;
  InstallLocation?: string;
}

let registryAppsCache: Map<string, RegistryApp> | null = null;
let registryAppsPromise: Promise<Map<string, RegistryApp>> | null = null;

async function getRegistryApps(): Promise<Map<string, RegistryApp>> {
  if (registryAppsCache) return registryAppsCache;
  if (!registryAppsPromise) {
    registryAppsPromise = (async () => {
      const map = new Map<string, RegistryApp>();
      // Use native reg.exe — no PowerShell startup overhead, 3-5x faster
      const REG_KEYS = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      ];
      const addEntry = (entry: RegistryApp) => {
        if (!entry.DisplayName) return;
        const key = entry.DisplayName.toLowerCase();
        if (!map.has(key)) map.set(key, entry);
        // Also index by last segment of InstallLocation (e.g. "douyin" for 抖音)
        if (entry.InstallLocation) {
          const seg = entry.InstallLocation.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase();
          if (seg && seg.length >= 3 && !map.has(seg)) map.set(seg, entry);
        }
      };
      try {
        // Fast path: PowerShell with longer timeout gives us structured JSON
        const ps = [
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
          "$p = @(",
          "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
          ");",
          "Get-ItemProperty $p -ErrorAction SilentlyContinue |",
          "  Where-Object { $_.DisplayName } |",
          "  Select-Object DisplayName, DisplayIcon, InstallLocation |",
          "  ConvertTo-Json -Compress",
        ].join(" ");
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps,
        ], { timeout: 15000 });
        const raw: RegistryApp[] = JSON.parse(stdout.trim());
        for (const entry of raw) addEntry(entry);
        registryAppsCache = map;
        return map;
      } catch {
        // PowerShell failed/timed out — fall back to reg.exe line-by-line parsing
        try {
          for (const regKey of REG_KEYS) {
            try {
              const { stdout } = await execFileAsync("reg.exe", [
                "query", regKey, "/s", "/v", "DisplayName",
              ], { timeout: 10000, encoding: "buffer" });
              // reg.exe outputs in system codepage; decode with latin1 and re-encode
              const text = stdout.toString("utf8");
              let current: Partial<RegistryApp> = {};
              for (const line of text.split(/\r?\n/)) {
                const nameMatch = line.match(/^\s+DisplayName\s+REG_SZ\s+(.+)$/);
                if (nameMatch) { current.DisplayName = nameMatch[1].trim(); continue; }
                const iconMatch = line.match(/^\s+DisplayIcon\s+REG_SZ\s+(.+)$/);
                if (iconMatch) { current.DisplayIcon = iconMatch[1].trim(); continue; }
                const locMatch = line.match(/^\s+InstallLocation\s+REG_SZ\s+(.+)$/);
                if (locMatch) { current.InstallLocation = locMatch[1].trim(); continue; }
                if (line.trim() === "" && current.DisplayName) {
                  addEntry(current as RegistryApp);
                  current = {};
                }
              }
              if (current.DisplayName) addEntry(current as RegistryApp);
            } catch { /* skip this hive */ }
          }
        } catch { /* ignore */ }
        if (map.size > 0) {
          registryAppsCache = map;
          return map;
        }
        // Complete failure — allow retry next call
        registryAppsPromise = null;
        return new Map();
      }
    })();
  }
  return registryAppsPromise;
}

function scoreMatch(query: string, candidate: string): number {
  if (query === candidate) return 100;
  if (candidate.startsWith(query + " ") || candidate.startsWith(query + "_")) return 90;
  if (candidate === query) return 100;
  const queryWords = query.split(/\s+/);
  const candWords = candidate.split(/\s+/);
  const matched = queryWords.filter((w) => candWords.some((c) => c === w || c.startsWith(w)));
  if (matched.length === queryWords.length) return 70;
  if (matched.length > 0) return 30 + (matched.length / queryWords.length) * 30;
  return 0;
}

function findClosestRegistryApp(name: string, apps: Map<string, RegistryApp>): RegistryApp | null {
  const lower = name.toLowerCase().trim();
  if (apps.has(lower)) return apps.get(lower)!;
  let best: RegistryApp | null = null;
  let bestScore = 0;
  for (const [key, val] of apps) {
    const score = scoreMatch(lower, key);
    if (score > bestScore && score >= 70) {
      bestScore = score;
      best = val;
    }
  }
  return best;
}

function resolveIconPath(displayIcon: string): string {
  return displayIcon.replace(/,\s*\d+\s*$/, "").replace(/^["']|["']$/g, "").trim();
}

const SKIP_EXE_RE = /^(uninst|unins|uninstall|setup|install|update|updater|helper|crash|crashreporter|crashpad|repair|launcher.?stub|redist|vcredist|dotnet|dxsetup|au3|elevate)/i;

function findExeInDir(dir: string, preferName?: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir);
    const exes = entries.filter((f) => /\.exe$/i.test(f));
    if (exes.length === 0) return null;
    // Filter out known utility EXEs
    const main = exes.filter((f) => !SKIP_EXE_RE.test(f.replace(/\.exe$/i, "")));
    const pool = main.length > 0 ? main : exes;
    // 1. Prefer EXE whose stem matches preferName
    if (preferName) {
      const pref = preferName.toLowerCase().replace(/\s+/g, "");
      const hit = pool.find((f) => {
        const stem = f.replace(/\.exe$/i, "").toLowerCase().replace(/\s+/g, "");
        return stem.includes(pref) || pref.includes(stem);
      });
      if (hit) return resolve(dir, hit);
    }
    // 2. Largest EXE (main apps tend to be biggest)
    if (pool.length > 1) {
      const sized = pool.map((f) => { try { return { f, s: statSync(resolve(dir, f)).size }; } catch { return { f, s: 0 }; } });
      sized.sort((a, b) => b.s - a.s);
      return resolve(dir, sized[0].f);
    }
    return resolve(dir, pool[0]);
  } catch { return null; }
}

const GENERIC_PARENT_DIRS = new Set([
  "programs", "microsoft", "windows", "common files", "windowsapps",
  "packages", "local", "roaming", "appdata", "programdata"
]);

function extractSoftwareRootFromPath(itemPath: string): string | null {
  const normalized = itemPath.replace(/\//g, "\\");
  const patterns = [
    /(.+\\AppData\\Local\\Programs\\[^\\]+)/i,
    /(.+\\AppData\\(?:Local|Roaming)\\[^\\]+)/i,
    /(.+\\ProgramData\\[^\\]+)/i,
    /(.+\\Program Files(?: \(x86\))?\\[^\\]+)/i
  ];
  for (const p of patterns) {
    const m = normalized.match(p);
    if (!m?.[1]) continue;
    const root = m[1];
    const dirName = root.split("\\").pop()?.toLowerCase() ?? "";
    if (GENERIC_PARENT_DIRS.has(dirName)) continue;
    if (existsSync(root)) return root;
  }
  return null;
}

async function getIconDataUrl(filePath: string): Promise<string | null> {
  try {
    if (/\.ico$/i.test(filePath)) {
      // nativeImage can read .ico files directly; app.getFileIcon on .ico returns file-type icon
      const img = nativeImage.createFromPath(filePath);
      if (!img.isEmpty()) return img.toDataURL();
      return null;
    }
    const icon = await app.getFileIcon(filePath, { size: "normal" });
    return icon.toDataURL();
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseBudget(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value <= 0) return Infinity;
  return clamp(value, min, max);
}

let lastJunkScanResult: Awaited<ReturnType<typeof detectJunk>> | null = null;

export function registerJunkIpc(ctx: IpcContext): void {
  ipcMain.handle("junk:scan", async (_event, args?: {
    timeoutMs?: number;
    maxFilesPerTarget?: number;
    maxMatchesPerPathPattern?: number;
  }) => {
    const timeoutInput = Number(args?.timeoutMs);
    const maxFilesInput = Number(args?.maxFilesPerTarget);
    const maxMatchesInput = Number(args?.maxMatchesPerPathPattern);
    const timeoutMs = Number.isFinite(timeoutInput)
      ? (timeoutInput <= 0 ? Infinity : Math.max(1200, timeoutInput))
      : Infinity;
    const maxFilesPerTarget = parseBudget(maxFilesInput, 25000, 2000, 80000);
    const maxMatchesPerPathPattern = parseBudget(maxMatchesInput, 1200, 100, 5000);
    const result = await detectJunk(ctx.getActiveRuleFilePath(), {
      timeoutMs,
      maxFilesPerTarget,
      maxMatchesPerPathPattern,
      customRuleFilePath: ctx.getCustomRuleFilePath(),
      communityRuleFilePath: ctx.getCommunityRuleFilePath()
    });
    lastJunkScanResult = result;
    return result;
  });

  ipcMain.handle("rules:get-custom", async () => ctx.loadCustomRules());
  ipcMain.handle("rules:create-custom", async (_event, args?: { rule?: RawJunkRule }) => {
    const input = args?.rule;
    if (!input) {
      throw new Error("Missing custom rule");
    }
    const rules = await ctx.loadCustomRules();
    const fallbackId = `custom-rule-${Date.now()}`;
    const nextRule = ctx.sanitizeCustomRule(input, fallbackId);
    if (!nextRule.paths || nextRule.paths.length === 0) {
      throw new Error("规则路径不能为空");
    }
    const duplicated = rules.some((rule) => rule.id === nextRule.id);
    if (duplicated) {
      throw new Error("规则 ID 已存在");
    }
    rules.unshift(nextRule);
    await ctx.saveCustomRules(rules);
    const db = ctx.getDbState();
    db?.addActivity("rules_updated", `新增自定义规则：${nextRule.name}`, { id: nextRule.id });
    return rules;
  });
  ipcMain.handle("rules:update-custom", async (_event, args?: { id?: string; rule?: RawJunkRule }) => {
    const id = args?.id?.trim();
    if (!id || !args?.rule) {
      throw new Error("Missing rule payload");
    }
    const rules = await ctx.loadCustomRules();
    const index = rules.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new Error("规则不存在");
    }
    const merged = ctx.sanitizeCustomRule({ ...rules[index], ...args.rule, id }, id);
    if (!merged.paths || merged.paths.length === 0) {
      throw new Error("规则路径不能为空");
    }
    rules[index] = merged;
    await ctx.saveCustomRules(rules);
    const db = ctx.getDbState();
    db?.addActivity("rules_updated", `更新自定义规则：${merged.name}`, { id: merged.id });
    return rules;
  });
  ipcMain.handle("rules:delete-custom", async (_event, args?: { id?: string }) => {
    const id = args?.id?.trim();
    if (!id) {
      throw new Error("Missing rule id");
    }
    const rules = await ctx.loadCustomRules();
    const next = rules.filter((rule) => rule.id !== id);
    await ctx.saveCustomRules(next);
    const db = ctx.getDbState();
    db?.addActivity("rules_updated", `删除自定义规则：${id}`, { id });
    return next;
  });
  ipcMain.handle("rules:import-custom", async (_event, args?: { rules?: RawJunkRule[] }) => {
    const incoming = Array.isArray(args?.rules) ? args?.rules ?? [] : [];
    const sanitized = incoming
      .map((rule, index) => ctx.sanitizeCustomRule(rule, `custom-import-${Date.now()}-${index + 1}`))
      .filter((rule) => rule.paths && rule.paths.length > 0);
    await ctx.saveCustomRules(sanitized);
    const db = ctx.getDbState();
    db?.addActivity("rules_updated", `导入自定义规则：${sanitized.length} 条`, { count: sanitized.length });
    return sanitized;
  });
  ipcMain.handle("rules:update-now", async () => ctx.updateRuleLibraryFromRemote(true));

  ipcMain.handle("cleanup:preview", async (_event, args?: {
    selectedPaths?: string[];
    selectedItems?: Array<{ path: string; safeLevel: string; ruleName: string; category: string }>;
    includeDanger?: boolean;
    maxTargets?: number;
  }) => {
    // Fast path: frontend passes already-scanned items — no re-scan needed
    if (args?.selectedItems && args.selectedItems.length > 0) {
      return buildCleanupPlanFromItems(args.selectedItems as Parameters<typeof buildCleanupPlanFromItems>[0]);
    }
    // Fallback: use cached last scan result or do a fresh scan
    const junkResult = lastJunkScanResult ?? await detectJunk(ctx.getActiveRuleFilePath(), {
      timeoutMs: Infinity,
      maxFilesPerTarget: 25000,
      customRuleFilePath: ctx.getCustomRuleFilePath(),
      communityRuleFilePath: ctx.getCommunityRuleFilePath()
    });
    return buildCleanupPlan(junkResult, {
      includeDanger: args?.includeDanger ?? false,
      selectedPaths: args?.selectedPaths,
      maxTargets: args?.maxTargets ?? Infinity,
      timeoutMs: 30000
    });
  });
  ipcMain.handle("cleanup:execute", async (_event, args?: { plan?: CleanupPlan }) => {
    const plan = args?.plan;
    if (!plan) {
      throw new Error("Missing cleanup plan");
    }
    const db = ctx.getDbState();
    const restoreEnabled = db?.getSetting<boolean>("cleanup.createRestorePoint") ?? true;
    let restorePoint: Awaited<ReturnType<typeof createSystemRestorePoint>> | null = null;
    if (restoreEnabled) {
      restorePoint = await createSystemRestorePoint();
      if (!restorePoint.created) {
        db?.addActivity(
          "cleanup_restore_point_warn",
          "系统还原点创建失败，已继续执行清理",
          restorePoint
        );
      }
    }

    const report = await executeCleanupPlanWithProgress(plan, (progress: CleanupProgress) => {
      _event.sender.send("cleanup:progress", progress);
    });
    db?.execute(
      "INSERT INTO cleanup_logs (executed_at, operation_type, files_deleted, bytes_freed, files_failed, details) VALUES (?, ?, ?, ?, ?, ?)",
      [
        new Date().toISOString(),
        "manual",
        report.deletedCount,
        report.bytesFreed,
        report.failedCount,
        JSON.stringify({ failures: report.failures.slice(0, 200), restorePoint })
      ]
    );
    db?.addActivity(
      "cleanup_complete",
      `清理完成：删除 ${report.deletedCount} 项，释放 ${Math.round(report.bytesFreed / 1024 / 1024)} MB`,
      report
    );
    return report;
  });
  ipcMain.handle("cleanup:find-lockers", async (_event, args?: { paths?: string[] }) => {
    const paths = (args?.paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
    return findLockers(paths);
  });

  ipcMain.handle("cleanup:close-and-retry", async (_event, args?: { paths?: string[] }) => {
    const paths = (args?.paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length === 0) return { deleted: [], failed: [] };
    await shutdownLockers(paths, true);
    // Brief pause for processes to fully release handles
    await new Promise((r) => setTimeout(r, 800));
    const deleted: string[] = [];
    const failed: string[] = [];
    await Promise.all(paths.map(async (p) => {
      try {
        await unlink(p);
        deleted.push(p);
      } catch {
        failed.push(p);
      }
    }));
    return { deleted, failed };
  });

  ipcMain.handle("cleanup:get-logs", (_event, args?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(200, args?.limit ?? 10));
    const db = ctx.getDbState();
    const rows = db?.queryAll<{
      id: number;
      timestamp: string;
      action: string;
      summary: string;
      details: string | null;
    }>(
      "SELECT id, timestamp, action, summary, details FROM activity_logs WHERE action LIKE 'cleanup%' ORDER BY timestamp DESC LIMIT ?",
      [limit]
    ) ?? [];
    return rows.map((row) => {
      let meta: Record<string, unknown> = {};
      try { if (row.details) meta = JSON.parse(row.details) as Record<string, unknown>; } catch { /* ok */ }
      return {
        id: row.id,
        executedAt: row.timestamp,
        operationType: row.action.replace("cleanup:", "") || "manual",
        filesDeleted: (meta.deletedCount as number | undefined) ?? 0,
        bytesFreed: (meta.bytesFreed as number | undefined) ?? 0,
        filesFailed: (meta.failedCount as number | undefined) ?? 0,
        details: meta
      };
    });
  });

  ipcMain.handle("junk:preload-registry", async () => {
    void getRegistryApps();
    return true;
  });

  ipcMain.handle("junk:get-icon", async (_event, args?: { itemPath?: string; label?: string; detectPath?: string }) => {
    const cacheKey = args?.label || args?.itemPath || args?.detectPath || "";
    if (!cacheKey) return null;
    if (iconCache.has(cacheKey)) return iconCache.get(cacheKey) || null;

    // 0. Local icon pack (fastest — pre-extracted PNGs bundled with the app)
    if (args?.label) {
      const localUrl = getLocalIconDataUrl(args.label);
      if (localUrl) {
        iconCache.set(cacheKey, localUrl);
        return localUrl;
      }
    }

    let iconFilePath: string | null = null;

    // 1. Registry lookup by software name (most reliable — covers all install locations)
    if (args?.label) {
      const regApps = await getRegistryApps();
      const match = findClosestRegistryApp(args.label, regApps);
      if (match?.DisplayIcon) {
        const resolved = resolveIconPath(match.DisplayIcon);
        if (resolved && existsSync(resolved)) {
          if (/\.ico$/i.test(resolved)) {
            // .ico DisplayIcon: prefer an exe in the same directory (app icons > file-type icons)
            const sameDir = resolve(resolved, "..");
            const exeInSameDir = findExeInDir(sameDir, args.label);
            iconFilePath = exeInSameDir ?? resolved; // fall back to the .ico itself
          } else {
            iconFilePath = resolved;
          }
        }
      }
      if (!iconFilePath && match?.InstallLocation && existsSync(match.InstallLocation)) {
        const exe = findExeInDir(match.InstallLocation, args.label);
        if (exe) iconFilePath = exe;
      }
    }

    // 1.5. detectPath — if the rule tells us where the app lives, use it
    if (!iconFilePath && args?.detectPath) {
      try {
        const dp = args.detectPath.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
        if (existsSync(dp)) {
          if (dp.toLowerCase().endsWith(".exe")) {
            iconFilePath = dp;
          } else {
            const exe = findExeInDir(dp);
            if (exe) iconFilePath = exe;
          }
        }
      } catch { /* ignore */ }
    }

    // 2. Walk up itemPath to find software root, then find exe inside it
    if (!iconFilePath && args?.itemPath) {
      const softwareRoot = extractSoftwareRootFromPath(args.itemPath);
      if (softwareRoot) {
        iconFilePath = findExeInDir(softwareRoot);
        if (!iconFilePath) {
          try {
            for (const sub of readdirSync(softwareRoot)) {
              const candidate = findExeInDir(resolve(softwareRoot, sub));
              if (candidate) { iconFilePath = candidate; break; }
            }
          } catch { /* ignore */ }
        }
      }
    }

    // 3. Search Program Files directories by label name (catches apps like JianyingPro, Epic, Quark)
    if (!iconFilePath && args?.label) {
      const label = args.label.toLowerCase().replace(/\s+/g, "");
      // Build search roots: standard env vars + common custom dirs on all drives
      const basePfDirs = [
        process.env["ProgramFiles"]?.replace(/^[A-Za-z]:/, "") ?? "\\Program Files",
        process.env["ProgramFiles(x86)"]?.replace(/^[A-Za-z]:/, "") ?? "\\Program Files (x86)",
        // Common Chinese custom install roots
        "\\软件", "\\程序", "\\游戏", "\\安装",
        // Common English custom roots
        "\\Programs", "\\Apps", "\\Applications", "\\Software", "\\Games",
        "\\Install", "\\Installed",
      ];
      const drives: string[] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        if (existsSync(root)) drives.push(letter);
      }
      const pfRoots: string[] = [
        ...drives.flatMap((d) => basePfDirs.map((dir) => `${d}:${dir}`)),
        process.env["LOCALAPPDATA"] ? `${process.env["LOCALAPPDATA"]}\\Programs` : null,
      ].filter(Boolean) as string[];
      for (const pfRoot of pfRoots) {
        try {
          const dirs = await readdir(pfRoot);
          for (const d of dirs) {
            const dNorm = d.toLowerCase().replace(/\s+/g, "");
            if (
              (dNorm.length >= 4 && (label.includes(dNorm) || dNorm.includes(label))) ||
              dNorm === label
            ) {
              const appDir = resolve(pfRoot, d);
              let candidate = findExeInDir(appDir, label);
              if (!candidate) {
                try {
                  const subs = await readdir(appDir);
                  for (const sub of subs) {
                    candidate = findExeInDir(resolve(appDir, sub), label);
                    if (candidate) break;
                  }
                } catch { /* ignore */ }
              }
              if (candidate) { iconFilePath = candidate; break; }
            }
          }
        } catch { /* ignore */ }
        if (iconFilePath) break;
      }
    }

    // 4. Fallback: try well-known system exe for common labels
    if (!iconFilePath && args?.label) {
      const sysExeFallbacks: Record<string, string> = {
        "Windows": "C:\\Windows\\explorer.exe",
        "回收站": "C:\\Windows\\explorer.exe",
        ".NET": "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\ngen.exe",
        ".Net程序": "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\ngen.exe",
        ".Net框架": "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\ngen.exe",
        "系统还原点": "C:\\Windows\\System32\\rstrui.exe",
        "系统更新": "C:\\Windows\\System32\\wuauclt.exe",
        "临时文件": "C:\\Windows\\explorer.exe",
        "日志文件": "C:\\Windows\\explorer.exe",
        "缓存文件": "C:\\Windows\\explorer.exe",
        "缩略图缓存": "C:\\Windows\\explorer.exe",
        "其它文件": "C:\\Windows\\explorer.exe",
        "系统安全中心": "C:\\Windows\\System32\\SecurityHealthSystray.exe",
        "系统诊断数据": "C:\\Windows\\System32\\perfmon.exe",
        "小型转储文件": "C:\\Windows\\explorer.exe",
        "内存转储文件": "C:\\Windows\\explorer.exe",
        "升级补丁备份": "C:\\Windows\\explorer.exe",
        "安装包残留文件": "C:\\Windows\\explorer.exe",
        "旧版系统文件": "C:\\Windows\\explorer.exe",
        "系统休眠文件": "C:\\Windows\\explorer.exe",
        "转移虚拟内存": "C:\\Windows\\explorer.exe",
        "NVIDIA": "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll",
      };
      for (const [keyword, exePath] of Object.entries(sysExeFallbacks)) {
        if (args.label.includes(keyword) && existsSync(exePath)) {
          iconFilePath = exePath;
          break;
        }
      }
    }

    if (!iconFilePath) {
      return null; // Don't cache failures — allow retry on next scan
    }
    const dataUrl = await getIconDataUrl(iconFilePath);
    if (dataUrl) {
      iconCache.set(cacheKey, dataUrl);
      // Persist to local PNG pack so next scan hits step 0 instantly
      if (args?.label) {
        try {
          const slug = args.label.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
          const pngPath = resolve(getLocalIconDir(), `${slug}.png`);
          if (!existsSync(pngPath)) {
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
            writeFileSync(pngPath, Buffer.from(base64, "base64"));
            // Update in-memory index
            loadLocalIconManifest();
            localIconSlugIndex?.set(args.label.toLowerCase(), slug);
            localIconManifest![slug] = args.label;
          }
        } catch { /* best-effort */ }
      }
    } else {
      iconCache.set(cacheKey, "");
    }
    return dataUrl ?? null;
  });

  ipcMain.handle("junk:list-path", (_event, args: { path: string }) => {
    const nodePath = require("node:path") as typeof import("node:path");
    const { statSync } = require("node:fs") as typeof import("node:fs");

    // Budget-based recursive size: max 2000 stat calls total, max depth 4
    const budget = { remaining: 2000 };
    function dirSize(dirPath: string, depth: number): number {
      if (depth <= 0 || budget.remaining <= 0) return 0;
      let total = 0;
      try {
        const children = readdirSync(dirPath, { withFileTypes: true });
        for (const child of children) {
          if (budget.remaining <= 0) break;
          const full = nodePath.join(dirPath, child.name);
          try {
            if (child.isFile()) {
              budget.remaining--;
              total += statSync(full).size;
            } else if (child.isDirectory()) {
              total += dirSize(full, depth - 1);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      return total;
    }

    try {
      const stat = statSync(args.path, { bigint: false });
      if (!stat.isDirectory()) {
        return { partial: false, entries: [{ name: nodePath.basename(args.path), size: stat.size, type: "file" as const }] };
      }
      const entries = readdirSync(args.path, { withFileTypes: true }).slice(0, 100);
      const result: Array<{ name: string; size: number; type: "file" | "dir"; count?: number }> = [];
      for (const entry of entries) {
        const full = nodePath.join(args.path, entry.name);
        try {
          if (entry.isDirectory()) {
            let count = 0;
            try { count = readdirSync(full).length; } catch { /* ok */ }
            const size = dirSize(full, 4);
            result.push({ name: entry.name, size, type: "dir", count });
          } else {
            budget.remaining--;
            result.push({ name: entry.name, size: statSync(full).size, type: "file" });
          }
        } catch { /* skip */ }
      }
      const partial = budget.remaining <= 0;
      return { partial, entries: result.sort((a, b) => b.size - a.size).slice(0, 50) };
    } catch {
      return { partial: false, entries: [] };
    }
  });
}
