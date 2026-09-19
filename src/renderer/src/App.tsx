import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CircleGauge,
  Database,
  Eraser,
  FileArchive,
  Home,
  Link2,
  Maximize2,
  Minimize2,
  Play,
  Search,
  Settings,
  ShieldCheck,
  X
} from "lucide-react";
import type {
  Alert,
  ActivityLog,
  DirTree,
  DriveInfo,
  DuplicateDeleteReport,
  DuplicateProgress,
  DuplicateScanResult,
  FileInfo,
  GrowthItem,
  HealthScore,
  JunkScanResult,
  MigrateRecord,
  ScanEngine,
  ScanProgress,
  ScanResult,
  ScanStats,
  SystemInfo
} from "../../shared/types";
import { useAppStore, fallbackTree, fallbackSystemInfo, fallbackHealthScore } from "./stores/app-store";
import { OverviewPage } from "./pages/OverviewPage";
import { ScanPage } from "./pages/ScanPage";
import { DuplicatePage } from "./pages/DuplicatePage";
import { JunkPage } from "./pages/JunkPage";
import { MigratePage } from "./pages/MigratePage";
import { MonitorPage } from "./pages/MonitorPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { PageId, ScanState, DuplicateState, OneClickTaskKey, OneClickStage, NavItem } from "./types";
import { junkOptionsFromPreset, type JunkScanOptions } from "./utils/junk";
import { formatBytes, healthGradeLabel, healthGradeClass } from "./utils/format";
import { normalizeScanRootPath, driveRootFromLetter } from "./utils/path";

const navItems: NavItem[] = [
  { id: "overview", label: "总览", icon: Home },
  { id: "scan", label: "磁盘扫描", icon: Search },
  { id: "duplicate", label: "重复文件", icon: FileArchive },
  { id: "junk", label: "垃圾识别与清理", icon: Eraser },
  { id: "migrate", label: "软链接迁移", icon: Link2 },
  { id: "monitor", label: "每日监控与趋势", icon: Activity },
  { id: "settings", label: "设置", icon: Settings }
];

const oneClickTaskDefs: { key: OneClickTaskKey; label: string; short: string }[] = [
  { key: "disk", label: "磁盘扫描", short: "磁盘" },
  { key: "junk", label: "垃圾识别", short: "垃圾" },
  { key: "duplicate", label: "重复文件", short: "重复" }
];

const defaultOneClickQueue: OneClickTaskKey[] = ["disk", "junk"];

