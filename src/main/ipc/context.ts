import type { BrowserWindow, Rectangle, Tray } from "electron";
import type { DatabaseState } from "../db";
import type { ScannerService } from "../scanner";
import type { DuplicateFinderService } from "../large-files/duplicate";
import type { FileInfo } from "../../shared/types";

export interface IpcContext {
  getDbState(): DatabaseState | null;
  getMainWindow(): BrowserWindow | null;
  getTray(): Tray | null;
  getScannerService(): ScannerService;
  getMonitorScannerService(): ScannerService;
  getDuplicateFinderService(): DuplicateFinderService;
  isAdmin(): boolean;
  getSystemDrive(): string;
  toDriveRootPath(drive: string): string;
  showMainWindow(): void;
  buildTrayMenu(): Electron.Menu;
  emitMonitorStatusChanged(): void;

  queryLargeFiles(files: FileInfo[], args?: {
    limit?: number;
    type?: FileInfo["type"] | "all";
    query?: string;
    extension?: string;
  }): FileInfo[];

  isDriveRootPath(path: string): boolean;
  readPackageDescription(): string;
  getCustomRuleFilePath(): string;
  getActiveRuleFilePath(): string;
  getCommunityRuleFilePath(): string;

  startMonitorService(): void;
  stopMonitorService(): void;
  syncMonitorServiceWithSettings(): void;
  applyAutoStartSetting(enabled: boolean): void;

  computeHealthScore(): Promise<import("../../shared/types").HealthScore>;
  createSnapshot(trigger: string): Promise<import("../../shared/types").Snapshot | null>;
  querySnapshots(days: number): import("../../shared/types").Snapshot[];
  compareSnapshotsForGrowth(
    latest: import("../../shared/types").Snapshot,
    previous: import("../../shared/types").Snapshot,
    thresholdBytes: number,
    topN: number
  ): import("../../shared/types").GrowthItem[];
  computeNextMonitorRunTime(now: Date, dailyTime: string): string;
  runScheduledMonitorSnapshot(trigger: string): Promise<void>;
  runGrowthAnalysisAndNotify(trigger: "scheduled" | "manual"): import("../../shared/types").GrowthItem[];
  getDateKey(date?: Date): string;
  updateRuleLibraryFromRemote(manual: boolean): Promise<{ updated: boolean; message: string }>;
  getDatabaseSummary(): {
    available: boolean;
    version: number;
    path?: string;
    appDir: string;
    rulesVersion: string;
    rulesLastUpdated: string | null;
    latestBackupAt: string | null;
  };
  deleteDuplicateFiles(paths: string[]): Promise<import("../../shared/types").DuplicateDeleteReport>;
  loadCustomRules(): Promise<import("../junk/types").RawJunkRule[]>;
  saveCustomRules(rules: import("../junk/types").RawJunkRule[]): Promise<void>;
  sanitizeCustomRule(rule: import("../junk/types").RawJunkRule, fallbackId: string): import("../junk/types").RawJunkRule;
  runMigrationHealthCheck(): Promise<void>;

  restoreBoundsByWindow: WeakMap<BrowserWindow, Rectangle>;
}
