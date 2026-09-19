import { contextBridge, ipcRenderer } from "electron";

type Listener<T> = (payload: T) => void;

const allowedInvokeChannels = new Set([
  "app:get-activity-logs",
  "app:get-admin-status",
  "app:get-db-status",
  "app:get-db-summary",
  "app:get-login-item-status",
  "app:get-meta",
  "app:get-system-info",
  "app:quit",
  "app:request-admin",
  "cleanup:close-and-retry",
  "cleanup:execute",
  "cleanup:find-lockers",
  "cleanup:get-logs",
  "cleanup:preview",
  "duplicate:delete",
  "duplicate:get-last-result",
  "duplicate:start",
  "duplicate:stop",
  "health:get-score",
  "junk:get-icon",
  "junk:list-path",
  "junk:preload-registry",
  "junk:scan",
  "migration:apply-backup-policy",
  "migration:build-target-path",
  "migration:check-lock",
  "migration:get-browse-list",
  "migration:get-drives",
  "migration:get-recommendations",
  "migration:get-records",
  "migration:health-check",
  "migration:pick-directory",
  "migration:rollback",
  "migration:start",
  "monitor:get-alerts",
  "monitor:get-dir-history",
  "monitor:get-growth",
  "monitor:get-snapshots",
  "monitor:get-status",
  "monitor:take-snapshot",
  "monitor:toggle",
  "rules:create-custom",
  "rules:delete-custom",
  "rules:get-custom",
  "rules:import-custom",
  "rules:update-custom",
  "rules:update-now",
  "scanner:get-engine",
  "scanner:get-large-files",
  "scanner:get-last-result",
  "scanner:list-drives",
  "scanner:pause",
  "scanner:resume",
  "scanner:start",
  "scanner:stop",
  "settings:get-all",
  "settings:pick-directory",
  "settings:reset-defaults",
  "settings:set",
  "shell:show-in-folder",
  "window:close",
  "window:minimize",
  "window:toggle-maximize"
] as const);

const allowedReceiveChannels = new Set([
  "app:navigate",
  "cleanup:progress",
  "duplicate:complete",
  "duplicate:progress",
  "migration:complete",
  "migration:progress",
  "monitor:status-changed",
  "scanner:complete",
  "scanner:progress"
] as const);

function assertAllowed(channel: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

const api = {
  invoke<T>(channel: string, args?: unknown): Promise<T> {
    assertAllowed(channel, allowedInvokeChannels);
    return ipcRenderer.invoke(channel, args) as Promise<T>;
  },
  on<T>(channel: string, listener: Listener<T>): () => void {
    assertAllowed(channel, allowedReceiveChannels);
    const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
  window: {
    minimize: () => api.invoke("window:minimize"),
    toggleMaximize: () => api.invoke("window:toggle-maximize"),
    close: () => api.invoke("window:close")
  }
};

contextBridge.exposeInMainWorld("cDriveCleaner", api);
