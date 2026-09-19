import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { release } from "node:os";
import type { SystemInfo } from "../shared/types";

const execFileAsync = promisify(execFile);

interface LogicalDiskRow {
  DeviceID?: string;
  Size?: number | string;
  FreeSpace?: number | string;
}

function normalizeDriveLetter(value: string | undefined, fallback = "C:"): string {
  const cleaned = (value ?? "").trim().replace(/[\\/]+$/, "").toUpperCase();
  if (/^[A-Z]:$/.test(cleaned)) {
    return cleaned;
  }
  if (/^[A-Z]$/.test(cleaned)) {
    return `${cleaned}:`;
  }
  return fallback;
}

export function getDefaultSystemDrive(): string {
  if (process.platform !== "win32") {
    return "C:";
  }
  return normalizeDriveLetter(process.env.SystemDrive, "C:");
}

function parseDiskNumber(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

async function getDriveType(driveLetter: string): Promise<"ssd" | "hdd" | "unknown"> {
  if (process.platform !== "win32") return "unknown";
  try {
    const letter = driveLetter.replace(/[:\\]/g, "").toUpperCase();
    const command = [
      `$d = Get-Partition -DriveLetter '${letter}' -ErrorAction SilentlyContinue;`,
      "if ($d) {",
      "  $mt = (Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object DeviceId -eq \"$($d.DiskNumber)\").MediaType;",
      "  if ($mt -eq 'SSD') { 'ssd' } elseif ($mt -eq 'HDD') { 'hdd' } else { 'unknown' }",
      "} else { 'unknown' }"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
    ], { timeout: 8000 });
    const result = stdout.trim().toLowerCase();
    if (result === "ssd" || result === "hdd") return result;
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function getSystemInfo(drive = getDefaultSystemDrive()): Promise<SystemInfo> {
  const resolvedDrive = normalizeDriveLetter(drive, getDefaultSystemDrive());
  if (process.platform !== "win32") {
    return {
      os: process.platform,
      build: release(),
      totalDisk: 0,
      freeDisk: 0,
      drive: resolvedDrive,
      driveType: "unknown"
    };
  }

  try {
    const command = [
      "$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='",
      resolvedDrive,
      "'\" | Select-Object DeviceID,Size,FreeSpace;",
      "$disk | ConvertTo-Json -Compress"
    ].join("");
    const [{ stdout }, driveType] = await Promise.all([
      execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
      ]),
      getDriveType(resolvedDrive)
    ]);
    const row = JSON.parse(stdout.trim()) as LogicalDiskRow;
    return {
      os: "Windows",
      build: release(),
      totalDisk: parseDiskNumber(row.Size, 0),
      freeDisk: parseDiskNumber(row.FreeSpace, 0),
      drive: normalizeDriveLetter(row.DeviceID, resolvedDrive),
      driveType
    };
  } catch {
    return {
      os: "Windows",
      build: release(),
      totalDisk: 0,
      freeDisk: 0,
      drive: resolvedDrive,
      driveType: "unknown"
    };
  }
}

export async function isRunningAsAdmin(): Promise<boolean> {
  if (process.platform !== "win32") {
    return typeof process.getuid === "function" ? process.getuid() === 0 : false;
  }

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
    ]);
    return stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function requestAdminRelaunch(): void {
  if (process.platform !== "win32") {
    return;
  }

  const exe = process.execPath.replace(/'/g, "''");
  const args = process.argv
    .slice(1)
    .filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--remote-debugging-port"))
    .map((arg) => `'${arg.replace(/'/g, "''")}'`)
    .join(", ");
  const argumentList = args.length > 0 ? ` -ArgumentList @(${args})` : "";
  const command = `Start-Process -FilePath '${exe}'${argumentList} -Verb RunAs`;
  void execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
}
