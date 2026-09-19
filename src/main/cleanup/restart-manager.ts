import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { LockerProcess } from "../../shared/types";

const execFileAsync = promisify(execFile);
const MAX_DIRECTORY_PROBE_FILES = 256;
const RM_BATCH_SIZE = 64;

const RM_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[StructLayout(LayoutKind.Sequential)]
public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RM_PROCESS_INFO {
  public RM_UNIQUE_PROCESS Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]  public string strServiceShortName;
  public int ApplicationType;
  public uint AppStatus;
  public int TSSessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
}

public class RM {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvcs, string[] svcs);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint h, out uint pnNeeded, ref uint pnInfo, [In,Out] RM_PROCESS_INFO[] procs, ref uint reboot);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmShutdown(uint h, uint flags, IntPtr fn);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmRestart(uint h, int flags, IntPtr fn);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint h);
}
`.trim();

function buildFindPs(paths: string[]): string {
  const pathsJson = JSON.stringify(paths);
  return `
Add-Type @'
${RM_CS}
'@
$paths = '${pathsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$h = [uint32]0
$key = [System.Guid]::NewGuid().ToString("N").Substring(0,32)
if ([RM]::RmStartSession([ref]$h,0,$key) -ne 0){ Write-Output '[]'; exit }
try {
  if ([RM]::RmRegisterResources($h,[uint32]$paths.Count,$paths,0,$null,0,$null) -ne 0){ Write-Output '[]'; exit }
  $needed=[uint32]0; $cnt=[uint32]0; $reboot=[uint32]0
  [RM]::RmGetList($h,[ref]$needed,[ref]$cnt,$null,[ref]$reboot) | Out-Null
  if($needed -eq 0){ Write-Output '[]'; exit }
  $info = New-Object RM_PROCESS_INFO[] $needed; $cnt=$needed
  [RM]::RmGetList($h,[ref]$needed,[ref]$cnt,$info,[ref]$reboot) | Out-Null
  $out=@()
  for($i=0;$i -lt [int]$cnt;$i++){
    $p=$info[$i]
    $out+=@{pid=[int]$p.Process.dwProcessId;name=[string]$p.strAppName;restartable=[bool]$p.bRestartable}
  }
  $out | ConvertTo-Json -Compress
} finally { [RM]::RmEndSession($h) | Out-Null }
`.trim();
}

function buildShutdownPs(paths: string[], graceful: boolean): string {
  const pathsJson = JSON.stringify(paths);
  const flags = graceful ? 0 : 1;
  return `
Add-Type @'
${RM_CS}
'@
$paths = '${pathsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$h = [uint32]0
$key = [System.Guid]::NewGuid().ToString("N").Substring(0,32)
if ([RM]::RmStartSession([ref]$h,0,$key) -ne 0){ Write-Output 'error:session'; exit }
try {
  [RM]::RmRegisterResources($h,[uint32]$paths.Count,$paths,0,$null,0,$null) | Out-Null
  $r = [RM]::RmShutdown($h,${flags},[IntPtr]::Zero)
  Write-Output "ok:$r"
} finally { [RM]::RmEndSession($h) | Out-Null }
`.trim();
}

async function runPs(script: string): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

/** Find which processes are locking the given file paths. */
export async function findLockers(paths: string[]): Promise<LockerProcess[]> {
  if (process.platform !== "win32" || paths.length === 0) return [];
  try {
    const out = await runPs(buildFindPs(paths));
    if (!out || out === "[]" || out === "null") return [];
    const raw = JSON.parse(out) as Array<{ pid: number; name: string; restartable: boolean }>;
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((p) => ({ pid: p.pid, name: p.name || `PID ${p.pid}`, restartable: !!p.restartable, paths }));
  } catch {
    return [];
  }
}

async function collectDirectoryProbePaths(rootPath: string): Promise<string[]> {
  const root = resolve(rootPath).replace(/\//g, "\\");
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      return [root];
    }
  } catch {
    return [];
  }

  const candidates: Array<{ path: string; priority: number }> = [];
  const pending = [root];
  while (pending.length > 0 && candidates.length < MAX_DIRECTORY_PROBE_FILES * 2) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = `${current}\\${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      const priority = /\.(lock|db|sqlite|sqlite3|json|log|tmp)$/.test(lowerName) ? 0 : 1;
      candidates.push({ path: fullPath, priority });
    }
  }

  candidates.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  return candidates.slice(0, MAX_DIRECTORY_PROBE_FILES).map((item) => item.path);
}

/** Find processes locking files inside a directory. Restart Manager accepts files, not directories. */
export async function findLockersInDirectory(rootPath: string): Promise<LockerProcess[]> {
  const probePaths = await collectDirectoryProbePaths(rootPath);
  if (probePaths.length === 0) return [];

  const byPid = new Map<number, LockerProcess>();
  for (let index = 0; index < probePaths.length; index += RM_BATCH_SIZE) {
    const batch = probePaths.slice(index, index + RM_BATCH_SIZE);
    const lockers = await findLockers(batch);
    for (const locker of lockers) {
      const current = byPid.get(locker.pid);
      byPid.set(locker.pid, current
        ? { ...current, paths: [...new Set([...current.paths, ...locker.paths])] }
        : locker);
    }
  }
  return [...byPid.values()];
}

/** Gracefully shut down all processes locking the given paths via Restart Manager. */
export async function shutdownLockers(paths: string[], graceful = true): Promise<boolean> {
  if (process.platform !== "win32" || paths.length === 0) return false;
  try {
    const out = await runPs(buildShutdownPs(paths, graceful));
    return out.startsWith("ok:");
  } catch {
    return false;
  }
}

/** Gracefully shut down processes found locking files inside a directory. */
export async function shutdownLockersInDirectory(rootPath: string, graceful = true): Promise<boolean> {
  const lockers = await findLockersInDirectory(rootPath);
  if (lockers.length === 0) return false;
  const paths = [...new Set(lockers.flatMap((locker) => locker.paths))];
  return shutdownLockers(paths, graceful);
}
