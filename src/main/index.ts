import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, Notification, screen } from "electron";
import type { IpcMainInvokeEvent, Rectangle } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, lstat, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { initializeDatabase, type DatabaseState } from "./db";
import { DEFAULT_SETTINGS } from "./db/schema";
import { ScannerService } from "./scanner";
import { detectJunk } from "./junk/detector";
import { getDefaultSystemDrive, getSystemInfo, isRunningAsAdmin, requestAdminRelaunch } from "./system";
import { DuplicateFinderService } from "./large-files/duplicate";
import { buildCleanupPlan, executeCleanupPlanWithProgress } from "./cleanup/executor";
import { createSystemRestorePoint } from "./cleanup/restore-point";
import {
  registerWindowIpc,
  registerScannerIpc,
  registerJunkIpc,
  registerMigrationIpc,
  registerSettingsIpc,
  registerMonitorIpc
} from "./ipc";
import type { IpcContext } from "./ipc";
import type { RawJunkRule } from "./junk/types";
import type {
  Alert,
  CleanupLog,
  CleanupPlan,
  CleanupProgress,
  DriveInfo,
  DuplicateDeleteReport,
  DuplicateProgress,
  FileInfo,
  GrowthItem,
  HealthScore,
  MigrateRecord,
  RecommendedDir,
  Snapshot,
  ScanProgress,
  SystemInfo
} from "../shared/types";

// Store all app data next to the exe in production (portable-style)
if (app.isPackaged) {
  app.setPath("userData", join(dirname(app.getPath("exe")), "data"));
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dbState: DatabaseState | null = null;
let isQuitting = false;
let adminGranted = false;
let systemInfoCache: SystemInfo | null = null;
let scheduledCleanupTimer: NodeJS.Timeout | null = null;
let monitorServiceTimer: NodeJS.Timeout | null = null;
let monitorSnapshotRunning = false;
let monitorServiceJobRunning = false;
let lastMonitorSnapshotDate = "";
let healthScoreCache: { expiresAt: number; value: HealthScore } | null = null;
const restoreBoundsByWindow = new WeakMap<BrowserWindow, Rectangle>();
const scannerService = new ScannerService(() => adminGranted);
const monitorScannerService = new ScannerService(() => adminGranted);
const duplicateFinderService = new DuplicateFinderService(getPrimaryDrive(), scannerService);
const execFileAsync = promisify(execFile);

function normalizeDriveLetter(value: string | undefined, fallback = getDefaultSystemDrive()): string {
  const cleaned = (value ?? "").trim().replace(/[\\/]+$/, "").toUpperCase();
  if (/^[A-Z]:$/.test(cleaned)) {
    return cleaned;
  }
  if (/^[A-Z]$/.test(cleaned)) {
    return `${cleaned}:`;
  }
  return fallback;
}

function getPrimaryDrive(): string {
  return normalizeDriveLetter(systemInfoCache?.drive, getDefaultSystemDrive());
}

function toDriveRootPath(drive: string): string {
  return `${normalizeDriveLetter(drive, getDefaultSystemDrive())}\\`;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1360,
    minHeight: 820,
    frame: false,
    title: "C-Drive Cleaner Lite",
    backgroundColor: "#f5f8fc",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (event) => {
    const closeToTrayEnabled = dbState?.getSetting<boolean>("tray.closeToTray") === true;
    const shouldCloseToTray = app.isPackaged && closeToTrayEnabled;
    if (!isQuitting && shouldCloseToTray) {
      event.preventDefault();
      mainWindow?.hide();
      mainWindow?.setSkipTaskbar(true);
    }
  });
  mainWindow.on("minimize", () => {
    const minimizeToTrayEnabled = dbState?.getSetting<boolean>("tray.minimizeToTray") === true;
    const shouldMinimizeToTray = app.isPackaged && minimizeToTrayEnabled;
    if (!isQuitting && shouldMinimizeToTray) {
      setTimeout(() => {
        mainWindow?.hide();
        mainWindow?.setSkipTaskbar(true);
      }, 0);
    }
  });
}

function createTrayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "tray-icon.png")
    : join(__dirname, "../../build/tray-icon.png");
  if (existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
  }
  mainWindow?.setSkipTaskbar(false);
  mainWindow?.show();
  mainWindow?.focus();
}

function applyAutoStartSetting(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // ignore login item errors on unsupported environments
  }
}

function recordAutoStartLaunchHint(): void {
  const launchedAt = new Date().toISOString();
  const uptimeSeconds = Math.max(0, Math.floor(uptime()));
  dbState?.setSetting("tray.lastLaunchAt", launchedAt);
  dbState?.setSetting("tray.lastSystemUptimeSeconds", uptimeSeconds);

  const autoStartEnabled = dbState?.getSetting<boolean>("tray.autoStart") === true;
  const launchedNearBoot = uptimeSeconds <= 300;
  if (autoStartEnabled && launchedNearBoot) {
    dbState?.setSetting("tray.lastAutoStartBootLaunchAt", launchedAt);
    dbState?.addActivity(
      "autostart_boot_launch",
      "检测到可能由开机自启触发的启动",
      { launchedAt, uptimeSeconds }
    );
  }
}

