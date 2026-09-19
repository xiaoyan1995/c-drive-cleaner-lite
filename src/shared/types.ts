export type ScanEngine = "everything" | "mft" | "walk";

export interface DirTree {
  path: string;
  name: string;
  size: number;
  children?: DirTree[];
  fileCount?: number;
  isFile?: boolean;
}

export interface ScanProgress {
  filesScanned: number;
  bytesScanned: number;
  currentPath: string;
  percent: number;
  directoriesScanned?: number;
}

export interface ScanSkipped {
  path: string;
  reason: string;
}

export type FileType = "video" | "archive" | "installer" | "log" | "image" | "document" | "other";

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  type: FileType;
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  files: string[];
  reclaimable: number;
}

export interface DuplicateProgress {
  phase: "collecting" | "quick-hash" | "full-hash" | "done";
  scannedFiles: number;
  scannedBytes: number;
  candidateGroups: number;
  candidates: number;
  currentPath: string;
  percent: number;
}

export interface DuplicateScanResult {
  groups: DuplicateGroup[];
  scannedFiles: number;
  scannedBytes: number;
  elapsedMs: number;
}

export interface DuplicateDeleteReport {
  deletedCount: number;
  failedCount: number;
  bytesFreed: number;
  failures: Array<{ path: string; reason: string }>;
}

export interface ScanStats {
  fileCount: number;
  directoryCount: number;
  bytesScanned: number;
  largeFileCount: number;
  elapsedMs: number;
  skippedCount: number;
}

export interface ScanResult {
  engine: ScanEngine;
  tree: DirTree;
  elapsed: number;
  skipped: ScanSkipped[];
  largeFiles: FileInfo[];
  stats: ScanStats;
}

export type SafeLevel = "safe" | "caution" | "danger";
export type JunkCategory =
  | "system_cache"
  | "browser"
  | "app_cache"
  | "dev_cache"
  | "temp_files"
  | "recycle_bin"
  | "logs"
  | "update_residual"
  | "downloads";

export interface JunkItem {
  path: string;
  size: number;
  count?: number;
  ruleName: string;
  category: JunkCategory;
  safeLevel: SafeLevel;
  description: string;
  detectPath?: string;
}

export interface JunkGroup {
  category: JunkCategory;
  size: number;
  count: number;
  safeLevel: SafeLevel;
  items: JunkItem[];
}

export interface JunkScanResult {
  scannedAt: string;
  totalSize: number;
  totalCount: number;
  stats?: {
    safeSize: number;
    cautionSize: number;
    dangerSize: number;
    safeCount: number;
    cautionCount: number;
    dangerCount: number;
    totalSize: number;
    totalCount: number;
  };
  groups: JunkGroup[];
}

export interface CleanupTarget {
  path: string;
  size: number;
  safeLevel: SafeLevel;
  ruleName: string;
  category: JunkCategory;
}

export interface CleanupPlan {
  generatedAt: string;
  totalSize: number;
  totalCount: number;
  targets: CleanupTarget[];
}

export interface CleanupFailure {
  path: string;
  reason: string;
}

export interface LockerProcess {
  pid: number;
  name: string;
  restartable: boolean;
  paths: string[];
}

export interface CleanupReport {
  deletedCount: number;
  failedCount: number;
  bytesFreed: number;
  failures: CleanupFailure[];
  lockedFiles: string[];
  durationMs: number;
}

export interface CleanupProgress {
  total: number;
  processed: number;
  deleted: number;
  failed: number;
  currentPath: string;
  percent: number;
}

export interface CleanupLog {
  id: number;
  executedAt: string;
  operationType: string;
  filesDeleted: number;
  bytesFreed: number;
  filesFailed: number;
  details?: unknown;
}

export interface DriveInfo {
  letter: string;
  label: string;
  totalSize: number;
  freeSize: number;
  fsType: string;
  driveType?: "ssd" | "hdd" | "unknown";
}

export interface RecommendedDir {
  path: string;
  size: number;
  fileCount: number;
  dailyGrowth: number;
  score: number;
  reason: string;
}

export interface MigrateRecord {
  id: number;
  sourcePath: string;
  targetPath: string;
  sizeBytes: number;
  fileCount: number;
  migratedAt: string;
  status: "active" | "unhealthy" | "rolled_back";
  backupPath: string | null;
  backupAction: string | null;
  lastChecked: string | null;
}

export type MigrateStep =
  | "check_lock"
  | "copy"
  | "verify_copy"
  | "rename_bak"
  | "create_junction"
  | "validate_junction"
  | "cleanup_backup";

export interface MigrateProgress {
  step: MigrateStep;
  stepIndex: number;
  stepName: string;
  percent: number;
  detail?: string;
}

export interface MigrateResult {
  success: boolean;
  sourcePath: string;
  targetPath: string;
  backupPath: string | null;
  sourceSize: number;
  fileCount: number;
  bytesFreed: number;
  error?: string;
  recordId?: number | null;
}

export interface GrowthItem {
  dirName: string;
  prevSize: number;
  currSize: number;
  delta: number;
  rate: number;
  suggestion: string;
}

export interface SnapshotDir {
  name: string;
  size: number;
}

export interface Snapshot {
  id: number;
  takenAt: string;
  totalSize: number;
  usedSize: number;
  freeSize: number;
  dirs: SnapshotDir[];
}

export interface Alert {
  id: number;
  createdAt: string;
  severity: "warning" | "critical";
  title: string;
  description: string;
  dirPath?: string;
  deltaBytes?: number;
  isRead: boolean;
}

export interface HealthScore {
  score: number;
  grade: "excellent" | "good" | "warning" | "danger";
  breakdown: {
    freeSpaceScore: number;
    growthScore: number;
    junkScore: number;
    largeFileScore: number;
    fragmentScore: number;
  };
  details: {
    freePercent: number;
    abnormalDirCount: number;
    junkPercent: number;
    largeFileSize: number;
    fragmentPercent: number;
  };
}

export interface ActivityLog {
  id: number;
  timestamp: string;
  action: string;
  summary: string;
}

export interface SystemInfo {
  os: string;
  build: string;
  totalDisk: number;
  freeDisk: number;
  drive: string;
  driveType: "ssd" | "hdd" | "unknown";
}