function App(): JSX.Element {
  const store = useAppStore();
  const {
    page, engine, adminGranted, systemInfo, healthScore, settingsMap,
    appMeta, dbSummary, loginItemStatus, activityLogs,
    windowNotice, migrationStats,
    scanState, scanRootPath, scanDriveOptions, scanProgress, scanTree,
    scanStats, scanStartedAt, scanElapsedMs, scanError, previousScanStats,
    largeFileRows, skippedPaths,
    junkResult, junkScanState, junkScanError,
    duplicateState, duplicateProgress, duplicateResult, duplicateError,
    duplicateKeepByHash, duplicateDeleteReport,
    monitorEnabled, monitorDailyTime, monitorThresholdBytes, monitorThresholdPercent,
    monitorNotifyToast, monitorNotifyLog, monitorNotifyInApp,
    monitorGrowthRows, monitorAlerts, monitorAlertHistory,
    oneClickScanning, oneClickStage, oneClickTaskSelection, oneClickSelectorOpen,
    set: setStore, flashNotice
  } = store;
  const setPage = (v: PageId) => setStore({ page: v });
  const setEngine = (v: ScanEngine) => setStore({ engine: v });
  const setAdminGranted = (v: boolean) => setStore({ adminGranted: v });
  const setSystemInfo = (v: SystemInfo) => setStore({ systemInfo: v });
  const setHealthScore = (v: HealthScore) => setStore({ healthScore: v });
  const setSettingsMap = (v: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) =>
    typeof v === "function" ? setStore((s) => ({ settingsMap: v(s.settingsMap) })) : setStore({ settingsMap: v });
  const setAppMeta = (v: typeof appMeta) => setStore({ appMeta: v });
  const setDbSummary = (v: typeof dbSummary) => setStore({ dbSummary: v });
  const setLoginItemStatus = (v: typeof loginItemStatus) => setStore({ loginItemStatus: v });
  const setActivityLogs = (v: ActivityLog[]) => setStore({ activityLogs: v });
  const setWindowNotice = (v: string | null) => setStore({ windowNotice: v });
  const setMigrationStats = (v: typeof migrationStats) => setStore({ migrationStats: v });
  const setScanState = (v: ScanState | ((s: ScanState) => ScanState)) =>
    typeof v === "function" ? setStore((s) => ({ scanState: v(s.scanState) })) : setStore({ scanState: v });
  const setScanRootPath = (v: string | ((s: string) => string)) =>
    typeof v === "function" ? setStore((s) => ({ scanRootPath: v(s.scanRootPath) })) : setStore({ scanRootPath: v });
  const setScanDriveOptions = (v: DriveInfo[]) => setStore({ scanDriveOptions: v });
  const setScanProgress = (v: ScanProgress | null) => setStore({ scanProgress: v });
  const setScanTree = (v: DirTree) => setStore({ scanTree: v });
  const setScanStats = (v: ScanStats | null) => setStore({ scanStats: v });
  const setScanStartedAt = (v: number | null | ((s: number | null) => number | null)) =>
    typeof v === "function" ? setStore((s) => ({ scanStartedAt: v(s.scanStartedAt) })) : setStore({ scanStartedAt: v });
  const setScanElapsedMs = (v: number) => setStore({ scanElapsedMs: v });
  const setScanError = (v: string | null) => setStore({ scanError: v });
  const setPreviousScanStats = (v: ScanStats | null) => setStore({ previousScanStats: v });
  const setLargeFileRows = (v: FileInfo[]) => setStore({ largeFileRows: v });
  const setSkippedPaths = (v: string[]) => setStore({ skippedPaths: v });
  const setJunkResult = (v: JunkScanResult | null) => setStore({ junkResult: v });
  const setJunkScanState = (v: "idle" | "scanning" | "complete" | "error") => setStore({ junkScanState: v });
  const setJunkScanError = (v: string | null) => setStore({ junkScanError: v });
  const setDuplicateState = (v: DuplicateState) => setStore({ duplicateState: v });
  const setDuplicateProgress = (v: DuplicateProgress | null) => setStore({ duplicateProgress: v });
  const setDuplicateResult = (v: DuplicateScanResult | null | ((s: DuplicateScanResult | null) => DuplicateScanResult | null)) =>
    typeof v === "function" ? setStore((s) => ({ duplicateResult: v(s.duplicateResult) })) : setStore({ duplicateResult: v });
  const setDuplicateError = (v: string | null) => setStore({ duplicateError: v });
  const setDuplicateKeepByHash = (v: Record<string, string> | ((s: Record<string, string>) => Record<string, string>)) =>
    typeof v === "function" ? setStore((s) => ({ duplicateKeepByHash: v(s.duplicateKeepByHash) })) : setStore({ duplicateKeepByHash: v });
  const setDuplicateDeleteReport = (v: DuplicateDeleteReport | null) => setStore({ duplicateDeleteReport: v });
  const setMonitorEnabled = (v: boolean) => setStore({ monitorEnabled: v });
  const setMonitorDailyTime = (v: string) => setStore({ monitorDailyTime: v });
  const setMonitorThresholdBytes = (v: number) => setStore({ monitorThresholdBytes: v });
  const setMonitorThresholdPercent = (v: number) => setStore({ monitorThresholdPercent: v });
  const setMonitorNotifyToast = (v: boolean) => setStore({ monitorNotifyToast: v });
  const setMonitorNotifyLog = (v: boolean) => setStore({ monitorNotifyLog: v });
  const setMonitorNotifyInApp = (v: boolean) => setStore({ monitorNotifyInApp: v });
  const setMonitorGrowthRows = (v: GrowthItem[]) => setStore({ monitorGrowthRows: v });
  const setMonitorAlerts = (v: Alert[]) => setStore({ monitorAlerts: v });
  const setMonitorAlertHistory = (v: Alert[]) => setStore({ monitorAlertHistory: v });
  const setOneClickScanning = (v: boolean) => setStore({ oneClickScanning: v });
  const setOneClickStage = (v: OneClickStage) => setStore({ oneClickStage: v });
  const setOneClickTaskSelection = (v: Record<OneClickTaskKey, boolean> | ((s: Record<OneClickTaskKey, boolean>) => Record<OneClickTaskKey, boolean>)) =>
    typeof v === "function" ? setStore((s) => ({ oneClickTaskSelection: v(s.oneClickTaskSelection) })) : setStore({ oneClickTaskSelection: v });
  const setOneClickSelectorOpen = (v: boolean | ((s: boolean) => boolean)) =>
    typeof v === "function" ? setStore((s) => ({ oneClickSelectorOpen: v(s.oneClickSelectorOpen) })) : setStore({ oneClickSelectorOpen: v });

  const activeScanIdRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const oneClickSelectorRef = useRef<HTMLDivElement | null>(null);
  const desktopBridgeReady = Boolean(window.cDriveCleaner);

  function requireDesktopApi(feature: string): NonNullable<Window["cDriveCleaner"]> | null {
    const api = window.cDriveCleaner;
    if (api) {
      return api;
    }
    flashNotice(`当前未连接桌面桥接，${feature}不可用`);
    return null;
  }

  function applyScanResult(payload: ScanResult): void {
    stopRequestedRef.current = false;
    setStore({
      previousScanStats: scanStats,
      engine: payload.engine,
      scanTree: payload.tree,
      largeFileRows: payload.largeFiles,
      scanStats: payload.stats,
      skippedPaths: payload.skipped.map((item) => item.path),
      scanError: null,
      scanState: "complete",
      scanElapsedMs: payload.stats.elapsedMs,
      scanProgress: {
        filesScanned: payload.stats.fileCount,
        directoriesScanned: payload.stats.directoryCount,
        bytesScanned: payload.stats.bytesScanned,
        currentPath: payload.tree.path,
        percent: 100
      }
    });
  }

  function applyMonitorSettings(settings: Record<string, unknown>): void {
    setSettingsMap(settings);
    if (typeof settings["monitor.enabled"] === "boolean") {
      setMonitorEnabled(settings["monitor.enabled"] as boolean);
    }
    if (typeof settings["monitor.dailyTime"] === "string") {
      setMonitorDailyTime(settings["monitor.dailyTime"] as string);
    }
    if (typeof settings["monitor.growthThresholdBytes"] === "number") {
      setMonitorThresholdBytes(settings["monitor.growthThresholdBytes"] as number);
    }
    if (typeof settings["monitor.growthThresholdPercent"] === "number") {
      setMonitorThresholdPercent(settings["monitor.growthThresholdPercent"] as number);
    }
    if (typeof settings["monitor.notifyToast"] === "boolean") {
      setMonitorNotifyToast(settings["monitor.notifyToast"] as boolean);
    }
    if (typeof settings["monitor.notifyLog"] === "boolean") {
      setMonitorNotifyLog(settings["monitor.notifyLog"] as boolean);
    }
    if (typeof settings["monitor.notifyInApp"] === "boolean") {
      setMonitorNotifyInApp(settings["monitor.notifyInApp"] as boolean);
    }
  }

  async function refreshMonitorData(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const [growth, alerts, fullAlerts] = await Promise.all([
        api.invoke<GrowthItem[]>("monitor:get-growth", { topN: 10 }),
        api.invoke<Alert[]>("monitor:get-alerts", { limit: 5 }),
        api.invoke<Alert[]>("monitor:get-alerts", { limit: 100 })
      ]);
      setMonitorGrowthRows(growth);
      setMonitorAlerts(alerts);
      setMonitorAlertHistory(fullAlerts);
    } catch {
      // monitor data read failure should not block other page interactions
    }
  }

  async function refreshHealthScore(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const score = await api.invoke<HealthScore>("health:get-score");
      setHealthScore(score);
    } catch {
      // ignore transient health score failures
    }
  }

  async function refreshMigrationStats(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const rows = await api.invoke<MigrateRecord[]>("migration:get-records", { limit: 200 });
      const active = rows.filter((item) => item.status !== "rolled_back");
      setMigrationStats({
        count: active.length,
        savedBytes: active.reduce((sum, item) => sum + Math.max(0, item.sizeBytes), 0)
      });
    } catch {
      // ignore migration stats failure
    }
  }

  async function refreshSettingsMeta(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const [meta, summary, loginStatus] = await Promise.all([
        api.invoke<{ name: string; version: string; description: string }>("app:get-meta"),
        api.invoke<{
          available: boolean;
          version: number;
          path?: string;
          appDir: string;
          rulesVersion: string;
          rulesLastUpdated: string | null;
          latestBackupAt: string | null;
        }>("app:get-db-summary"),
        api.invoke<{ openAtLogin: boolean; executableWillLaunchAtLogin: boolean }>("app:get-login-item-status")
      ]);
      setAppMeta(meta);
      setDbSummary(summary);
      setLoginItemStatus(loginStatus);
    } catch {
      // ignore metadata refresh errors
    }
  }

  async function updateSetting(key: string, value: unknown): Promise<void> {
    const api = requireDesktopApi("设置保存");
    if (!api) {
      return;
    }
    await api.invoke("settings:set", { key, value });
    setSettingsMap((current) => ({ ...current, [key]: value }));
    if (key === "tray.autoStart") {
      void refreshSettingsMeta();
    }
  }

  useEffect(() => {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }

    void api.invoke<{ engine: ScanEngine }>("scanner:get-engine").then((result) => setEngine(result.engine));
    void api.invoke<{ isAdmin: boolean }>("app:get-admin-status").then((result) => setAdminGranted(result.isAdmin));
    void api.invoke<Record<string, unknown>>("settings:get-all").then(applyMonitorSettings);
    void api.invoke<{ enabled: boolean; dailyTime?: string }>("monitor:get-status").then((result) => {
      setMonitorEnabled(result.enabled);
      if (typeof result.dailyTime === "string") {
        setMonitorDailyTime(result.dailyTime);
      }
    });
    void api.invoke<SystemInfo>("app:get-system-info").then((info) => {
      if (info.totalDisk > 0) {
        setSystemInfo(info);
      }
      if (info.drive) {
        setScanRootPath((current) => {
          const normalizedCurrent = normalizeScanRootPath(current);
          if (normalizedCurrent !== "C:\\") {
            return normalizedCurrent;
          }
          return driveRootFromLetter(info.drive);
        });
      }
    });
    void api.invoke<DriveInfo[]>("scanner:list-drives").then((drives) => {
      const usable = (drives ?? []).filter((drive) => drive.totalSize > 0);
      setScanDriveOptions(usable);
      if (usable.length === 0) {
        return;
      }
      setScanRootPath((current) => {
        const normalizedCurrent = normalizeScanRootPath(current);
        const currentLetter = normalizedCurrent.slice(0, 2).toUpperCase();
        if (usable.some((drive) => drive.letter.toUpperCase() === currentLetter)) {
          return normalizedCurrent;
        }
        return driveRootFromLetter(usable[0].letter);
      });
    }).catch(() => {
      setScanDriveOptions([]);
    });
    void api.invoke<ActivityLog[]>("app:get-activity-logs", { limit: 5 }).then((logs) => setActivityLogs(logs ?? []));
    void refreshMonitorData();
    void refreshHealthScore();
    void refreshMigrationStats();
    void refreshSettingsMeta();

    const offProgress = api.on<ScanProgress>("scanner:progress", (progress) => {
      setScanProgress(progress);
      setScanState((current) => current === "paused" ? current : "scanning");
      setScanStartedAt((current) => current ?? Date.now());
    });
    const offComplete = api.on<ScanResult>("scanner:complete", (payload) => {
      applyScanResult(payload);
    });
    const offDuplicateProgress = api.on<DuplicateProgress>("duplicate:progress", (payload) => {
      setDuplicateProgress(payload);
      setDuplicateState(payload.phase === "done" ? "complete" : "scanning");
    });
    const offDuplicateComplete = api.on<DuplicateScanResult>("duplicate:complete", (payload) => {
      setDuplicateResult(payload);
      setDuplicateState("complete");
      setDuplicateError(null);
      setDuplicateDeleteReport(null);
      setDuplicateKeepByHash(
        Object.fromEntries(
          payload.groups
            .filter((group) => group.files.length > 0)
            .map((group) => [group.hash, group.files[0] ?? ""])
        )
      );
    });
    const offNavigate = api.on<{ page?: string }>("app:navigate", (payload) => {
      const target = payload?.page;
      if (target === "overview" || target === "scan" || target === "duplicate" || target === "junk" || target === "migrate" || target === "monitor" || target === "settings") {
        setPage(target);
      }
    });
    const offMonitorStatus = api.on<{ enabled?: boolean; dailyTime?: string }>("monitor:status-changed", (payload) => {
      if (typeof payload.enabled === "boolean") {
        setMonitorEnabled(payload.enabled);
      }
      if (typeof payload.dailyTime === "string") {
        setMonitorDailyTime(payload.dailyTime);
      }
    });
    return () => {
      offProgress();
      offComplete();
      offDuplicateProgress();
      offDuplicateComplete();
      offNavigate();
      offMonitorStatus();
    };
  }, []);

  useEffect(() => {
    if (scanState !== "scanning" || scanStartedAt === null) {
      return;
    }
    const timer = window.setInterval(() => {
      setScanElapsedMs(Date.now() - scanStartedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [scanStartedAt, scanState]);

  useEffect(() => {
    if (page !== "monitor") {
      return;
    }
    void refreshMonitorData();
  }, [monitorDailyTime, monitorEnabled, monitorThresholdBytes, monitorThresholdPercent, page]);

  useEffect(() => {
    if (page !== "overview" && page !== "monitor") {
      return;
    }
    void refreshHealthScore();
  }, [largeFileRows.length, monitorGrowthRows.length, page]);

  useEffect(() => {
    if (page !== "overview" && page !== "migrate") {
      return;
    }
    void refreshMigrationStats();
  }, [page]);

  useEffect(() => {
    if (page !== "settings") {
      return;
    }
    void refreshSettingsMeta();
    const api = window.cDriveCleaner;
    if (api) {
      void api.invoke<Record<string, unknown>>("settings:get-all").then(applyMonitorSettings);
    }
  }, [page]);

  useEffect(() => {
    if (oneClickScanning) {
      return;
    }
    if (oneClickStage !== "done" && oneClickStage !== "error") {
      return;
    }
    const timer = window.setTimeout(() => setOneClickStage("idle"), 5200);
    return () => window.clearTimeout(timer);
  }, [oneClickScanning, oneClickStage]);

  useEffect(() => {
    if (!oneClickSelectorOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!target || !(target instanceof Node)) {
        return;
      }
      if (!oneClickSelectorRef.current?.contains(target)) {
        setOneClickSelectorOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [oneClickSelectorOpen]);

  const activeDriveInfo = useMemo(() => {
    const letter = normalizeScanRootPath(scanRootPath).slice(0, 2).toUpperCase();
    const match = scanDriveOptions.find((d) => d.letter.toUpperCase() === letter);
    if (match && match.totalSize > 0) {
      return { totalDisk: match.totalSize, freeDisk: match.freeSize, drive: match.letter, driveType: match.driveType };
    }
    return { totalDisk: systemInfo.totalDisk, freeDisk: systemInfo.freeDisk, drive: systemInfo.drive, driveType: systemInfo.driveType };
  }, [scanRootPath, scanDriveOptions, systemInfo]);

  const usedPercent = useMemo(() => {
    if (activeDriveInfo.totalDisk <= 0) {
      return 0;
    }
    const used = Math.max(0, activeDriveInfo.totalDisk - activeDriveInfo.freeDisk);
    return Math.min(100, Math.max(0, (used / activeDriveInfo.totalDisk) * 100));
  }, [activeDriveInfo]);

  async function startScan(options?: { navigate?: boolean }): Promise<boolean> {
    const targetRootPath = normalizeScanRootPath(scanRootPath);
    setScanRootPath(targetRootPath);
    const scanId = activeScanIdRef.current + 1;
    activeScanIdRef.current = scanId;
    stopRequestedRef.current = false;
    if (options?.navigate !== false) {
      setOneClickStage("idle");
      setPage("scan");
    }
    setScanState("scanning");
    setScanStats(null);
    setScanError(null);
    setScanStartedAt(Date.now());
    setScanElapsedMs(0);
    setScanProgress({ filesScanned: 0, bytesScanned: 0, currentPath: targetRootPath, percent: 0 });

    if (window.cDriveCleaner) {
      try {
        const preferredEngine = (settingsMap["scan.preferredEngine"] as "auto" | "everything" | "mft" | "walk") ?? "auto";
        const depthRaw = settingsMap["scan.depth"];
        const depthNum = depthRaw === "shallow" ? 1 : depthRaw === "deep" ? 5 : Number(depthRaw ?? 5);
        const WALK_MAX_DEPTH = 10;
        const isWalkEngine = preferredEngine === "walk";
        const maxDepth = depthNum === 0
          ? (isWalkEngine ? WALK_MAX_DEPTH : 999)
          : (isWalkEngine ? Math.min(depthNum, WALK_MAX_DEPTH) : depthNum);
        const largeFileThreshold = Number(settingsMap["scan.largeFileThreshold"] ?? 104857600);
        const result = await window.cDriveCleaner.invoke<ScanResult>("scanner:start", {
          path: targetRootPath,
          maxDepth,
          preferredEngine,
          largeFileThreshold
        });
        if (activeScanIdRef.current !== scanId) {
          return false;
        }
        applyScanResult(result);
        return true;
      } catch (error) {
        if (activeScanIdRef.current !== scanId) {
          return false;
        }
        const message = error instanceof Error ? error.message : "扫描失败";
        if (stopRequestedRef.current || /aborted/i.test(message)) {
          setScanState("stopped");
          setScanError(null);
          setScanStartedAt(null);
          return false;
        }
        setScanState("error");
        setScanError(message);
        return false;
      }
      return false;
    }

    setScanState("error");
    setScanError("桌面能力未连接，无法开始扫描");
    return false;
  }

  async function toggleScanPause(): Promise<void> {
    if (scanState !== "scanning" && scanState !== "paused") {
      return;
    }
    if (!window.cDriveCleaner) {
      setScanState((current) => current === "paused" ? "scanning" : "paused");
      return;
    }
    if (scanState === "paused") {
      const result = await window.cDriveCleaner.invoke<{ resumed: boolean }>("scanner:resume");
      if (result.resumed) {
        setScanState("scanning");
      }
      return;
    }
    const result = await window.cDriveCleaner.invoke<{ paused: boolean }>("scanner:pause");
    if (result.paused) {
      setScanState("paused");
    }
  }

  async function stopScan(): Promise<void> {
    if (scanState !== "scanning" && scanState !== "paused") {
      setWindowNotice("当前没有正在运行的扫描");
      window.setTimeout(() => setWindowNotice(null), 1600);
      return;
    }
    if (!window.cDriveCleaner) {
      stopRequestedRef.current = true;
      setScanState("stopped");
      setScanStartedAt(null);
      setWindowNotice("扫描已停止");
      window.setTimeout(() => setWindowNotice(null), 1600);
      return;
    }
    stopRequestedRef.current = true;
    const result = await window.cDriveCleaner.invoke<{ stopped: boolean }>("scanner:stop");
    if (result?.stopped) {
      setScanState("stopped");
      setScanError(null);
      setScanStartedAt(null);
      setWindowNotice("扫描已停止");
      window.setTimeout(() => setWindowNotice(null), 1600);
      return;
    }
    setWindowNotice("当前没有正在运行的扫描");
    window.setTimeout(() => setWindowNotice(null), 1600);
  }

  async function runJunkScan(options?: Partial<JunkScanOptions>): Promise<boolean> {
    const api = window.cDriveCleaner;
    if (!api) {
      setJunkScanState("error");
      setJunkScanError("桌面能力未连接，无法进行垃圾识别");
      return false;
    }

    setJunkScanState("scanning");
    setJunkScanError(null);
    try {
      const result = await api.invoke<JunkScanResult>("junk:scan", options ?? {});
      setJunkResult(result);
      setJunkScanState("complete");
      return true;
    } catch (error) {
      setJunkScanState("error");
      setJunkScanError(error instanceof Error ? error.message : "垃圾识别失败");
      return false;
    }
  }

  async function startDuplicateScan(opts?: { drives?: string[]; extensions?: string[]; navigate?: boolean }): Promise<boolean> {
    const api = requireDesktopApi("重复文件检测");
    if (!api) {
      setDuplicateState("error");
      setDuplicateError("未连接桌面桥接，无法启动重复文件检测");
      return false;
    }
    if (opts?.navigate !== false) {
      setPage("duplicate");
    }
    setDuplicateState("scanning");
    setDuplicateProgress(null);
    setDuplicateResult(null);
    setDuplicateError(null);
    setDuplicateDeleteReport(null);
    setDuplicateKeepByHash({});
    try {
      const payload = await api.invoke<DuplicateScanResult>("duplicate:start", {
        paths: opts?.drives ?? [normalizeScanRootPath(scanRootPath)],
        extensions: opts?.extensions,
        maxDepth: 8,
        minSize: 1,
        quickHashBytes: 4096,
        hashAlgorithm: "sha256"
      });
      setDuplicateResult(payload);
      setDuplicateState("complete");
      setDuplicateKeepByHash(
        Object.fromEntries(
          payload.groups
            .filter((group) => group.files.length > 0)
            .map((group) => [group.hash, group.files[0] ?? ""])
        )
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "重复文件扫描失败";
      if (/aborted/i.test(message)) {
        setDuplicateState("idle");
        return false;
      }
      setDuplicateState("error");
      setDuplicateError(message);
      return false;
    }
  }

  function toggleOneClickTask(taskKey: OneClickTaskKey): void {
    if (oneClickScanning) {
      return;
    }
    const enabledCount = oneClickTaskDefs.reduce((count, task) => count + (oneClickTaskSelection[task.key] ? 1 : 0), 0);
    if (oneClickTaskSelection[taskKey] && enabledCount <= 1) {
      flashNotice("一键扫描至少保留 1 个扫描项", 1500);
      return;
    }
    setOneClickTaskSelection((current) => ({ ...current, [taskKey]: !current[taskKey] }));
  }

  async function startOneClickScan(): Promise<void> {
    if (oneClickScanning) {
      return;
    }
    const selectedTasks = oneClickTaskDefs.filter((task) => oneClickTaskSelection[task.key]);
    if (selectedTasks.length === 0) {
      flashNotice("请至少选择一个扫描项", 1800);
      return;
    }
    setOneClickSelectorOpen(false);
    setOneClickScanning(true);
    setOneClickStage(selectedTasks[0].key);
    flashNotice(`一键扫描已开始：${selectedTasks.map((task) => task.label).join(" → ")}`, 2200);
    try {
      for (const task of selectedTasks) {
        setOneClickStage(task.key);
        const taskOk = task.key === "disk"
          ? await startScan({ navigate: false })
          : task.key === "junk"
            ? await runJunkScan(junkOptionsFromPreset("deep"))
            : await startDuplicateScan({ navigate: false });
        if (!taskOk) {
          setOneClickStage("error");
          flashNotice(`一键扫描中断：${task.label}未完成`, 2200);
          return;
        }
      }
      setOneClickStage("done");
      flashNotice(`一键扫描完成：已更新${selectedTasks.map((task) => task.short).join("、")}`, 2600);
    } catch (error) {
      setOneClickStage("error");
      flashNotice(error instanceof Error ? `一键扫描失败：${error.message}` : "一键扫描失败，请重试", 2400);
    } finally {
      setOneClickScanning(false);
    }
  }

  async function stopDuplicateScan(): Promise<void> {
    if (duplicateState !== "scanning") {
      flashNotice("当前没有正在运行的重复文件扫描", 1600);
      return;
    }
    const api = requireDesktopApi("重复文件检测");
    if (!api) {
      return;
    }
    const result = await api.invoke<{ stopped: boolean }>("duplicate:stop");
    if (result?.stopped) {
      setDuplicateState("idle");
      flashNotice("重复文件扫描已停止", 1600);
      return;
    }
    flashNotice("停止失败，请重试", 1600);
  }

  function setDuplicateKeep(hash: string, path: string): void {
    setDuplicateKeepByHash((current) => ({ ...current, [hash]: path }));
  }

  async function executeDuplicateDelete(): Promise<void> {
    if (!duplicateResult) {
      flashNotice("请先完成重复文件扫描", 1600);
      return;
    }

    const toDelete = duplicateResult.groups.flatMap((group) => {
      const keep = duplicateKeepByHash[group.hash] ?? group.files[0] ?? "";
      return group.files.filter((path) => path !== keep);
    });
    if (toDelete.length === 0) {
      flashNotice("没有可删除的重复文件", 1600);
      return;
    }

    const api = requireDesktopApi("重复文件删除");
    if (!api) {
      return;
    }

    const report = await api.invoke<DuplicateDeleteReport>("duplicate:delete", { paths: toDelete });
    setDuplicateDeleteReport(report);

    const failed = new Set(report.failures.map((item) => item.path));
    const removed = new Set(toDelete.filter((path) => !failed.has(path)));
    setDuplicateResult((current) => {
      if (!current) {
        return current;
      }
      const nextGroups = current.groups
        .map((group) => {
          const nextFiles = group.files.filter((path) => !removed.has(path));
          return {
            ...group,
            files: nextFiles,
            reclaimable: Math.max(0, nextFiles.length - 1) * group.size
          };
        })
        .filter((group) => group.files.length > 1);
      return {
        ...current,
        groups: nextGroups
      };
    });
    flashNotice(`重复文件清理完成：删除 ${report.deletedCount} 个，释放 ${formatBytes(report.bytesFreed)}`, 2200);
  }

  async function toggleMonitor(): Promise<void> {
    const api = requireDesktopApi("监控开关");
    if (!api) {
      return;
    }
    const next = !monitorEnabled;
    try {
      setMonitorEnabled(next);
      await api.invoke("monitor:toggle", { enabled: next });
      setSettingsMap((current) => ({ ...current, "monitor.enabled": next }));
    } catch {
      setMonitorEnabled(!next);
      flashNotice("监控开关更新失败，请重试");
      return;
    }
    void refreshMonitorData();
  }

  async function updateMonitorDailyTime(value: string): Promise<void> {
    if (!/^\d{2}:\d{2}$/.test(value)) {
      return;
    }
    setMonitorDailyTime(value);
    await updateSetting("monitor.dailyTime", value);
    void refreshMonitorData();
  }

  async function updateMonitorThresholdGb(gbValue: number): Promise<void> {
    const safeGb = Number.isFinite(gbValue) ? Math.max(0.1, Math.min(128, gbValue)) : 0.5;
    const nextBytes = Math.round(safeGb * 1024 * 1024 * 1024);
    setMonitorThresholdBytes(nextBytes);
    await updateSetting("monitor.growthThresholdBytes", nextBytes);
    void refreshMonitorData();
  }

  async function updateMonitorThresholdPercent(percentValue: number): Promise<void> {
    const nextPercent = Number.isFinite(percentValue) ? Math.max(1, Math.min(100, Math.round(percentValue))) : 10;
    setMonitorThresholdPercent(nextPercent);
    await updateSetting("monitor.growthThresholdPercent", nextPercent);
  }

  async function toggleMonitorNotifyMode(mode: "toast" | "log" | "inApp"): Promise<void> {
    if (mode === "toast") {
      const next = !monitorNotifyToast;
      setMonitorNotifyToast(next);
      await updateSetting("monitor.notifyToast", next);
      return;
    }
    if (mode === "log") {
      const next = !monitorNotifyLog;
      setMonitorNotifyLog(next);
      await updateSetting("monitor.notifyLog", next);
      return;
    }
    const next = !monitorNotifyInApp;
    setMonitorNotifyInApp(next);
    await updateSetting("monitor.notifyInApp", next);
  }

  async function saveSetting(key: string, value: unknown): Promise<void> {
    await updateSetting(key, value);
    if (key.startsWith("monitor.")) {
      const api = window.cDriveCleaner;
      if (api) {
        void api.invoke<Record<string, unknown>>("settings:get-all").then(applyMonitorSettings);
      }
    }
    void refreshSettingsMeta();
  }

  async function apiRefreshActivityLogs(limit = 5): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const logs = await api.invoke<ActivityLog[]>("app:get-activity-logs", { limit });
      setActivityLogs(logs ?? []);
    } catch {
      // ignore activity refresh errors
    }
  }

  async function resetAllSettings(): Promise<void> {
    const confirmed = window.confirm("确定要重置所有设置为默认值吗？该操作不可撤销。");
    if (!confirmed) {
      return;
    }
    const api = requireDesktopApi("重置设置");
    if (!api) {
      return;
    }
    try {
      const all = await api.invoke<Record<string, unknown>>("settings:reset-defaults");
      if (all) {
        applyMonitorSettings(all);
      }
      await refreshSettingsMeta();
      flashNotice("已恢复默认设置");
    } catch {
      flashNotice("重置失败，请稍后重试");
    }
  }

  async function updateRulesNow(): Promise<void> {
    const api = requireDesktopApi("规则更新");
    if (!api) {
      return;
    }
    try {
      const result = await api.invoke<{ updated: boolean; message: string }>("rules:update-now");
      if (result?.message) {
        flashNotice(result.message, 2000);
      }
      await refreshSettingsMeta();
      try {
        const junk = await api.invoke<JunkScanResult>("junk:scan");
        setJunkResult(junk);
        setJunkScanState("complete");
        setJunkScanError(null);
      } catch {
        setJunkScanState("error");
        setJunkScanError("规则更新后重新识别失败");
      }
    } catch {
      flashNotice("规则库更新失败，请稍后重试");
    }
  }

  async function pickDefaultDirectory(defaultPath: string): Promise<string | null> {
    const api = requireDesktopApi("目录选择");
    if (!api) {
      return null;
    }
    try {
      const result = await api.invoke<{ canceled: boolean; path: string | null }>("settings:pick-directory", { defaultPath });
      if (result.canceled) {
        return null;
      }
      return result.path;
    } catch {
      return null;
    }
  }

  async function handlePermissionClick(): Promise<void> {
    if (adminGranted) {
      setPage("settings");
      return;
    }
    const api = requireDesktopApi("管理员授权");
    if (!api) {
      return;
    }
    await api.invoke("app:request-admin");
    flashNotice("已请求管理员权限，请确认系统弹窗后重启", 2400);
  }

  async function handleWindowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
    const api = requireDesktopApi("窗口控制");
    if (!api) {
      return;
    }

    try {
      if (action === "minimize") {
        if (api.window?.minimize) {
          await api.window.minimize();
        } else {
          await api.invoke("window:minimize");
        }
        return;
      }
      if (action === "maximize") {
        const result = api.window?.toggleMaximize
          ? await api.window.toggleMaximize()
          : await api.invoke<{ maximized?: boolean }>("window:toggle-maximize");
        const payload = result as { maximized?: boolean } | undefined;
        flashNotice(payload?.maximized ? "窗口已最大化" : "窗口已还原", 1200);
        return;
      }
      if (api.window?.close) {
        await api.window.close();
      } else {
        await api.invoke("window:close");
      }
    } catch {
      flashNotice("窗口控制执行失败，请重启应用后再试", 2200);
    }
  }

  const pageTitle = navItems.find((item) => item.id === page)?.label ?? "总览";
  const healthReady =
    healthScore.score > 0
    || healthScore.details.freePercent > 0
    || healthScore.details.junkPercent > 0
    || healthScore.details.largeFileSize > 0
    || healthScore.details.abnormalDirCount > 0
    || healthScore.details.fragmentPercent > 0;
  const oneClickTaskQueue = oneClickTaskDefs.filter((task) => oneClickTaskSelection[task.key]);
  const oneClickTaskTotal = oneClickTaskQueue.length;
  const activeTaskIndex = oneClickStage === "disk" || oneClickStage === "junk" || oneClickStage === "duplicate"
    ? oneClickTaskQueue.findIndex((task) => task.key === oneClickStage)
    : -1;
  const oneClickStepIndex = activeTaskIndex >= 0 ? activeTaskIndex + 1 : oneClickTaskTotal;
  const oneClickBusy =
    oneClickScanning
    || scanState === "scanning"
    || scanState === "paused"
    || junkScanState === "scanning"
    || duplicateState === "scanning";
  const topbarScanRoot = normalizeScanRootPath(scanRootPath);
  const topbarScanLetter = topbarScanRoot.slice(0, 2).toUpperCase();
  const activeTaskDef = activeTaskIndex >= 0 ? oneClickTaskQueue[activeTaskIndex] : null;
  const oneClickButtonLabel = oneClickScanning
    ? activeTaskDef
      ? `${activeTaskDef.short} ${oneClickStepIndex}/${Math.max(1, oneClickTaskTotal)}`
      : "一键扫描中..."
    : "一键扫描";

  return (
    <div className="window">
      <div className="traffic" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="traffic-btn"
          aria-label="最小化"
          title="最小化"
          onClick={() => void handleWindowAction("minimize")}
        >
          <Minimize2 size={15} />
        </button>
        <button
          type="button"
          className="traffic-btn"
          aria-label="最大化"
          title="最大化"
          onClick={() => void handleWindowAction("maximize")}
        >
          <Maximize2 size={15} />
        </button>
        <button
          type="button"
          className="traffic-btn close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void handleWindowAction("close")}
        >
          <X size={17} />
        </button>
      </div>
      {windowNotice && (
        <div className="window-notice" role="status">
          {windowNotice}
        </div>
      )}
      {!desktopBridgeReady && (
        <div className="window-notice" style={{ top: "78px", maxWidth: "420px" }} role="status">
          当前运行在网页预览模式，部分系统功能和窗口按钮不可用。请通过 `start-dev.bat` 启动桌面版。
        </div>
      )}

      <aside className="sidebar">
        <div className="brand">
          <div className="logo" aria-hidden />
          <div>
            <div className="brand-name">C-Drive Cleaner Lite</div>
            <div className="version">v{appMeta.version}</div>
          </div>
        </div>

        <nav className="nav" aria-label="主导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={22} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="health-card">
          <div className="health-row">
            <div className="shield">
              <ShieldCheck size={22} />
            </div>
            <div>
              <div className="health-title">系统健康</div>
              <div className={`health-good ${healthGradeClass(healthScore.grade)}`}>
                {healthReady ? `${healthGradeLabel(healthScore.grade)} ${healthScore.score}` : "待评估"}
              </div>
            </div>
          </div>
          <div className="health-sub">可用空间：{healthReady ? `${(healthScore.details.freePercent * 100).toFixed(1)}%` : "等待监控快照"}</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="status-strip" role="group" aria-label="应用状态">
            <button
              className="status-item"
              title={`当前扫描引擎：${engine === "walk" ? "os.walk 兜底" : engine}`}
              onClick={() => setPage("settings")}
            >
              <Database size={15} />
              <span>引擎</span>
              <b>{engine === "walk" ? "walk" : engine}</b>
            </button>
            <button
              className={`status-item ${adminGranted ? "ok" : "warn"}`}
              title={`管理员权限：${adminGranted ? "已授予" : "未授予"}`}
              onClick={() => void handlePermissionClick()}
            >
              <ShieldCheck size={15} />
              <span>权限</span>
              <b>{adminGranted ? "已授权" : "未授权"}</b>
            </button>
          </div>
          <label className={`topbar-drive ${oneClickBusy ? "disabled" : ""}`} title="选择扫描盘符">
            <span>扫描盘：</span>
            <select
              className="topbar-drive-select"
              value={topbarScanLetter}
              onChange={(event) => setScanRootPath(driveRootFromLetter(event.target.value))}
              disabled={oneClickBusy}
            >
              {scanDriveOptions.length > 0
                ? scanDriveOptions.map((drive) => (
                  <option key={drive.letter} value={drive.letter.toUpperCase()}>
                    {drive.letter.toUpperCase()}{drive.driveType === "hdd" ? " [HDD]" : ""}
                  </option>
                ))
                : <option value={topbarScanLetter}>{topbarScanLetter}</option>}
            </select>
          </label>
          <div className={`oneclick-config ${oneClickBusy ? "disabled" : ""}`} ref={oneClickSelectorRef}>
            <button
              type="button"
              className="secondary-btn small oneclick-config-btn"
              onClick={() => setOneClickSelectorOpen((current) => !current)}
              disabled={oneClickBusy}
              aria-haspopup="dialog"
              aria-expanded={oneClickSelectorOpen}
            >
              <CircleGauge size={15} />
              扫描项 {oneClickTaskTotal}/{oneClickTaskDefs.length}
            </button>
            {oneClickSelectorOpen && (
              <div className="oneclick-config-popover" role="dialog" aria-label="选择一键扫描项">
                {oneClickTaskDefs.map((task) => (
                  <label key={task.key} className="oneclick-config-option">
                    <input
                      type="checkbox"
                      checked={oneClickTaskSelection[task.key]}
                      onChange={() => toggleOneClickTask(task.key)}
                      disabled={oneClickBusy}
                    />
                    <span>{task.label}</span>
                  </label>
                ))}
                <div className="oneclick-config-hint">可多选，至少保留 1 项</div>
              </div>
            )}
          </div>
          <button className="primary-btn scan-action" onClick={() => void startOneClickScan()} disabled={oneClickBusy}>
            <Play size={18} />
            {oneClickButtonLabel}
          </button>
        </header>

        <section className="content" aria-label={pageTitle}>
          {page === "overview" && (
            <OverviewPage
              tree={scanTree}
              usedPercent={usedPercent}
              systemInfo={{ ...systemInfo, totalDisk: activeDriveInfo.totalDisk, freeDisk: activeDriveInfo.freeDisk, drive: activeDriveInfo.drive, driveType: activeDriveInfo.driveType ?? "unknown" }}
              activityLogs={activityLogs}
              junkResult={junkResult}
              largeFiles={largeFileRows}
              growthRows={monitorGrowthRows}
              migrationStats={migrationStats}
              scanRootPath={scanRootPath}
              scanState={scanState}
              scanProgress={scanProgress}
              scanStats={scanStats}
              scanElapsedMs={scanElapsedMs}
              oneClickScanning={oneClickScanning}
              oneClickStage={oneClickStage}
              oneClickTaskQueue={oneClickTaskQueue.map((task) => task.key)}
              junkScanState={junkScanState}
              duplicateState={duplicateState}
              duplicateProgress={duplicateProgress}
              onNavigate={setPage}
              onQuickCleanup={() => {
                setPage("junk");
                if (!junkResult && junkScanState !== "scanning") {
                  void runJunkScan();
                }
              }}
              onScan={() => void startScan()}
            />
          )}
          {page === "scan" && (
            <ScanPage
              driveType={systemInfo.driveType}
              tree={scanTree}
              scanRootPath={scanRootPath}
              scanDriveOptions={scanDriveOptions}
              scanState={scanState}
              scanProgress={scanProgress}
              scanStats={scanStats}
              previousScanStats={previousScanStats}
              scanElapsedMs={scanElapsedMs}
              scanError={scanError}
              largeFiles={largeFileRows}
              skippedPaths={skippedPaths}
              onScanRootPathChange={(path) => setScanRootPath(normalizeScanRootPath(path))}
              onStart={() => void startScan()}
              onPauseResume={() => void toggleScanPause()}
              onStop={() => void stopScan()}
            />
          )}
          {page === "duplicate" && (
            <DuplicatePage
              driveOptions={scanDriveOptions}
              duplicateState={duplicateState}
              duplicateProgress={duplicateProgress}
              duplicateResult={duplicateResult}
              duplicateError={duplicateError}
              duplicateKeepByHash={duplicateKeepByHash}
              duplicateDeleteReport={duplicateDeleteReport}
              defaultDriveLetter={scanRootPath.slice(0, 2)}
              onStart={(o) => void startDuplicateScan({ drives: o.drives, extensions: o.extensions })}
              onStop={() => void stopDuplicateScan()}
              onKeepChange={setDuplicateKeep}
              onDelete={() => void executeDuplicateDelete()}
            />
          )}
          {page === "junk" && (
            <JunkPage
              junkResult={junkResult}
              scanState={junkScanState}
              scanError={junkScanError}
              onStartScan={(options) => void runJunkScan(options)}
              onOpenSettings={() => setPage("settings")}
            />
          )}
          {page === "migrate" && <MigratePage />}
          {page === "monitor" && (
            <MonitorPage
              monitorEnabled={monitorEnabled}
              monitorDailyTime={monitorDailyTime}
              monitorThresholdBytes={monitorThresholdBytes}
              monitorThresholdPercent={monitorThresholdPercent}
              monitorNotifyToast={monitorNotifyToast}
              monitorNotifyLog={monitorNotifyLog}
              monitorNotifyInApp={monitorNotifyInApp}
              growthRows={monitorGrowthRows}
              alerts={monitorAlerts}
              alertHistory={monitorAlertHistory}
              healthScore={healthScore}
              onToggleMonitor={() => void toggleMonitor()}
              onDailyTimeChange={(value) => void updateMonitorDailyTime(value)}
              onThresholdGbChange={(value) => void updateMonitorThresholdGb(value)}
              onThresholdPercentChange={(value) => void updateMonitorThresholdPercent(value)}
              onToggleNotifyMode={(mode) => void toggleMonitorNotifyMode(mode)}
              onNavigate={setPage}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              monitorEnabled={monitorEnabled}
              adminGranted={adminGranted}
              settings={settingsMap}
              appMeta={appMeta}
              dbSummary={dbSummary}
              loginItemStatus={loginItemStatus}
              onToggleMonitor={() => void toggleMonitor()}
              onSettingChange={(key, value) => void saveSetting(key, value)}
              onUpdateRules={() => void updateRulesNow()}
              onResetSettings={() => void resetAllSettings()}
              onPickDirectory={(defaultPath) => pickDefaultDirectory(defaultPath)}
            />
          )}
        </section>

        <footer className="footer">
          <span>系统：{systemInfo.os} {systemInfo.build}</span>
          <span>实时监控：{monitorEnabled ? "已开启" : "已关闭"}</span>
          <span className="footer-right">
            索引状态：{junkScanState === "complete" ? "已识别" : junkScanState === "scanning" ? "识别中" : "未识别"}
          </span>
        </footer>
      </main>
    </div>
  );
}

export default App;