function readPackageDescription(): string {
  try {
    const packagePath = join(app.getAppPath(), "package.json");
    const raw = readFileSync(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { description?: string };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description.trim()
      : "高效的 C 盘空间清理与管理工具。";
  } catch {
    return "高效的 C 盘空间清理与管理工具。";
  }
}

function getCustomRuleFilePath(): string {
  return join(app.getPath("userData"), "custom-junk-rules.json");
}

function sanitizeCustomRule(rule: RawJunkRule, fallbackId: string): RawJunkRule {
  const validCategories = new Set([
    "system_cache",
    "browser",
    "app_cache",
    "dev_cache",
    "temp_files",
    "recycle_bin",
    "logs",
    "update_residual"
  ]);
  const validSafeLevels = new Set(["safe", "caution", "danger"]);
  const id = typeof rule.id === "string" && rule.id.trim().length > 0 ? rule.id.trim() : fallbackId;
  const name = typeof rule.name === "string" && rule.name.trim().length > 0 ? rule.name.trim() : id;
  const category = typeof rule.category === "string" && validCategories.has(rule.category)
    ? rule.category
    : "temp_files";
  const paths = Array.isArray(rule.paths)
    ? rule.paths.map((item) => `${item ?? ""}`.trim()).filter((item) => item.length > 0)
    : [];
  const pattern = typeof rule.pattern === "string" && rule.pattern.trim().length > 0 ? rule.pattern.trim() : undefined;
  const safeLevel = typeof rule.safeLevel === "string" && validSafeLevels.has(rule.safeLevel)
    ? rule.safeLevel
    : "safe";
  const description = typeof rule.description === "string" && rule.description.trim().length > 0
    ? rule.description.trim()
    : `${name} 匹配项`;
  return {
    id,
    name,
    category,
    paths,
    pattern,
    safeLevel,
    description,
    builtin: false,
    enabled: rule.enabled !== false
  };
}

async function loadCustomRules(): Promise<RawJunkRule[]> {
  const customRuleFilePath = getCustomRuleFilePath();
  if (!existsSync(customRuleFilePath)) {
    return [];
  }
  try {
    const raw = (await readFile(customRuleFilePath, "utf-8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as { rules?: RawJunkRule[] };
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    return rules
      .map((item, index) => sanitizeCustomRule(item, `custom-rule-${index + 1}`))
      .filter((item) => Array.isArray(item.paths) && item.paths.length > 0);
  } catch {
    return [];
  }
}

async function saveCustomRules(rules: RawJunkRule[]): Promise<void> {
  const payload = {
    version: "custom-1.0.0",
    updatedAt: new Date().toISOString(),
    rules
  };
  const path = getCustomRuleFilePath();
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
}

function getBundledRuleFilePath(): string {
  return join(app.getAppPath(), "rules", "junk-rules.json");
}

function getCachedRuleFilePath(): string {
  return join(app.getPath("userData"), "junk-rules.json");
}

function countRulesInFile(filePath: string): number {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : []);
    return arr.length;
  } catch {
    return 0;
  }
}

function getActiveRuleFilePath(): string {
  if (!app.isPackaged) return getBundledRuleFilePath();
  const cached = getCachedRuleFilePath();
  if (!existsSync(cached)) return getBundledRuleFilePath();
  const bundled = getBundledRuleFilePath();
  if (countRulesInFile(cached) < countRulesInFile(bundled)) return bundled;
  return cached;
}

function getCommunityRuleFilePath(): string {
  const userDataPath = join(app.getPath("userData"), "junk-rules-community.json");
  if (existsSync(userDataPath)) {
    return userDataPath;
  }
  return join(app.getAppPath(), "rules", "junk-rules-community.json");
}

function parseRuleFileMetadata(raw: string): { version: string; updatedAt: string | null } {
  try {
    const parsed = JSON.parse(raw) as { version?: string; updatedAt?: string };
    const version = typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : "1.0.0";
    const updatedAt = typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length > 0
      ? parsed.updatedAt.trim()
      : null;
    return { version, updatedAt };
  } catch {
    return { version: "1.0.0", updatedAt: null };
  }
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map((item) => Number(item));
  const rightParts = right.split(".").map((item) => Number(item));
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const b = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
  }
  return 0;
}

async function ensureRuleCacheReady(): Promise<void> {
  const cachedPath = getCachedRuleFilePath();
  if (!existsSync(cachedPath)) {
    await copyFile(getBundledRuleFilePath(), cachedPath);
  }
  try {
    const raw = await readFile(cachedPath, "utf-8");
    const meta = parseRuleFileMetadata(raw);
    dbState?.setSetting("rules.version", meta.version);
    dbState?.setSetting("rules.lastUpdated", meta.updatedAt ?? new Date().toISOString());
  } catch {
    // ignore rule cache initialization errors
  }
}

