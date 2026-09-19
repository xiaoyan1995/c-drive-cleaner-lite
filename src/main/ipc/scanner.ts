import { ipcMain } from "electron";
import type { FileInfo, SystemInfo } from "../../shared/types";
import { getSystemInfo, isRunningAsAdmin, requestAdminRelaunch } from "../system";
import { listMigrationDrives } from "../migration/planner";
import type { IpcContext } from "./context";

export function registerScannerIpc(ctx: IpcContext): void {
  ipcMain.handle("app:get-admin-status", () => ({ isAdmin: ctx.isAdmin() }));
  ipcMain.handle("app:request-admin", () => {
    requestAdminRelaunch();
    return { requested: true };
  });
  ipcMain.handle("app:get-system-info", async (): Promise<SystemInfo> => {
    return getSystemInfo(ctx.getSystemDrive());
  });
  ipcMain.handle("app:get-db-status", () => {
    const db = ctx.getDbState();
    return {
      available: db?.available ?? false,
      path: db?.path,
      version: db?.getDatabaseVersion() ?? 0,
      error: db?.error
    };
  });
  ipcMain.handle("app:get-activity-logs", (_event, args?: { limit?: number }) => ctx.getDbState()?.getActivity(args?.limit ?? 5) ?? []);

  ipcMain.handle("scanner:get-engine", async () => {
    const status = await ctx.getScannerService().refreshEngine(ctx.toDriveRootPath(ctx.getSystemDrive()));
    return { engine: status.engine, status };
  });
  ipcMain.handle("scanner:list-drives", async () => {
    const drives = await listMigrationDrives("");
    return drives.filter((drive) => drive.totalSize > 0);
  });
  ipcMain.handle("scanner:get-last-result", async () => {
    return ctx.getScannerService().getLastResult();
  });
  ipcMain.handle("scanner:start", async (event, args?: {
    path?: string;
    depth?: number;
    maxDepth?: number;
    preferredEngine?: string;
  }) => {
    const path = args?.path ?? ctx.toDriveRootPath(ctx.getSystemDrive());
    const result = await ctx.getScannerService().scan(
      {
        path,
        maxDepth: args?.maxDepth ?? args?.depth,
        preferredEngine: (args?.preferredEngine ?? "auto") as "auto"
      },
      (progress) => event.sender.send("scanner:progress", progress)
    );
    const db = ctx.getDbState();
    db?.addActivity("scan_complete", `磁盘扫描完成：${result.stats.fileCount} 文件`, {
      engine: result.engine,
      fileCount: result.stats.fileCount,
      bytesScanned: result.stats.bytesScanned,
      elapsedMs: result.stats.elapsedMs
    });
    event.sender.send("scanner:complete", result);
    return result;
  });
  ipcMain.handle("scanner:pause", () => ({ paused: ctx.getScannerService().pause() }));
  ipcMain.handle("scanner:resume", () => ({ resumed: ctx.getScannerService().resume() }));
  ipcMain.handle("scanner:stop", () => ({ stopped: ctx.getScannerService().stop() }));
  ipcMain.handle("scanner:get-large-files", async (_event, args?: {
    limit?: number;
    type?: FileInfo["type"] | "all";
    query?: string;
  }) => {
    const result = ctx.getScannerService().getLastResult();
    if (!result) {
      return [];
    }
    return ctx.queryLargeFiles(result.largeFiles, args);
  });

  ipcMain.handle("duplicate:get-last-result", async () => {
    return ctx.getDuplicateFinderService().getLastResult();
  });
  ipcMain.handle("duplicate:start", async (event, args?: {
    path?: string;
    paths?: string[];
    maxDepth?: number;
    minSize?: number;
    extensions?: string[];
  }) => {
    const result = await ctx.getDuplicateFinderService().scan(
      {
        path: args?.path,
        paths: args?.paths,
        maxDepth: args?.maxDepth,
        minSize: args?.minSize,
        extensions: args?.extensions
      },
      (progress) => event.sender.send("duplicate:progress", progress)
    );
    const db = ctx.getDbState();
    db?.addActivity("duplicate_scan_complete", `重复文件扫描完成，发现 ${result.groups.length} 组`, {
      groups: result.groups.length,
      scannedFiles: result.scannedFiles,
      scannedBytes: result.scannedBytes,
      elapsedMs: result.elapsedMs
    });
    event.sender.send("duplicate:complete", result);
    return result;
  });
  ipcMain.handle("duplicate:stop", () => ({ stopped: ctx.getDuplicateFinderService().stop() }));
  ipcMain.handle("duplicate:delete", async (_event, args?: { paths?: string[] }) => {
    const report = await ctx.deleteDuplicateFiles(
      (args?.paths ?? []).filter((item): item is string => typeof item === "string" && item.length > 0)
    );
    const db = ctx.getDbState();
    db?.addActivity("duplicate_cleanup_complete", `重复文件清理：删除 ${report.deletedCount} 个`, {
      deletedCount: report.deletedCount,
      bytesFreed: report.bytesFreed
    });
    return report;
  });
}
