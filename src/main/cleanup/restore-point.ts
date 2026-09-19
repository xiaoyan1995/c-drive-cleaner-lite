import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RestorePointResult {
  created: boolean;
  description: string;
  error?: string;
}

function formatRestorePointDescription(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `C-Drive Cleaner Lite 清理前 - ${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export async function createSystemRestorePoint(): Promise<RestorePointResult> {
  const description = formatRestorePointDescription();
  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Checkpoint-Computer -Description '${description}' -RestorePointType 'MODIFY_SETTINGS'`
      ],
      { windowsHide: true }
    );
    return {
      created: true,
      description
    };
  } catch (error) {
    return {
      created: false,
      description,
      error: error instanceof Error ? error.message : "unknown error"
    };
  }
}