async function updateRuleLibraryFromRemote(manual: boolean): Promise<{
  updated: boolean;
  message: string;
  currentVersion: string;
  remoteVersion?: string;
}> {
  await ensureRuleCacheReady();
  const localPath = getCachedRuleFilePath();
  let localVersion = dbState?.getSetting<string>("rules.version") ?? "1.0.0";
  try {
    const localRaw = await readFile(localPath, "utf-8");
    localVersion = parseRuleFileMetadata(localRaw).version;
  } catch {
    // keep settings value as fallback
  }
  const remoteUrl = (dbState?.getSetting<string>("rules.remoteUrl") ?? "").trim();
  if (!remoteUrl) {
    return {
      updated: false,
      currentVersion: localVersion,
      message: "未配置规则库远程地址"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(remoteUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const remoteRaw = await response.text();
    const remoteMeta = parseRuleFileMetadata(remoteRaw);
    if (compareVersion(remoteMeta.version, localVersion) <= 0) {
      return {
        updated: false,
        currentVersion: localVersion,
        remoteVersion: remoteMeta.version,
        message: "规则库已是最新版本"
      };
    }
    await writeFile(localPath, remoteRaw, "utf-8");
    dbState?.setSetting("rules.version", remoteMeta.version);
    dbState?.setSetting("rules.lastUpdated", new Date().toISOString());
    dbState?.addActivity("rules_updated", `规则库更新到 ${remoteMeta.version}`, {
      localVersion,
      remoteVersion: remoteMeta.version,
      manual
    });
    return {
      updated: true,
      currentVersion: remoteMeta.version,
      remoteVersion: remoteMeta.version,
      message: `规则库已更新到 ${remoteMeta.version}`
    };
  } catch (error) {
    return {
      updated: false,
      currentVersion: localVersion,
      message: error instanceof Error ? `规则库更新失败：${error.message}` : "规则库更新失败"
    };
  } finally {
    clearTimeout(timer);
  }
}

function navigateMainWindow(page: "overview" | "scan" | "duplicate" | "junk" | "migrate" | "monitor" | "settings"): void {
  showMainWindow();
  if (!mainWindow) {
    return;
  }
  const send = (): void => {
    mainWindow?.webContents.send("app:navigate", { page });
  };
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", send);
    return;
  }
  send();
}

function emitMonitorStatusChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const enabled = dbState?.getSetting<boolean>("monitor.enabled") ?? true;
  const dailyTime = dbState?.getSetting<string>("monitor.dailyTime") ?? "08:30";
  mainWindow.webContents.send("monitor:status-changed", {
    enabled,
    dailyTime,
    running: monitorServiceTimer !== null
  });
}

function buildTrayMenu(): Electron.Menu {
  const monitorEnabled = dbState?.getSetting<boolean>("monitor.enabled") ?? true;
  return Menu.buildFromTemplate([
    {
      label: "打开主界面",
      click: showMainWindow
    },
    {
      label: monitorEnabled ? "暂停监控" : "开启监控",
      click: () => {
        dbState?.setSetting("monitor.enabled", !monitorEnabled);
        syncMonitorServiceWithSettings();
        tray?.setContextMenu(buildTrayMenu());
      }
    },
    { type: "separator" },
    {
      label: "退出应用",
      click: () => {
        isQuitting = true;
        tray?.destroy();
        tray = null;
        app.quit();
      }
    }
  ]);
}

