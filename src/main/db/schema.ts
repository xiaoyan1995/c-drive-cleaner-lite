export const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    used_size INTEGER NOT NULL,
    free_size INTEGER NOT NULL,
    dirs TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_taken_at ON snapshots(taken_at)`,
  `CREATE TABLE IF NOT EXISTS cleanup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executed_at TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    files_deleted INTEGER NOT NULL,
    bytes_freed INTEGER NOT NULL,
    files_failed INTEGER NOT NULL DEFAULT 0,
    details TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS migrate_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    migrated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    backup_path TEXT,
    backup_action TEXT,
    last_checked TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS scheduled_cleanups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_path TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    dir_path TEXT,
    delta_bytes INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT
  )`
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  "scan.depth": "5",
  "scan.largeFileThreshold": 104857600,
  "scan.maxLargeFiles": 200,
  "scan.preferredEngine": "mft",
  "scan.includeArchives": false,
  "cleanup.logRetentionDays": 7,
  "cleanup.defaultSelection": "recommended",
  "cleanup.riskConfirm": "high_only",
  "cleanup.createRestorePoint": true,
  "migrate.defaultTargetPath": "D:\\CDrive_Moved_Data",
  "migrate.backupRetentionDays": 7,
  "migrate.checkProcessLock": true,
  "monitor.enabled": true,
  "monitor.dailyTime": "08:30",
  "monitor.growthThresholdBytes": 524288000,
  "monitor.growthThresholdPercent": 10,
  "monitor.notifyToast": true,
  "monitor.notifyLog": true,
  "monitor.notifyInApp": true,
  "tray.minimizeToTray": false,
  "tray.closeToTray": false,
  "tray.scanAnimation": true,
  "tray.autoStart": false,
  "rules.version": "1.0.0",
  "rules.lastUpdated": null,
  "rules.remoteUrl": "https://raw.githubusercontent.com/xiaoyan1995/c-drive-cleaner/main/c-drive-cleaner/rules/junk-rules.json"
};
