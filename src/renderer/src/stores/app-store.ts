import { create } from "zustand";
import type {
  ActivityLog,
  Alert,
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
  ScanStats,
  SystemInfo
} from "../../../shared/types";
import type { DuplicateState, OneClickStage, OneClickTaskKey, PageId, ScanState } from "../types";

interface AppState {
  page: PageId;
  engine: ScanEngine;
  adminGranted: boolean;
  systemInfo: SystemInfo;
  healthScore: HealthScore;
  settingsMap: Record<string, unknown>;
  appMeta: { name: string; version: string; description: string };
  dbSummary: {
    available: boolean;
    version: number;
    path?: string;
    appDir: string;
    rulesVersion: string;
    rulesLastUpdated: string | null;
    latestBackupAt: string | null;
  };
  loginItemStatus: { openAtLogin: boolean; executableWillLaunchAtLogin: boolean } | null;
  updateStatus: { message: string; checkedAt?: string; phase?: string } | null;
  activityLogs: ActivityLog[];
  windowNotice: string | null;
  migrationStats: { count: number; savedBytes: number };

  scanState: ScanState;
  scanRootPath: string;
  scanDriveOptions: DriveInfo[];
  scanProgress: ScanProgress | null;
  scanTree: DirTree;
  scanStats: ScanStats | null;
  scanStartedAt: number | null;
  scanElapsedMs: number;
  scanError: string | null;
  previousScanStats: ScanStats | null;
  largeFileRows: FileInfo[];
  skippedPaths: string[];

  junkResult: JunkScanResult | null;
  junkScanState: "idle" | "scanning" | "complete" | "error";
  junkScanError: string | null;

  duplicateState: DuplicateState;
  duplicateProgress: DuplicateProgress | null;
  duplicateResult: DuplicateScanResult | null;
  duplicateError: string | null;
  duplicateKeepByHash: Record<string, string>;
  duplicateDeleteReport: DuplicateDeleteReport | null;

  monitorEnabled: boolean;
  monitorDailyTime: string;
  monitorThresholdBytes: number;
  monitorThresholdPercent: number;
  monitorNotifyToast: boolean;
  monitorNotifyLog: boolean;
  monitorNotifyInApp: boolean;
  monitorGrowthRows: GrowthItem[];
  monitorAlerts: Alert[];
  monitorAlertHistory: Alert[];

  oneClickScanning: boolean;
  oneClickStage: OneClickStage;
  oneClickTaskSelection: Record<OneClickTaskKey, boolean>;
  oneClickSelectorOpen: boolean;

  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  flashNotice: (message: string, timeoutMs?: number) => void;
}

const fallbackSystemInfo: SystemInfo = {
  os: "Windows",
  build: "未知",
  totalDisk: 0,
  freeDisk: 0,
  drive: "C:",
  driveType: "unknown"
};

const fallbackTree: DirTree = {
  path: "C:\\",
  name: "C:",
  size: 0,
  fileCount: 0,
  children: []
};

const fallbackHealthScore: HealthScore = {
  score: 0,
  grade: "warning",
  breakdown: {
    freeSpaceScore: 0,
    growthScore: 0,
    junkScore: 0,
    largeFileScore: 0,
    fragmentScore: 0
  },
  details: {
    freePercent: 0,
    abnormalDirCount: 0,
    junkPercent: 0,
    largeFileSize: 0,
    fragmentPercent: 0
  }
};

export const useAppStore = create<AppState>()((set) => ({
  page: "overview",
  engine: "walk",
  adminGranted: true,
  systemInfo: fallbackSystemInfo,
  healthScore: fallbackHealthScore,
  settingsMap: {},
  appMeta: { name: "C-Drive Cleaner Lite", version: "1.0.0", description: "系统盘空间清理与管理工具（扫描 / 垃圾清理 / 软链接迁移 / 重复文件 / 监控）。" },
  dbSummary: { available: true, version: 1, appDir: "", rulesVersion: "1.0.0", rulesLastUpdated: null, latestBackupAt: null },
  loginItemStatus: null,
  updateStatus: null,
  activityLogs: [],
  windowNotice: null,
  migrationStats: { count: 0, savedBytes: 0 },

  scanState: "idle",
  scanRootPath: "C:\\",
  scanDriveOptions: [],
  scanProgress: null,
  scanTree: fallbackTree,
  scanStats: null,
  scanStartedAt: null,
  scanElapsedMs: 0,
  scanError: null,
  previousScanStats: null,
  largeFileRows: [],
  skippedPaths: [],

  junkResult: null,
  junkScanState: "idle",
  junkScanError: null,

  duplicateState: "idle",
  duplicateProgress: null,
  duplicateResult: null,
  duplicateError: null,
  duplicateKeepByHash: {},
  duplicateDeleteReport: null,

  monitorEnabled: true,
  monitorDailyTime: "08:30",
  monitorThresholdBytes: 524288000,
  monitorThresholdPercent: 10,
  monitorNotifyToast: true,
  monitorNotifyLog: true,
  monitorNotifyInApp: true,
  monitorGrowthRows: [],
  monitorAlerts: [],
  monitorAlertHistory: [],

  oneClickScanning: false,
  oneClickStage: "idle",
  oneClickTaskSelection: { disk: true, junk: true, duplicate: false },
  oneClickSelectorOpen: false,

  set,
  flashNotice: (message: string, timeoutMs = 1800) => {
    set({ windowNotice: message });
    window.setTimeout(() => set({ windowNotice: null }), timeoutMs);
  }
}));

export { fallbackTree, fallbackSystemInfo, fallbackHealthScore };
