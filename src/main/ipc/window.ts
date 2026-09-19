import { BrowserWindow, ipcMain, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcContext } from "./context";

function getWindowFromEvent(event: IpcMainInvokeEvent, ctx: IpcContext): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? ctx.getMainWindow();
}

export function registerWindowIpc(ctx: IpcContext): void {
  ipcMain.handle("window:minimize", (event) => {
    const targetWindow = getWindowFromEvent(event, ctx);
    if (!targetWindow) {
      return { ok: false };
    }
    targetWindow.minimize();
    return { ok: true };
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const targetWindow = getWindowFromEvent(event, ctx);
    if (!targetWindow) {
      return { ok: false, maximized: false };
    }
    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
      return { ok: true, maximized: false };
    }
    targetWindow.maximize();
    return { ok: true, maximized: true };
  });

  ipcMain.handle("window:close", (event) => {
    const targetWindow = getWindowFromEvent(event, ctx);
    if (!targetWindow) {
      return { ok: false };
    }
    targetWindow.close();
    return { ok: true };
  });

  ipcMain.handle("app:quit", () => {
    app.quit();
    return { ok: true };
  });
}
