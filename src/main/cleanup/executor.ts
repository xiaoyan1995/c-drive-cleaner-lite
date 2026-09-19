import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { opendir, stat, unlink } from "node:fs/promises";
import { resolve, normalize } from "node:path";
import { app } from "electron";

import type {
  CleanupFailure,
  CleanupPlan,
  CleanupProgress,
  CleanupReport,
  CleanupTarget,
  JunkItem,
  JunkScanResult,
  SafeLevel
} from "../../shared/types";

const execFileAsync = promisify(execFile);
const WINDOWS_UPDATE_SERVICES = ["wuauserv", "bits", "dosvc", "cryptsvc", "usosvc"] as const;

type ServiceStatus = "Running" | "Stopped" | "Other";

function isWindowsUpdateCachePath(filePath: string): boolean {
  const p = normalize(filePath).replace(/\//g, "\\").toLowerCase();
  return (
    p.includes("\\windows\\softwaredistribution\\")
    || p.includes("\\programdata\\microsoft\\windows\\deliveryoptimization\\")
  );
}

function shouldUseWindowsUpdateServiceGuard(plan: CleanupPlan): boolean {
  if (process.platform !== "win32") return false;
  return plan.targets.some((target) => isWindowsUpdateCachePath(target.path));
}

async function queryWindowsServiceStatuses(
  names: readonly string[]
): Promise<Record<string, ServiceStatus>> {
  const script = [
    `$names = @(${names.map((name) => `'${name}'`).join(",")})`,
    "$services = Get-Service -Name $names -ErrorAction SilentlyContinue | Select-Object Name, Status",
    "if ($null -eq $services) { '[]' } else { $services | ConvertTo-Json -Compress }"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15_000 }
    );
    const raw = stdout.trim();
    if (!raw || raw === "[]") return {};

    const parsed = JSON.parse(raw) as Array<{ Name?: string; Status?: string }> | { Name?: string; Status?: string };
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const statuses: Record<string, ServiceStatus> = {};
    for (const item of list) {
      const name = item.Name?.toLowerCase();
      if (!name) continue;
      const status = (item.Status ?? "").toLowerCase();
      if (status === "running") {
        statuses[name] = "Running";
      } else if (status === "stopped") {
        statuses[name] = "Stopped";
      } else {
        statuses[name] = "Other";
      }
    }
    return statuses;
  } catch {
    return {};
  }
}

async function stopWindowsServices(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const script = [
    `$targets = @(${names.map((name) => `'${name}'`).join(",")})`,
    "foreach ($name in $targets) {",
    "  try {",
    "    $svc = Get-Service -Name $name -ErrorAction Stop",
    "    if ($svc.Status -ne 'Stopped') {",
    "      Stop-Service -Name $name -Force -ErrorAction Stop",
    "      $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(25))",
    "    }",
    "  } catch { }",
    "}"
  ].join(" ");

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 45_000 }
  );
}

async function startWindowsServices(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const script = [
    `$targets = @(${names.map((name) => `'${name}'`).join(",")})`,
    "foreach ($name in $targets) {",
    "  try { Start-Service -Name $name -ErrorAction Stop } catch { }",
    "}"
  ].join(" ");

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 30_000 }
  );
}

async function prepareWindowsUpdateServiceGuard(plan: CleanupPlan): Promise<{ restore: () => Promise<void> }> {
  if (!shouldUseWindowsUpdateServiceGuard(plan)) {
    return { restore: async () => { /* noop */ } };
  }

  const statuses = await queryWindowsServiceStatuses(WINDOWS_UPDATE_SERVICES);
  const shouldStop = WINDOWS_UPDATE_SERVICES
    .map((name) => name.toLowerCase())
    .filter((name) => statuses[name] === "Running");

  try {
    await stopWindowsServices(shouldStop);
  } catch {
    // Best-effort guard: cleanup will still proceed and report per-file failures.
  }

  return {
    restore: async () => {
      try {
        await startWindowsServices(shouldStop);
      } catch {
        // Ignore restore errors; services are managed by Windows and may auto-recover.
      }
    }
  };
}

/** Try PowerShell Remove-Item -Force as fallback for EBUSY/EPERM locked files. */
async function forceUnlink(filePath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("not win32");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", `Remove-Item -LiteralPath '${filePath.replace(/'/g, "''")}' -Force -ErrorAction Stop`
  ], { timeout: 8000 });
}

interface PlanOptions {
  includeDanger?: boolean;
  selectedPaths?: string[];
  maxTargets?: number;
  timeoutMs?: number;
}

interface CollectBudget {
  startedAt: number;
  timeoutMs: number;
  maxTargets: number;
  collected: number;
}

function budgetExpired(budget: CollectBudget): boolean {
  if (Date.now() - budget.startedAt > budget.timeoutMs) {
    return true;
  }
  return budget.collected >= budget.maxTargets;
}

function mapFailureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "删除失败";
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EBUSY" || code === "EPERM") {
    return "文件被占用";
  }
  if (code === "EACCES") {
    return "权限不足";
  }
  if (code === "ENOENT") {
    return "文件不存在";
  }
  return error.message || "删除失败";
}

