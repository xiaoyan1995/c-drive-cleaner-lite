import { dialog, ipcMain } from "electron";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkDirectoryLock, executeMigration, rollbackMigration } from "../migration/redirector";
import { buildDefaultTargetPath, buildMigrationBrowseList, listMigrationDrives } from "../migration/planner";
import type { RecommendedDir } from "../../shared/types";
import type { IpcContext } from "./context";

/** Known high-value paths to boost in recommendations (no IO — matched against scan tree). */
function buildPrioritizedRecommendations(browseList: RecommendedDir[], limit: number): RecommendedDir[] {
  const home = homedir().toLowerCase();
  const local = join(home, "appdata", "local");
  const roaming = join(home, "appdata", "roaming");

  const PRIORITY_PREFIXES: Array<{ prefix: string; reason: string; score: number }> = [
    // AI / ML models — highest priority
    { prefix: join(home, ".cache", "huggingface"), reason: "HuggingFace 模型缓存，体积可达数十 GB", score: 100 },
    { prefix: join(local, "huggingface"),           reason: "HuggingFace 本地缓存", score: 100 },
    { prefix: join(home, ".cache", "modelscope"),   reason: "ModelScope 模型缓存", score: 100 },
    // Dev tool caches
    { prefix: join(local, "npm-cache"),             reason: "npm 全局缓存，可用 npm cache clean 重建", score: 99 },
    { prefix: join(roaming, "npm-cache"),           reason: "npm 全局缓存（旧路径）", score: 99 },
    { prefix: join(home, ".npm"),                   reason: "npm 缓存目录", score: 99 },
    { prefix: join(home, ".cargo", "registry"),     reason: "Cargo 依赖缓存，可重新下载", score: 99 },
    { prefix: join(home, ".cargo", "git"),          reason: "Cargo Git 源缓存", score: 99 },
    { prefix: join(local, "pip", "cache"),          reason: "pip 下载缓存", score: 99 },
    { prefix: join(home, ".nuget", "packages"),     reason: "NuGet 包缓存", score: 99 },
    { prefix: join(home, ".gradle", "caches"),      reason: "Gradle 构建缓存", score: 99 },
    { prefix: join(home, ".m2", "repository"),      reason: "Maven 本地仓库", score: 99 },
    { prefix: join(local, "yarn", "cache"),         reason: "Yarn 依赖缓存", score: 99 },
    // Browser caches
    { prefix: join(local, "google", "chrome"),      reason: "Chrome 浏览器数据（含缓存）", score: 95 },
    { prefix: join(local, "microsoft", "edge"),     reason: "Edge 浏览器数据（含缓存）", score: 95 },
    // IDE / Tools
    { prefix: join(local, "jetbrains"),             reason: "JetBrains IDE 索引与缓存", score: 90 },
    { prefix: join(roaming, "code", "cache"),       reason: "VS Code 缓存", score: 90 },
    { prefix: join(roaming, "code", "cacheddata"),  reason: "VS Code 扩展缓存", score: 90 },
    { prefix: join(local, "docker"),                reason: "Docker Desktop 数据", score: 88 },
    { prefix: join(home, ".rustup"),                reason: "Rust 工具链安装目录", score: 88 },
  ];

  const byPath = new Map(browseList.map((item) => [item.path.toLowerCase(), item]));
  const boosted: RecommendedDir[] = [];
  const boostedPaths = new Set<string>();

  const BOOST_MIN_BYTES = 500 * 1024 * 1024; // 500 MB minimum to earn a priority boost

  for (const { prefix, reason, score } of PRIORITY_PREFIXES) {
    for (const [key, item] of byPath) {
      if (key.startsWith(prefix) && !boostedPaths.has(key) && item.size >= BOOST_MIN_BYTES) {
        boosted.push({ ...item, score, reason });
        boostedPaths.add(key);
      }
    }
  }

  // Sort boosted by score desc then size desc, then append remaining by size
  boosted.sort((a, b) => b.score - a.score || b.size - a.size);
  const rest = browseList.filter((item) => !boostedPaths.has(item.path.toLowerCase()));

  return [...boosted, ...rest].slice(0, limit);
}

