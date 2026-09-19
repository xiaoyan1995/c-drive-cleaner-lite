import { app, dialog, ipcMain, Notification, shell } from "electron";
import { DEFAULT_SETTINGS } from "../db/schema";
import type { Alert, GrowthItem, HealthScore, Snapshot } from "../../shared/types";
import type { IpcContext } from "./context";

export function registerSettingsIpc(ctx: IpcContext): void {
  ipcMain.handle("settings:get-all", () => ctx.getDbState()?.getAllSettings() ?? {});
  ipcMain.handle("settings:set", (_event, args: { key: string; value: unknown }) => {
    const db = ctx.getDbState();
    db?.setSetting(args.key, args.value);
    if (args.key === "tray.autoStart") {
      ctx.applyAutoStartSetting(Boolean(args.value));
    }
    if (args.key === "monitor.enabled" || args.key === "monitor.dailyTime") {
      ctx.syncMonitorServiceWithSettings();
      ctx.getTray()?.setContextMenu(ctx.buildTrayMenu());
      return;
    }
    if (args.key.startsWith("monitor.")) {
      ctx.emitMonitorStatusChanged();
    }
  });
  ipcMain.handle("settings:reset-defaults", () => {
    const db = ctx.getDbState();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      db?.setSetting(key, value);
    }
    ctx.applyAutoStartSetting(Boolean(DEFAULT_SETTINGS["tray.autoStart"]));
    ctx.syncMonitorServiceWithSettings();
    ctx.getTray()?.setContextMenu(ctx.buildTrayMenu());
    return db?.getAllSettings() ?? {};
  });
  ipcMain.handle("settings:pick-directory", async (_event, args?: { defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      title: "选择默认目标目录",
      defaultPath: args?.defaultPath ?? "D:\\",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    return {
      canceled: result.canceled,
      path: result.filePaths[0] ?? null
    };
  });

  ipcMain.handle("app:get-meta", () => ({
    name: app.getName(),
    version: app.getVersion(),
    description: ctx.readPackageDescription()
  }));
  ipcMain.handle("app:get-db-summary", () => ctx.getDatabaseSummary());
  ipcMain.handle("app:get-login-item-status", () => {
    const info = app.getLoginItemSettings();
    return {
      openAtLogin: info.openAtLogin === true,
      executableWillLaunchAtLogin: info.executableWillLaunchAtLogin !== false
    };
  });
  ipcMain.handle("shell:show-in-folder", (_event, args: { path: string }) => {
    shell.showItemInFolder(args.path);
  });
}

export function registerMonitorIpc(ctx: IpcContext): void {
  ipcMain.handle("health:get-score", async (): Promise<HealthScore> => ctx.computeHealthScore());

  ipcMain.handle("monitor:get-status", () => {
    const db = ctx.getDbState();
    const enabled = db?.getSetting<boolean>("monitor.enabled") ?? true;
    const dailyTime = db?.getSetting<string>("monitor.dailyTime") ?? "08:30";
    const nextRunTime = ctx.computeNextMonitorRunTime(new Date(), dailyTime);
    return { enabled, nextRunTime, dailyTime };
  });
  ipcMain.handle("monitor:take-snapshot", async () => {
    const snapshot = await ctx.createSnapshot("manual");
    if (snapshot) {
      ctx.runGrowthAnalysisAndNotify("manual");
    }
    return snapshot;
  });
  ipcMain.handle("monitor:get-snapshots", (_event, args?: { days?: number }) => {
    return ctx.querySnapshots(args?.days ?? 7);
  });
  ipcMain.handle("monitor:get-dir-history", (_event, args?: { dirName?: string; days?: number }) => {
    const dirName = (args?.dirName ?? "").trim().toLowerCase();
    if (dirName.length === 0) {
      return [];
    }
    return ctx.querySnapshots(args?.days ?? 30).map((snapshot: Snapshot) => {
      const entry = snapshot.dirs.find((item) => item.name.toLowerCase() === dirName);
      return {
        takenAt: snapshot.takenAt,
        dirName: args?.dirName,
        size: entry?.size ?? 0
      };
    });
  });
  ipcMain.handle("monitor:get-growth", (_event, args?: { topN?: number }) => {
    const snapshots = ctx.querySnapshots(7);
    if (snapshots.length < 2) {
      return [] as GrowthItem[];
    }
    const latest = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    const db = ctx.getDbState();
    const threshold = db?.getSetting<number>("monitor.growthThresholdBytes") ?? 524288000;
    const topN = Math.max(1, Math.min(50, args?.topN ?? 10));
    return ctx.compareSnapshotsForGrowth(latest, previous, threshold, topN);
  });
  ipcMain.handle("monitor:get-alerts", (_event, args?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(100, args?.limit ?? 5));
    const db = ctx.getDbState();
    const rows = db?.queryAll<{
      id: number;
      created_at: string;
      severity: "warning" | "critical";
      title: string;
      description: string;
      dir_path: string | null;
      delta_bytes: number | null;
      is_read: number;
    }>(
      "SELECT id, created_at, severity, title, description, dir_path, delta_bytes, is_read FROM alerts ORDER BY created_at DESC LIMIT ?",
      [limit]
    ) ?? [];
    return rows.map<Alert>((row) => ({
      id: row.id,
      createdAt: row.created_at,
      severity: row.severity,
      title: row.title,
      description: row.description,
      dirPath: row.dir_path ?? undefined,
      deltaBytes: row.delta_bytes ?? undefined,
      isRead: row.is_read === 1
    }));
  });

  ipcMain.handle("monitor:toggle", (_event, args: { enabled: boolean }) => {
    const db = ctx.getDbState();
    db?.setSetting("monitor.enabled", args.enabled);
    ctx.getTray()?.setContextMenu(ctx.buildTrayMenu());
    if (Notification.isSupported() && args.enabled) {
      new Notification({
        title: "C-Drive Cleaner Lite",
        body: `每日监控已开启，将在 ${db?.getSetting<string>("monitor.dailyTime") ?? "08:30"} 自动记录 C 盘快照。`
      }).show();
    }
    if (args.enabled) {
      ctx.startMonitorService();
      void ctx.runScheduledMonitorSnapshot("toggle");
    } else {
      ctx.stopMonitorService();
    }
  });
}