async function collectFilesFromPath(
  targetPath: string,
  safeLevel: SafeLevel,
  ruleName: string,
  category: CleanupTarget["category"],
  budget: CollectBudget
): Promise<CleanupTarget[]> {
  if (budgetExpired(budget)) {
    return [];
  }

  let targetStat;
  try {
    targetStat = await stat(targetPath);
  } catch {
    return [];
  }

  if (targetStat.isFile()) {
    budget.collected += 1;
    return [
      {
        path: resolve(targetPath),
        size: targetStat.size,
        safeLevel,
        ruleName,
        category
      }
    ];
  }

  if (!targetStat.isDirectory()) {
    return [];
  }

  const files: CleanupTarget[] = [];
  let dir;
  try {
    dir = await opendir(targetPath);
  } catch {
    return [];
  }

  for await (const entry of dir) {
    if (budgetExpired(budget)) {
      break;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const children = await collectFilesFromPath(
      resolve(targetPath, entry.name),
      safeLevel,
      ruleName,
      category,
      budget
    );
    files.push(...children);
  }

  return files;
}

function pickItems(junkResult: JunkScanResult, options: PlanOptions): JunkItem[] {
  const selectedSet = new Set((options.selectedPaths ?? []).map((path) => resolve(path)));
  return junkResult.groups
    .flatMap((group) => group.items)
    .filter((item) => {
      if (!options.includeDanger && item.safeLevel === "danger") {
        return false;
      }
      if (selectedSet.size === 0) {
        return true;
      }
      return selectedSet.has(resolve(item.path));
    });
}

/** Build a plan from items already known from the frontend scan — no re-scan. */
export async function buildCleanupPlanFromItems(
  items: Array<{ path: string; safeLevel: SafeLevel; ruleName: string; category: CleanupTarget["category"] }>,
  timeoutMs = Infinity
): Promise<CleanupPlan> {
  const budget: CollectBudget = {
    startedAt: Date.now(),
    timeoutMs,
    maxTargets: Infinity,
    collected: 0
  };
  const targets: CleanupTarget[] = [];
  for (const item of items) {
    if (budgetExpired(budget)) break;
    const files = await collectFilesFromPath(item.path, item.safeLevel, item.ruleName, item.category, budget);
    targets.push(...files);
  }
  return {
    generatedAt: new Date().toISOString(),
    totalSize: targets.reduce((s, t) => s + t.size, 0),
    totalCount: targets.length,
    targets
  };
}

export async function buildCleanupPlan(
  junkResult: JunkScanResult,
  options: PlanOptions = {}
): Promise<CleanupPlan> {
  const budget: CollectBudget = {
    startedAt: Date.now(),
    timeoutMs: options.timeoutMs ?? 8000,
    maxTargets: options.maxTargets ?? Infinity,
    collected: 0
  };
  const targets: CleanupTarget[] = [];

  for (const item of pickItems(junkResult, options)) {
    if (budgetExpired(budget)) {
      break;
    }
    const files = await collectFilesFromPath(item.path, item.safeLevel, item.ruleName, item.category, budget);
    targets.push(...files);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalSize: targets.reduce((sum, target) => sum + target.size, 0),
    totalCount: targets.length,
    targets
  };
}

// Paths the app must never delete from (would crash GPU/renderer process)
function getSelfProtectedPaths(): string[] {
  try {
    return [
      normalize(app.getPath("userData")),
      normalize(app.getPath("appData") + "\\c-drive-cleaner"),
      normalize(app.getPath("exe"))
    ].filter(Boolean);
  } catch {
    return [];
  }
}

function isSelfPath(filePath: string, selfPaths: string[]): boolean {
  const norm = normalize(filePath).toLowerCase();
  return selfPaths.some((p) => norm.startsWith(p.toLowerCase()));
}

export async function executeCleanupPlanWithProgress(
  plan: CleanupPlan,
  onProgress?: (progress: CleanupProgress) => void
): Promise<CleanupReport> {
  const serviceGuard = await prepareWindowsUpdateServiceGuard(plan);
  const startedAt = Date.now();
  let deletedCount = 0;
  let failedCount = 0;
  let bytesFreed = 0;
  const failures: CleanupFailure[] = [];
  const lockedFiles: string[] = [];
  const selfPaths = getSelfProtectedPaths();

  try {
    for (let index = 0; index < plan.targets.length; index += 1) {
      const target = plan.targets[index];
      try {
        if (isSelfPath(target.path, selfPaths)) {
          // Skip — deleting app's own files can crash GPU process → white screen
          failedCount += 1;
          failures.push({ path: target.path, reason: "跳过（应用自身文件）" });
        } else {
          try {
            await unlink(target.path);
          } catch (unlinkErr) {
            const code = (unlinkErr as NodeJS.ErrnoException).code;
            if (code === "EBUSY" || code === "EPERM") {
              try {
                await forceUnlink(target.path); // PowerShell fallback
              } catch {
                lockedFiles.push(target.path); // still locked — needs Restart Manager
                throw unlinkErr;
              }
            } else {
              throw unlinkErr;
            }
          }
          deletedCount += 1;
          bytesFreed += target.size;
        }
      } catch (error) {
        failedCount += 1;
        failures.push({
          path: target.path,
          reason: mapFailureReason(error)
        });
      }
      onProgress?.({
        total: plan.targets.length,
        processed: index + 1,
        deleted: deletedCount,
        failed: failedCount,
        currentPath: target.path,
        percent: plan.targets.length > 0 ? Math.round(((index + 1) / plan.targets.length) * 100) : 100
      });
    }
  } finally {
    await serviceGuard.restore();
  }

  return {
    deletedCount,
    failedCount,
    bytesFreed,
    failures,
    lockedFiles,
    durationMs: Date.now() - startedAt
  };
}

export async function executeCleanupPlan(plan: CleanupPlan): Promise<CleanupReport> {
  return executeCleanupPlanWithProgress(plan);
}