export function registerMigrationIpc(ctx: IpcContext): void {
  ipcMain.handle("migration:get-drives", async () => {
    const drives = await listMigrationDrives(ctx.getSystemDrive());
    return drives.filter((drive) => drive.totalSize > 0);
  });
  ipcMain.handle("migration:get-browse-list", async (_event, args?: { limit?: number }) => {
    const lastResult = ctx.getScannerService().getLastResult();
    if (!lastResult) return [] as RecommendedDir[];
    return buildMigrationBrowseList(lastResult.tree, args?.limit ?? 200);
  });
  ipcMain.handle("migration:get-recommendations", async (_event, args?: { limit?: number }) => {
    const lastResult = ctx.getScannerService().getLastResult();
    if (!lastResult) return [] as RecommendedDir[];
    const browseList = buildMigrationBrowseList(lastResult.tree, 200);
    return buildPrioritizedRecommendations(browseList, args?.limit ?? 50);
  });
  ipcMain.handle("migration:build-target-path", (_event, args?: {
    driveLetter?: string;
    sourcePath?: string;
    baseFolder?: string;
  }) => {
    const driveLetter = args?.driveLetter ?? "D:";
    const sourcePath = args?.sourcePath ?? "";
    const baseFolder = args?.baseFolder?.trim() || "CDrive_Moved_Data";
    return { targetPath: buildDefaultTargetPath(driveLetter, sourcePath, baseFolder) };
  });
  ipcMain.handle("migration:pick-directory", async (_event, args?: { defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      title: "选择要迁移的目录",
      defaultPath: args?.defaultPath ?? ctx.toDriveRootPath(ctx.getSystemDrive()),
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    return {
      canceled: result.canceled,
      path: result.filePaths[0] ?? null
    };
  });
  ipcMain.handle("migration:get-records", async (_event, args?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(200, args?.limit ?? 20));
    const db = ctx.getDbState();
    const rows = db?.queryAll<{
      id: number;
      source_path: string;
      target_path: string;
      size_bytes: number;
      file_count: number;
      migrated_at: string;
      status: string;
      backup_path: string | null;
      backup_action: string | null;
      last_checked: string | null;
    }>(
      "SELECT id, source_path, target_path, size_bytes, file_count, migrated_at, status, backup_path, backup_action, last_checked FROM migrate_records ORDER BY migrated_at DESC LIMIT ?",
      [limit]
    ) ?? [];
    return rows.map((row) => ({
      id: row.id,
      sourcePath: row.source_path,
      targetPath: row.target_path,
      sizeBytes: row.size_bytes,
      fileCount: row.file_count,
      migratedAt: row.migrated_at,
      status: row.status,
      backupPath: row.backup_path,
      backupAction: row.backup_action,
      lastChecked: row.last_checked
    }));
  });
  ipcMain.handle("migration:check-lock", async (_event, args?: { path?: string }) => {
    const sourcePath = args?.path?.trim();
    if (!sourcePath) {
      throw new Error("Missing path");
    }
    return checkDirectoryLock(sourcePath);
  });
  ipcMain.handle("migration:health-check", async (_event, args?: { recordId?: number }) => {
    await ctx.runMigrationHealthCheck();
    if (!args?.recordId) {
      return { healthy: true };
    }
    const db = ctx.getDbState();
    const row = db?.queryGet<{ status: string; source_path: string; target_path: string }>(
      "SELECT status, source_path, target_path FROM migrate_records WHERE id = ?",
      [args.recordId]
    );
    if (!row) {
      return { healthy: false, reason: "记录不存在" };
    }
    return {
      healthy: row.status === "active",
      reason: row.status === "active" ? undefined : "Junction 或目标目录异常",
      sourcePath: row.source_path,
      targetPath: row.target_path
    };
  });
  ipcMain.handle("migration:start", async (event, args?: {
    source?: string;
    target?: string;
    backupAction?: "delete_now" | "keep_days";
    backupDays?: number;
  }) => {
    const sourcePath = args?.source?.trim();
    const targetPath = args?.target?.trim();
    if (!sourcePath || !targetPath) {
      throw new Error("Missing source or target path");
    }

    const backupAction = args?.backupAction === "delete_now" ? "delete_now" : "keep_days";
    const backupDays = Math.max(1, Math.min(365, args?.backupDays ?? 7));
    const db = ctx.getDbState();

    const result = await executeMigration(
      {
        sourcePath,
        targetPath,
        backupAction,
        backupDays,
        checkProcessLock: db?.getSetting<boolean>("migrate.checkProcessLock") ?? true
      },
      (progress) => event.sender.send("migration:progress", progress)
    );

    db?.execute(
      "INSERT INTO migrate_records (source_path, target_path, size_bytes, file_count, migrated_at, status, backup_path, backup_action, last_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        result.sourcePath,
        result.targetPath,
        result.sourceSize,
        result.fileCount,
        new Date().toISOString(),
        "active",
        result.backupPath,
        backupAction,
        new Date().toISOString()
      ]
    );
    const record = db?.queryGet<{ id: number }>("SELECT id FROM migrate_records ORDER BY id DESC LIMIT 1");
    const payload = { ...result, recordId: record?.id ?? null };
    db?.addActivity(
      "migrate_complete",
      `迁移完成：${result.sourcePath} → ${result.targetPath}`,
      payload
    );
    event.sender.send("migration:complete", payload);
    return payload;
  });
  ipcMain.handle("migration:apply-backup-policy", async (_event, args?: {
    recordId?: number | null;
    backupPath?: string | null;
    action?: "delete_now" | "keep_days";
    keepDays?: number;
  }) => {
    const action = args?.action === "delete_now" ? "delete_now" : "keep_days";
    const keepDays = Math.max(1, Math.min(365, args?.keepDays ?? 7));
    const backupPath = args?.backupPath?.trim() ?? "";
    let bytesFreed = 0;
    const db = ctx.getDbState();

    if (backupPath.length > 0 && ctx.isDriveRootPath(backupPath)) {
      throw new Error("非法备份路径，拒绝处理");
    }

    if (action === "delete_now" && args?.recordId && args.recordId > 0) {
      const row = db?.queryGet<{ size_bytes: number }>(
        "SELECT size_bytes FROM migrate_records WHERE id = ?",
        [args.recordId]
      );
      bytesFreed = row?.size_bytes ?? 0;
    }
    if (action === "delete_now" && backupPath.length > 0) {
      await rm(backupPath, { recursive: true, force: true });
    }
    if (action === "keep_days" && backupPath.length > 0) {
      const scheduledAt = new Date(Date.now() + keepDays * 24 * 60 * 60 * 1000).toISOString();
      db?.execute(
        "INSERT INTO scheduled_cleanups (target_path, scheduled_at, created_at, status) VALUES (?, ?, ?, 'pending')",
        [backupPath, scheduledAt, new Date().toISOString()]
      );
    }

    if (args?.recordId && args.recordId > 0) {
      db?.execute(
        "UPDATE migrate_records SET backup_path = ?, backup_action = ?, last_checked = ? WHERE id = ?",
        [action === "delete_now" ? null : (backupPath || null), action, new Date().toISOString(), args.recordId]
      );
    }

    db?.addActivity(
      "migrate_backup_policy_applied",
      action === "delete_now"
        ? `迁移备份已立即删除，释放 ${Math.round(bytesFreed / 1024 / 1024)} MB`
        : `迁移备份计划保留 ${keepDays} 天`,
      { recordId: args?.recordId ?? null, backupPath: backupPath || null, action, keepDays }
    );

    return {
      applied: true,
      action,
      backupPath: action === "delete_now" ? null : (backupPath || null),
      keepDays,
      bytesFreed
    };
  });
  ipcMain.handle("migration:rollback", async (event, args?: { recordId?: number }) => {
    const recordId = args?.recordId;
    if (!recordId) {
      throw new Error("Missing record id");
    }
    const db = ctx.getDbState();
    const row = db?.queryGet<{
      id: number;
      source_path: string;
      target_path: string;
      status: string;
    }>(
      "SELECT id, source_path, target_path, status FROM migrate_records WHERE id = ?",
      [recordId]
    );
    if (!row) {
      throw new Error("迁移记录不存在");
    }
    if (row.status === "rolled_back") {
      return { success: true, alreadyRolledBack: true };
    }

    const result = await rollbackMigration(row.source_path, row.target_path, (progress) => {
      event.sender.send("migration:progress", progress);
    });
    db?.execute(
      "UPDATE migrate_records SET status = 'rolled_back', last_checked = ? WHERE id = ?",
      [new Date().toISOString(), recordId]
    );
    db?.addActivity(
      "migrate_rollback_complete",
      `迁移撤销完成：${row.source_path}`,
      { recordId, sourcePath: row.source_path, targetPath: row.target_path, result }
    );
    return result;
  });
}