function createTray(): void {
  const image = createTrayIcon();
  tray = new Tray(image);
  tray.setToolTip("C-Drive Cleaner Lite");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function getWindowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

function queryLargeFiles(
  files: FileInfo[],
  args?: {
    limit?: number;
    type?: FileInfo["type"] | "all";
    query?: string;
    extension?: string;
  }
): FileInfo[] {
  const limit = Math.max(1, Math.min(5000, args?.limit ?? 20));
  const type = args?.type ?? "all";
  const query = (args?.query ?? "").trim().toLowerCase();
  const extension = (args?.extension ?? "").trim().toLowerCase().replace(/^\./, "");

  return files
    .filter((file) => (type === "all" ? true : file.type === type))
    .filter((file) => {
      if (!query) {
        return true;
      }
      const lowerName = file.name.toLowerCase();
      const extSearch = query.startsWith(".") ? query.slice(1) : "";
      if (extSearch) {
        const dotExt = lowerName.split(".").pop() ?? "";
        return dotExt === extSearch;
      }
      return lowerName.includes(query);
    })
    .filter((file) => {
      if (!extension) {
        return true;
      }
      const dotExt = file.name.toLowerCase().split(".").pop() ?? "";
      return dotExt === extension;
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}

async function deleteDuplicateFiles(paths: string[]): Promise<DuplicateDeleteReport> {
  let deletedCount = 0;
  let failedCount = 0;
  let bytesFreed = 0;
  const failures: Array<{ path: string; reason: string }> = [];

  for (const path of paths) {
    try {
      const fileStat = await stat(path);
      await unlink(path);
      deletedCount += 1;
      bytesFreed += fileStat.size;
    } catch (error) {
      failedCount += 1;
      failures.push({
        path,
        reason: error instanceof Error ? error.message : "删除失败"
      });
    }
  }

  return {
    deletedCount,
    failedCount,
    bytesFreed,
    failures
  };
}

function isDriveRootPath(path: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(path.trim());
}

async function runScheduledBackupCleanup(): Promise<void> {
  if (!dbState?.available) {
    return;
  }
  const now = new Date().toISOString();
  const due = dbState.queryAll<{
    id: number;
    target_path: string;
    scheduled_at: string;
  }>(
    "SELECT id, target_path, scheduled_at FROM scheduled_cleanups WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 20",
    [now]
  );

  for (const item of due) {
    try {
      const targetPath = item.target_path.trim();
      if (targetPath.length === 0 || isDriveRootPath(targetPath)) {
        throw new Error("备份路径无效，已跳过");
      }
      await rm(targetPath, { recursive: true, force: true });
      dbState.execute(
        "UPDATE scheduled_cleanups SET status = 'completed' WHERE id = ?",
        [item.id]
      );
      dbState.addActivity(
        "migrate_backup_cleanup_complete",
        `已自动清理迁移备份：${targetPath}`,
        { id: item.id, targetPath, scheduledAt: item.scheduled_at }
      );
    } catch (error) {
      dbState.execute(
        "UPDATE scheduled_cleanups SET status = 'failed' WHERE id = ?",
        [item.id]
      );
      dbState.addActivity(
        "migrate_backup_cleanup_failed",
        `迁移备份自动清理失败：${item.target_path}`,
        { id: item.id, error: error instanceof Error ? error.message : "unknown error" }
      );
    }
  }
}

async function runMigrationHealthCheck(): Promise<void> {
  if (!dbState?.available) {
    return;
  }
  const rows = dbState.queryAll<{
    id: number;
    source_path: string;
    target_path: string;
    status: string;
  }>(
    "SELECT id, source_path, target_path, status FROM migrate_records WHERE status != 'rolled_back' ORDER BY migrated_at DESC LIMIT 200"
  );

  for (const row of rows) {
    let healthy = true;
    let reason = "";
    try {
      const sourceStat = await lstat(row.source_path);
      if (!sourceStat.isSymbolicLink()) {
        healthy = false;
        reason = "原路径 Junction 不存在或已被替换";
      } else {
        await stat(row.target_path);
      }
    } catch (error) {
      healthy = false;
      reason = error instanceof Error ? error.message : "目标路径不可访问";
    }

    const nextStatus = healthy ? "active" : "unhealthy";
    if (row.status !== nextStatus) {
      dbState.execute(
        "UPDATE migrate_records SET status = ?, last_checked = ? WHERE id = ?",
        [nextStatus, new Date().toISOString(), row.id]
      );
      if (!healthy) {
        dbState.execute(
          "INSERT INTO alerts (created_at, severity, title, description, dir_path, is_read) VALUES (?, ?, ?, ?, ?, 0)",
          [
            new Date().toISOString(),
            "warning",
            "迁移目录健康异常",
            `目录 ${row.source_path} 状态异常：${reason}`,
            row.source_path
          ]
        );
        dbState.addActivity(
          "migrate_health_unhealthy",
          `迁移目录异常：${row.source_path}`,
          { id: row.id, reason, sourcePath: row.source_path, targetPath: row.target_path }
        );
        if (Notification.isSupported()) {
          new Notification({
            title: "C-Drive Cleaner Lite",
            body: `迁移目录异常：${row.source_path}`
          }).show();
        }
      } else {
        dbState.addActivity(
          "migrate_health_recovered",
          `迁移目录恢复健康：${row.source_path}`,
          { id: row.id, sourcePath: row.source_path, targetPath: row.target_path }
        );
      }
    } else {
      dbState.execute(
        "UPDATE migrate_records SET last_checked = ? WHERE id = ?",
        [new Date().toISOString(), row.id]
      );
    }
  }
}

function startScheduledBackupCleaner(): void {
  if (scheduledCleanupTimer) {
    clearInterval(scheduledCleanupTimer);
    scheduledCleanupTimer = null;
  }
  void runScheduledBackupCleanup();
  void runMigrationHealthCheck();
  scheduledCleanupTimer = setInterval(() => {
    void runScheduledBackupCleanup();
    void runMigrationHealthCheck();
  }, 5 * 60 * 1000);
}

function parseDailyTime(value: string | undefined): { hour: number; minute: number } {
  const fallback = { hour: 8, minute: 30 };
  if (!value) {
    return fallback;
  }
  const match = value.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return fallback;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return fallback;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return { hour, minute };
}

function getDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computeNextMonitorRunTime(now: Date, dailyTime: string): string {
  const parsed = parseDailyTime(dailyTime);
  const next = new Date(now);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function parseSnapshotDirs(raw: string): Array<{ name: string; size: number }> {
  try {
    const value = JSON.parse(raw) as Array<{ name?: string; size?: number }>;
    return value
      .filter((row) => typeof row?.name === "string" && Number.isFinite(Number(row?.size ?? 0)))
      .map((row) => ({ name: row.name as string, size: Number(row.size ?? 0) }));
  } catch {
    return [];
  }
}

async function collectTopLevelDirSizes(
  drive: string,
  totalDisk: number,
  freeDisk: number
): Promise<Array<{ name: string; size: number }>> {
  const drivePath = drive.endsWith("\\") ? drive : `${drive}\\`;
  const estimatedBytes = Math.max(0, totalDisk - freeDisk);

  try {
    const result = await monitorScannerService.scan({
      path: drivePath,
      maxDepth: 1,
      estimatedBytes,
      maxLargeFiles: 1,
      largeFileThreshold: Number.MAX_SAFE_INTEGER,
      preferredEngine: dbState?.getSetting<"auto" | "everything" | "mft" | "walk">("scan.preferredEngine") ?? "auto"
    });
    return (result.tree.children ?? [])
      .map((child) => ({
        name: child.name || child.path.replace(/[\\/]+$/, ""),
        size: Math.max(0, child.size)
      }))
      .sort((left, right) => right.size - left.size);
  } catch {
    const last = scannerService.getLastResult();
    if (!last) {
      return [];
    }
    return (last.tree.children ?? [])
      .map((child) => ({
        name: child.name || child.path.replace(/[\\/]+$/, ""),
        size: Math.max(0, child.size)
      }))
      .sort((left, right) => right.size - left.size);
  }
}

async function createSnapshot(trigger: "manual" | "scheduled"): Promise<Snapshot | null> {
  if (!dbState?.available) {
    return null;
  }
  if (monitorSnapshotRunning) {
    return null;
  }
  monitorSnapshotRunning = true;

  try {
    const info = await getSystemInfo(getPrimaryDrive());
    systemInfoCache = info;
    const dirs = await collectTopLevelDirSizes(info.drive ?? getPrimaryDrive(), info.totalDisk, info.freeDisk);
    const takenAt = new Date().toISOString();
    const usedSize = Math.max(0, info.totalDisk - info.freeDisk);

    dbState.execute(
      "INSERT INTO snapshots (taken_at, total_size, used_size, free_size, dirs) VALUES (?, ?, ?, ?, ?)",
      [takenAt, info.totalDisk, usedSize, info.freeDisk, JSON.stringify(dirs)]
    );
    healthScoreCache = null;
    dbState.execute(
      "DELETE FROM snapshots WHERE taken_at < ?",
      [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()]
    );

    const row = dbState.queryGet<{
      id: number;
      taken_at: string;
      total_size: number;
      used_size: number;
      free_size: number;
      dirs: string;
    }>(
      "SELECT id, taken_at, total_size, used_size, free_size, dirs FROM snapshots ORDER BY id DESC LIMIT 1"
    );

    if (!row) {
      return null;
    }

    dbState.addActivity(
      "snapshot_taken",
      trigger === "manual" ? "手动快照采集完成" : "每日快照采集完成",
      { trigger, id: row.id, takenAt: row.taken_at, dirCount: dirs.length }
    );

    return {
      id: row.id,
      takenAt: row.taken_at,
      totalSize: row.total_size,
      usedSize: row.used_size,
      freeSize: row.free_size,
      dirs: parseSnapshotDirs(row.dirs)
    };
  } finally {
    monitorSnapshotRunning = false;
  }
}

function formatBytesForNotification(bytes: number): string {
  if (bytes <= 0) {
    return "0 MB";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function insertGrowthAlerts(growthItems: GrowthItem[]): number {
  if (!dbState?.available || growthItems.length === 0) {
    return 0;
  }
  const notifyInApp = dbState.getSetting<boolean>("monitor.notifyInApp") ?? true;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let inserted = 0;
  for (const item of growthItems) {
    const exists = dbState.queryGet<{ id: number }>(
      "SELECT id FROM alerts WHERE dir_path = ? AND created_at >= ? LIMIT 1",
      [item.dirName, todayStart.toISOString()]
    );
    if (exists) {
      continue;
    }
    const severity: "warning" | "critical" =
      item.rate >= 0.1 || item.delta >= 2 * 1024 ** 3 ? "critical" : "warning";
    if (notifyInApp) {
      dbState.execute(
        "INSERT INTO alerts (created_at, severity, title, description, dir_path, delta_bytes, is_read) VALUES (?, ?, ?, ?, ?, ?, 0)",
        [
          new Date().toISOString(),
          severity,
          "C盘空间告警",
          `${item.dirName} 今日增长 ${formatBytesForNotification(item.delta)}，建议：${item.suggestion}`,
          item.dirName,
          item.delta
        ]
      );
    }
    inserted += 1;
  }
  return inserted;
}

function notifyGrowthAlert(growthItems: GrowthItem[], insertedAlerts: number): void {
  if (!Notification.isSupported() || growthItems.length === 0 || insertedAlerts <= 0) {
    return;
  }
  const notifyToast = dbState?.getSetting<boolean>("monitor.notifyToast") ?? true;
  if (!notifyToast) {
    return;
  }
  const first = growthItems[0];
  const body =
    growthItems.length === 1
      ? `${first.dirName} 今日增长 ${formatBytesForNotification(first.delta)}，${first.suggestion}`
      : `${first.dirName} 今日增长 ${formatBytesForNotification(first.delta)}，另有 ${growthItems.length - 1} 个目录异常`;
  const notification = new Notification({
    title: "C盘空间告警",
    body
  });
  notification.on("click", () => navigateMainWindow("monitor"));
  notification.show();
}

function queryLatestTwoSnapshots(): [Snapshot, Snapshot] | null {
  if (!dbState?.available) {
    return null;
  }
  const rows = dbState.queryAll<{
    id: number;
    taken_at: string;
    total_size: number;
    used_size: number;
    free_size: number;
    dirs: string;
  }>(
    "SELECT id, taken_at, total_size, used_size, free_size, dirs FROM snapshots ORDER BY taken_at DESC LIMIT 2"
  );
  if (rows.length < 2) {
    return null;
  }
  const ordered = [...rows].reverse();
  const snapshots = ordered.map<Snapshot>((row) => ({
    id: row.id,
    takenAt: row.taken_at,
    totalSize: row.total_size,
    usedSize: row.used_size,
    freeSize: row.free_size,
    dirs: parseSnapshotDirs(row.dirs)
  }));
  return [snapshots[0], snapshots[1]];
}

function runGrowthAnalysisAndNotify(trigger: "scheduled" | "manual"): GrowthItem[] {
  const pair = queryLatestTwoSnapshots();
  if (!pair) {
    return [];
  }
  const threshold = dbState?.getSetting<number>("monitor.growthThresholdBytes") ?? 524288000;
  const growthItems = compareSnapshotsForGrowth(pair[1], pair[0], threshold, 10);
  if (growthItems.length === 0) {
    return [];
  }
  const insertedAlerts = insertGrowthAlerts(growthItems);
  const notifyLog = dbState?.getSetting<boolean>("monitor.notifyLog") ?? true;
  if (notifyLog) {
    dbState?.addActivity(
      "monitor_growth_analyzed",
      `检测到 ${growthItems.length} 个异常增长目录`,
      {
        trigger,
        top: growthItems.slice(0, 3).map((item) => ({
          dirName: item.dirName,
          delta: item.delta,
          rate: item.rate
        }))
      }
    );
  }
  if (trigger === "scheduled") {
    notifyGrowthAlert(growthItems, insertedAlerts);
  }
  return growthItems;
}

function loadLastSnapshotDate(): void {
  if (!dbState?.available) {
    lastMonitorSnapshotDate = "";
    return;
  }
  const row = dbState.queryGet<{ taken_at: string }>(
    "SELECT taken_at FROM snapshots ORDER BY taken_at DESC LIMIT 1"
  );
  if (!row?.taken_at) {
    lastMonitorSnapshotDate = "";
    return;
  }
  lastMonitorSnapshotDate = getDateKey(new Date(row.taken_at));
}

async function runScheduledMonitorSnapshot(reason: "startup" | "interval" | "toggle"): Promise<void> {
  if (!dbState?.available) {
    return;
  }
  const enabled = dbState.getSetting<boolean>("monitor.enabled") ?? true;
  if (!enabled) {
    return;
  }
  const dailyTime = dbState.getSetting<string>("monitor.dailyTime") ?? "08:30";
  const parsed = parseDailyTime(dailyTime);
  const now = new Date();
  const todayKey = getDateKey(now);
  if (lastMonitorSnapshotDate === todayKey) {
    return;
  }

  const due = now.getHours() > parsed.hour || (now.getHours() === parsed.hour && now.getMinutes() >= parsed.minute);
  if (!due) {
    return;
  }

  if (monitorServiceJobRunning) {
    return;
  }
  monitorServiceJobRunning = true;
  try {
    const snapshot = await createSnapshot("scheduled");
    if (!snapshot) {
      return;
    }
    lastMonitorSnapshotDate = todayKey;
    if (reason === "startup") {
      dbState.addActivity("monitor_bootstrap", "启动后补采今日监控快照", { takenAt: snapshot.takenAt });
    }
    runGrowthAnalysisAndNotify("scheduled");
  } finally {
    monitorServiceJobRunning = false;
  }
}

function stopMonitorService(): void {
  if (monitorServiceTimer) {
    clearInterval(monitorServiceTimer);
    monitorServiceTimer = null;
  }
  emitMonitorStatusChanged();
}

function startMonitorService(): void {
  stopMonitorService();
  if (!dbState?.available) {
    return;
  }
  const enabled = dbState.getSetting<boolean>("monitor.enabled") ?? true;
  if (!enabled) {
    return;
  }
  loadLastSnapshotDate();
  void runScheduledMonitorSnapshot("startup");
  monitorServiceTimer = setInterval(() => {
    void runScheduledMonitorSnapshot("interval");
  }, 30 * 1000);
  emitMonitorStatusChanged();
}

function syncMonitorServiceWithSettings(): void {
  const enabled = dbState?.getSetting<boolean>("monitor.enabled") ?? true;
  if (enabled) {
    startMonitorService();
  } else {
    stopMonitorService();
  }
  emitMonitorStatusChanged();
}

function inferSuggestion(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("recycle")) {
    return "清空回收站";
  }
  if (lower.includes("temp") || lower.includes("cache") || lower.includes("tmp")) {
    return "清理缓存";
  }
  return "建议迁移";
}

function compareSnapshotsForGrowth(
  latest: Snapshot,
  previous: Snapshot,
  thresholdBytes: number,
  topN: number
): GrowthItem[] {
  const previousByName = new Map(previous.dirs.map((item) => [item.name.toLowerCase(), item.size]));
  const growth: GrowthItem[] = [];

  for (const current of latest.dirs) {
    const prevSize = previousByName.get(current.name.toLowerCase()) ?? 0;
    const delta = current.size - prevSize;
    if (delta <= 0) {
      continue;
    }
    const rate = prevSize > 0 ? delta / prevSize : 1;
    growth.push({
      dirName: current.name,
      prevSize,
      currSize: current.size,
      delta,
      rate,
      suggestion: inferSuggestion(current.name)
    });
  }

  return growth
    .filter((item) => item.delta >= thresholdBytes)
    .sort((left, right) => right.delta - left.delta)
    .slice(0, Math.max(1, Math.min(50, topN)));
}

function querySnapshots(days = 7): Snapshot[] {
  if (!dbState?.available) {
    return [];
  }
  const safeDays = Math.max(1, Math.min(365, days));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = dbState.queryAll<{
    id: number;
    taken_at: string;
    total_size: number;
    used_size: number;
    free_size: number;
    dirs: string;
  }>(
    "SELECT id, taken_at, total_size, used_size, free_size, dirs FROM snapshots WHERE taken_at >= ? ORDER BY taken_at ASC",
    [since]
  );
  return rows.map((row) => ({
    id: row.id,
    takenAt: row.taken_at,
    totalSize: row.total_size,
    usedSize: row.used_size,
    freeSize: row.free_size,
    dirs: parseSnapshotDirs(row.dirs)
  }));
}

function getDatabaseSummary(): {
  available: boolean;
  version: number;
  path?: string;
  appDir: string;
  rulesVersion: string;
  rulesLastUpdated: string | null;
  latestBackupAt: string | null;
} {
  const available = dbState?.available ?? false;
  const version = dbState?.getDatabaseVersion() ?? 0;
  const path = dbState?.path;
  const rulesVersion = dbState?.getSetting<string>("rules.version") ?? "1.0.0";
  const rulesLastUpdated = dbState?.getSetting<string | null>("rules.lastUpdated") ?? null;

  const appDir = process.cwd();

  const latestScheduled = dbState?.queryGet<{ latest: string | null }>(
    "SELECT MAX(created_at) AS latest FROM scheduled_cleanups"
  )?.latest ?? null;
  const latestMigrated = dbState?.queryGet<{ latest: string | null }>(
    "SELECT MAX(migrated_at) AS latest FROM migrate_records WHERE backup_path IS NOT NULL"
  )?.latest ?? null;
  const latestBackupAt = [latestScheduled, latestMigrated]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1) ?? null;

  return {
    available,
    version,
    path,
    appDir,
    rulesVersion,
    rulesLastUpdated,
    latestBackupAt
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function readFragmentPercent(drive = "C:"): Promise<number | null> {
  try {
    const { stdout, stderr } = await execFileAsync("defrag", [drive, "/A"]);
    const output = `${stdout ?? ""}\n${stderr ?? ""}`;
    const patterns = [
      /total fragmentation\s*=\s*(\d+(?:\.\d+)?)%/i,
      /总碎片率\s*[=:]\s*(\d+(?:\.\d+)?)%/i,
      /fragmentation\s*[=:]\s*(\d+(?:\.\d+)?)%/i
    ];
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (!match) {
        continue;
      }
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        return clamp(value / 100, 0, 1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function gradeFromScore(score: number): HealthScore["grade"] {
  if (score >= 90) {
    return "excellent";
  }
  if (score >= 70) {
    return "good";
  }
  if (score >= 50) {
    return "warning";
  }
  return "danger";
}

async function computeHealthScore(): Promise<HealthScore> {
  if (healthScoreCache && healthScoreCache.expiresAt > Date.now()) {
    return healthScoreCache.value;
  }

  const info = systemInfoCache ?? await getSystemInfo(getPrimaryDrive());
  const totalDisk = Math.max(1, info.totalDisk);
  const freePercent = clamp(info.freeDisk / totalDisk, 0, 1);
  const freeSpaceScore = clamp((freePercent / 0.25) * 40, 0, 40);

  const snapshotPair = queryLatestTwoSnapshots();
  const growthThreshold = dbState?.getSetting<number>("monitor.growthThresholdBytes") ?? 524288000;
  const abnormalDirCount = snapshotPair
    ? compareSnapshotsForGrowth(snapshotPair[1], snapshotPair[0], growthThreshold, 20).length
    : 0;
  const growthScore = clamp(20 - abnormalDirCount * 4, 0, 20);

  let junkPercent = 0;
  try {
    const junkResult = await detectJunk(getActiveRuleFilePath(), {
      timeoutMs: 1000,
      maxFilesPerTarget: 3000,
      customRuleFilePath: getCustomRuleFilePath()
    });
    junkPercent = clamp(junkResult.totalSize / totalDisk, 0, 1);
  } catch {
    junkPercent = 0;
  }
  const junkScore = clamp((1 - Math.min(junkPercent, 0.2) / 0.2) * 20, 0, 20);

  const largeFileSize = scannerService
    .getLastResult()
    ?.largeFiles.reduce((sum, file) => sum + Math.max(0, file.size), 0) ?? 0;
  const largeFilePercent = clamp(largeFileSize / totalDisk, 0, 1);
  const largeFileScore = clamp((1 - Math.min(largeFilePercent, 0.3) / 0.3) * 10, 0, 10);

  const fragmentPercent = await readFragmentPercent(info.drive ?? getPrimaryDrive());
  const fragmentScore =
    fragmentPercent === null ? 10 : clamp((1 - Math.min(fragmentPercent, 0.2) / 0.2) * 10, 0, 10);

  const score = Math.round(freeSpaceScore + growthScore + junkScore + largeFileScore + fragmentScore);
  const value: HealthScore = {
    score,
    grade: gradeFromScore(score),
    breakdown: {
      freeSpaceScore: Math.round(freeSpaceScore),
      growthScore: Math.round(growthScore),
      junkScore: Math.round(junkScore),
      largeFileScore: Math.round(largeFileScore),
      fragmentScore: Math.round(fragmentScore)
    },
    details: {
      freePercent,
      abnormalDirCount,
      junkPercent,
      largeFileSize,
      fragmentPercent: fragmentPercent ?? 0
    }
  };
  healthScoreCache = {
    value,
    expiresAt: Date.now() + 30 * 60 * 1000
  };
  return value;
}

function registerIpc(): void {
  const ctx: import("./ipc").IpcContext = {
    getDbState: () => dbState,
    getMainWindow: () => mainWindow,
    getTray: () => tray,
    getScannerService: () => scannerService,
    getMonitorScannerService: () => monitorScannerService,
    getDuplicateFinderService: () => duplicateFinderService,
    isAdmin: () => adminGranted,
    getSystemDrive: () => getPrimaryDrive(),
    toDriveRootPath,
    showMainWindow,
    buildTrayMenu,
    emitMonitorStatusChanged,
    queryLargeFiles,
    isDriveRootPath,
    readPackageDescription,
    getCustomRuleFilePath,
    getActiveRuleFilePath,
    getCommunityRuleFilePath,
    startMonitorService,
    stopMonitorService,
    syncMonitorServiceWithSettings,
    applyAutoStartSetting,
    computeHealthScore,
    createSnapshot,
    querySnapshots,
    compareSnapshotsForGrowth,
    computeNextMonitorRunTime,
    runScheduledMonitorSnapshot,
    runGrowthAnalysisAndNotify,
    getDateKey,
    updateRuleLibraryFromRemote,
    getDatabaseSummary,
    deleteDuplicateFiles,
    loadCustomRules,
    saveCustomRules,
    sanitizeCustomRule,
    runMigrationHealthCheck,
    restoreBoundsByWindow
  };

  registerWindowIpc(ctx);
  registerScannerIpc(ctx);
  registerJunkIpc(ctx);
  registerMigrationIpc(ctx);
  registerSettingsIpc(ctx);
  registerMonitorIpc(ctx);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

app.whenReady().then(async () => {
  dbState = initializeDatabase(app.getPath("userData"));
  await ensureRuleCacheReady();
  applyAutoStartSetting(dbState.getSetting<boolean>("tray.autoStart") ?? false);
  recordAutoStartLaunchHint();
  adminGranted = await isRunningAsAdmin();
  registerIpc();
  createWindow();
  createTray();
  void getSystemInfo(getPrimaryDrive()).then((info) => { systemInfoCache = info; });
  startScheduledBackupCleaner();
  syncMonitorServiceWithSettings();
  void updateRuleLibraryFromRemote(false);

  if (!adminGranted && app.isPackaged) {
    requestAdminRelaunch();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (scheduledCleanupTimer) {
    clearInterval(scheduledCleanupTimer);
    scheduledCleanupTimer = null;
  }
  stopMonitorService();
  tray?.destroy();
  tray = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
