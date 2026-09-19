import { execFile, spawn } from "node:child_process";
import { access, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder, promisify } from "node:util";
import { findLockersInDirectory, shutdownLockersInDirectory } from "../cleanup/restart-manager";

const execFileAsync = promisify(execFile);

export type BackupAction = "delete_now" | "keep_days";

export type MigrateStepKey =
  | "check_lock"
  | "copy"
  | "verify_copy"
  | "rename_bak"
  | "create_junction"
  | "validate_junction"
  | "cleanup_backup";

export interface MigrateProgress {
  step: MigrateStepKey;
  stepIndex: number;
  stepName: string;
  percent: number;
  detail?: string;
}

export interface LockCheckResult {
  locked: boolean;
  processes: string[];
  processDetails: LockingProcess[];
}

export interface MigrateOptions {
  sourcePath: string;
  targetPath: string;
  backupAction: BackupAction;
  backupDays?: number;
  checkProcessLock?: boolean;
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
}

export interface RollbackResult {
  success: boolean;
  sourcePath: string;
  targetPath: string;
  restoredSize: number;
  restoredFiles: number;
}

interface DirectoryStats {
  fileCount: number;
  totalSize: number;
}

interface ProcessProbeRow {
  Name?: string;
  ProcessId?: number;
  ExecutablePath?: string;
}

interface LockingProcess {
  name: string;
  pid: number;
}

interface ProcessCloseResult {
  pid: number;
  name: string;
  status: "closed" | "skipped" | "still_running" | "error";
  error?: string;
}

const STEP_NAMES: Record<MigrateStepKey, string> = {
  check_lock: "检测目录占用",
  copy: "复制文件到目标位置",
  verify_copy: "验证文件完整性",
  rename_bak: "重命名原目录为 .bak",
  create_junction: "创建 Junction",
  validate_junction: "验证 Junction 可访问",
  cleanup_backup: "处理备份目录"
};

function emitProgress(
  callback: ((progress: MigrateProgress) => void) | undefined,
  step: MigrateStepKey,
  stepIndex: number,
  percent: number,
  detail?: string
): void {
  callback?.({
    step,
    stepIndex,
    stepName: STEP_NAMES[step],
    percent,
    detail
  });
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\//g, "\\").replace(/[\\]+$/, "");
}

function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(path);
}

function isSameOrNestedPath(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizePath(candidatePath).toLowerCase();
  const parent = normalizePath(parentPath).toLowerCase();
  return candidate === parent || candidate.startsWith(`${parent}\\`);
}

function describeRenameFailure(error: unknown, sourcePath: string): string {
  const fallbackMessage = error instanceof Error ? error.message : "未知错误";
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
  if (!["EPERM", "EACCES", "EBUSY"].includes(errorCode)) {
    return `无法将原目录重命名为 .bak：${fallbackMessage}`;
  }

  const codexHint = normalizePath(sourcePath).toLowerCase().endsWith("\\.codex")
    ? " 当前目录是 .codex，请先完全退出 Codex Desktop、Codex CLI 以及正在使用该目录的终端后再重试。"
    : " 请完全退出正在使用该目录的程序、终端、文件管理器窗口或后台服务后再重试。";
  return [
    `无法将原目录重命名为 .bak（${errorCode}），目录仍被占用或当前权限不允许重命名。`,
    "此步骤只是同一磁盘上的目录改名，不会复制出第二份数据，也不是因为 C 盘空间不足。",
    codexHint.trim(),
    `原始错误：${fallbackMessage}`
  ].join(" ");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function escSingleQuotedForPowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

function processLabel(processInfo: LockingProcess): string {
  return `${processInfo.name} (PID ${processInfo.pid})`;
}

export async function checkDirectoryLock(path: string): Promise<LockCheckResult> {
  const normalized = normalizePath(path);
  const processDetails: LockingProcess[] = [];

  try {
    const escaped = escSingleQuotedForPowerShell(normalized);
    const currentPid = process.pid;
    const command = [
      `$target='${escaped}';$currentPid=${currentPid};$isCodex=$target.ToLowerInvariant().EndsWith('\\.codex');`,
      "$all = @(Get-CimInstance Win32_Process);$parentByPid=@{};foreach($row in $all){$parentByPid[[int]$row.ProcessId]=[int]$row.ParentProcessId};$protected=@{};$protected[$PID]=$true;$cursor=$currentPid;while($cursor -gt 0 -and -not $protected.ContainsKey($cursor)){$protected[$cursor]=$true;if(-not $parentByPid.ContainsKey($cursor)){break};$cursor=$parentByPid[$cursor]};",
      "$rows = $all | ",
      "Where-Object { -not $protected.ContainsKey([int]$_.ProcessId) -and (( $_.CommandLine -and $_.CommandLine -like ('*' + $target + '*') ) -or ($isCodex -and $_.Name -match '^(codex|codex-code-mode-host|codex-plus-plus|codex-plus-plus-manager|node_repl)\\.exe$' -and ($_.Name -match '^(codex|codex-code-mode-host)\\.exe$' -or $_.ExecutablePath -match '\\\\OpenAI\\.Codex_|\\\\Codex\\+\\+\\'))) } | ",
      "Select-Object -First 40 Name,ProcessId,ExecutablePath;",
      "$rows | ConvertTo-Json -Compress"
    ].join("");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ]);
    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      const parsed = JSON.parse(trimmed) as ProcessProbeRow | ProcessProbeRow[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        const name = row.Name?.trim();
        const pid = row.ProcessId;
        if (!name || !pid || pid === process.pid) {
          continue;
        }
        if (!processDetails.some((item) => item.pid === pid)) {
          processDetails.push({ name, pid });
        }
      }
    }
  } catch {
    // ignore probe errors
  }

  if (processDetails.length === 0) {
    try {
      const restartManagerLockers = await findLockersInDirectory(normalized);
      for (const locker of restartManagerLockers) {
        if (/^(powershell|pwsh)\.exe$/i.test(locker.name)) {
          continue;
        }
        if (locker.pid === process.pid || processDetails.some((item) => item.pid === locker.pid)) {
          continue;
        }
        processDetails.push({ name: locker.name, pid: locker.pid });
      }
    } catch {
      // Restart Manager is best-effort; the process probe below remains available.
    }
  }

  // Write/delete probe can quickly expose obvious in-use or ACL errors.
  let probeFailed = false;
  const probeFile = join(normalized, `.cdc_probe_${Date.now()}.tmp`);
  try {
    await writeFile(probeFile, "probe", "utf8");
    await unlink(probeFile);
  } catch {
    probeFailed = true;
  }

  return {
    locked: processDetails.length > 0 || probeFailed,
    processes: processDetails.map(processLabel),
    processDetails
  };
}

async function closeLockingProcesses(processes: LockingProcess[]): Promise<ProcessCloseResult[]> {
  const pids = [...new Set(processes.map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  if (process.platform !== "win32" || pids.length === 0) {
    return [];
  }

  const script = `
$pids = @(${pids.join(",")})
$currentPid = ${process.pid}
$all = @(Get-CimInstance Win32_Process)
$parentByPid = @{}
foreach ($row in $all) { $parentByPid[[int]$row.ProcessId] = [int]$row.ParentProcessId }
$protectedPids = [System.Collections.Generic.HashSet[int]]::new()
$protectedPids.Add([int]$PID) | Out-Null
$cursor = $currentPid
while ($cursor -gt 0 -and $protectedPids.Add($cursor)) {
  if (-not $parentByPid.ContainsKey($cursor)) { break }
  $cursor = $parentByPid[$cursor]
}
$protected = @(
  "system","idle","registry","smss","csrss","wininit","winlogon","services",
  "lsass","svchost","fontdrvhost","dwm","explorer","c-drive cleaner lite"
)
$out = @()
foreach ($id in $pids) {
  try {
    if ($protectedPids.Contains([int]$id)) {
      $out += @{ pid = [int]$id; name = "protected ancestor"; status = "skipped"; error = "current process tree" }
      continue
    }
    $p = Get-Process -Id $id -ErrorAction Stop
    $name = [string]$p.ProcessName
    if ($protected -contains $name.ToLowerInvariant()) {
      $out += @{ pid = [int]$id; name = $name; status = "skipped"; error = "protected process" }
      continue
    }
    if ($p.MainWindowHandle -ne 0) {
      $null = $p.CloseMainWindow()
      Start-Sleep -Milliseconds 1500
    }
    $alive = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($alive) {
      Stop-Process -Id $id -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 500
    }
    $stillAlive = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($stillAlive) {
      $out += @{ pid = [int]$id; name = $name; status = "still_running" }
    } else {
      $out += @{ pid = [int]$id; name = $name; status = "closed" }
    }
  } catch {
    $out += @{ pid = [int]$id; name = "PID $id"; status = "error"; error = $_.Exception.Message }
  }
}
$out | ConvertTo-Json -Compress
`.trim();

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "[]" || trimmed === "null") {
      return [];
    }
    const parsed = JSON.parse(trimmed) as ProcessCloseResult | ProcessCloseResult[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法关闭占用进程";
    return pids.map((pid) => ({ pid, name: `PID ${pid}`, status: "error", error: message }));
  }
}

function closeResultSummary(results: ProcessCloseResult[]): string {
  const closed = results.filter((item) => item.status === "closed").map((item) => `${item.name} (PID ${item.pid})`);
  const skipped = results.filter((item) => item.status === "skipped").map((item) => `${item.name} (PID ${item.pid})`);
  const failed = results
    .filter((item) => item.status === "still_running" || item.status === "error")
    .map((item) => `${item.name} (PID ${item.pid})`);
  return [
    closed.length > 0 ? `已关闭 ${closed.join("、")}` : "",
    skipped.length > 0 ? `已跳过 ${skipped.join("、")}` : "",
    failed.length > 0 ? `未能关闭 ${failed.join("、")}` : ""
  ].filter(Boolean).join("；");
}

async function ensureDirectoryUnlocked(
  path: string,
  onProgress: ((progress: MigrateProgress) => void) | undefined,
  step: MigrateStepKey,
  stepIndex: number,
  detailPrefix: string
): Promise<void> {
  const lockState = await checkDirectoryLock(path);
  if (!lockState.locked) return;

  const details = lockState.processes.length > 0 ? `：${lockState.processes.join("、")}` : "";
  if (lockState.processDetails.length === 0) {
    throw new Error(`目录仍被占用${details}，暂时无法继续。请关闭相关程序、终端或文件管理器后重试`);
  }

  emitProgress(onProgress, step, stepIndex, 20, `${detailPrefix}，正在关闭 ${lockState.processes.join("、")}`);
  await shutdownLockersInDirectory(path, true);
  const closeResults = await closeLockingProcesses(lockState.processDetails);
  const closeSummary = closeResultSummary(closeResults);
  emitProgress(onProgress, step, stepIndex, 60, closeSummary || "已请求关闭占用进程");
  await delay(1500);

  const retryLockState = await checkDirectoryLock(path);
  if (retryLockState.locked) {
    const retryDetails = retryLockState.processes.length > 0 ? `：${retryLockState.processes.join("、")}` : "";
    throw new Error(`目录仍被占用${retryDetails}${closeSummary ? `（${closeSummary}）` : ""}，请关闭相关程序后重试`);
  }
}

async function collectDirectoryStats(rootPath: string): Promise<DirectoryStats> {
  const root = normalizePath(rootPath);
  const stack = [root];
  let fileCount = 0;
  let totalSize = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        fileCount += 1;
        totalSize += fileStat.size;
      }
    }
  }

  return { fileCount, totalSize };
}

async function runRoboCopy(
  sourcePath: string,
  targetPath: string,
  onProgress?: (percent: number, detail?: string) => void,
  totalFiles = 0
): Promise<void> {
  const source = normalizePath(sourcePath);
  const target = normalizePath(targetPath);
  const args = [
    source,
    target,
    "/E",
    "/COPY:DAT",
    "/DCOPY:DAT",
    "/R:1",
    "/W:1",
    "/XJ",
    "/NDL",
    "/NJH",
    "/NJS"
  ];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("robocopy.exe", args, { windowsHide: true });
    const outputDecoder = new TextDecoder("gb18030", { fatal: false });
    let tail = "";
    let readBuffer = "";
    let filesCopied = 0;
    let lastReportedPercent = 0;

    const readLine = (line: string): void => {
      const cleaned = line.trim();
      if (cleaned.length === 0) {
        return;
      }
      tail = `${tail}\n${cleaned}`.slice(-2000);
      // Per-file large-file progress (e.g. "  50%")
      const percentMatch = cleaned.match(/^\s*(\d{1,3})%\s*$/);
      if (percentMatch) {
        const raw = Number(percentMatch[1]);
        const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
        // Blend per-file % into overall progress
        const base = totalFiles > 0 ? Math.floor((filesCopied / totalFiles) * 100) : 0;
        const blended = totalFiles > 0 ? Math.min(99, Math.floor(base + (percent / 100) * (1 / totalFiles) * 100)) : percent;
        if (blended > lastReportedPercent) {
          lastReportedPercent = blended;
          onProgress?.(blended, `已复制 ${filesCopied.toLocaleString("zh-CN")} / ${totalFiles > 0 ? totalFiles.toLocaleString("zh-CN") : "?"} 个文件`);
        }
        return;
      }
      // File copy line: anything that looks like a file path being processed
      if (cleaned.length > 3 && !cleaned.startsWith("\\\\") && (cleaned.includes("\\") || cleaned.includes("."))) {
        filesCopied += 1;
        if (totalFiles > 0) {
          const percent = Math.min(99, Math.floor((filesCopied / totalFiles) * 100));
          if (percent > lastReportedPercent || filesCopied % 200 === 0) {
            lastReportedPercent = percent;
            onProgress?.(percent, `已复制 ${filesCopied.toLocaleString("zh-CN")} / ${totalFiles.toLocaleString("zh-CN")} 个文件`);
          }
        }
      }
    };

    const onData = (chunk: Buffer): void => {
      readBuffer += outputDecoder.decode(chunk, { stream: true });
      const lines = readBuffer.split(/\r?\n/);
      readBuffer = lines.pop() ?? "";
      for (const line of lines) {
        readLine(line);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      readBuffer += outputDecoder.decode();
      if (readBuffer.trim().length > 0) {
        readLine(readBuffer);
      }
      if (exitCode !== null && exitCode < 8) {
        onProgress?.(100, "复制阶段完成");
        resolvePromise();
        return;
      }
      const code = exitCode ?? 16;
      rejectPromise(new Error(`robocopy 失败（exit code ${code}）${tail ? `: ${tail.trim()}` : ""}`));
    });
  });
}

async function findBackupPath(sourcePath: string): Promise<string> {
  const normalizedSource = normalizePath(sourcePath);
  const base = `${normalizedSource}.bak`;
  if (!(await exists(base))) {
    return base;
  }
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const withTimestamp = `${base}-${suffix}`;
  if (!(await exists(withTimestamp))) {
    return withTimestamp;
  }
  let index = 2;
  while (await exists(`${withTimestamp}-${index}`)) {
    index += 1;
  }
  return `${withTimestamp}-${index}`;
}

async function removePathSafely(path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (isDriveRoot(normalized)) {
    throw new Error(`拒绝删除磁盘根路径：${normalized}`);
  }
  await rm(normalized, { recursive: true, force: true });
}

async function verifyJunction(sourcePath: string, targetPath: string): Promise<void> {
  const source = normalizePath(sourcePath);
  const target = normalizePath(targetPath);
  const sourceStat = await lstat(source);
  if (!sourceStat.isSymbolicLink() && !sourceStat.isDirectory()) {
    throw new Error("源路径不是可访问的目录/Junction");
  }
  if (sourceStat.isSymbolicLink()) {
    const linked = await readlink(source);
    if (!normalizePath(linked).toLowerCase().includes(normalizePath(target).toLowerCase())) {
      throw new Error("Junction 指向异常");
    }
  }

  const probeName = `.cdc_junction_probe_${Date.now()}.tmp`;
  const sourceProbe = join(source, probeName);
  const targetProbe = join(target, probeName);
  await writeFile(sourceProbe, "junction_probe", "utf8");
  await access(targetProbe);
  await unlink(sourceProbe);
}

export async function executeMigration(
  options: MigrateOptions,
  onProgress?: (progress: MigrateProgress) => void
): Promise<MigrateResult> {
  const sourcePath = normalizePath(options.sourcePath);
  const targetPath = normalizePath(options.targetPath);
  const checkLock = options.checkProcessLock ?? true;

  if (isDriveRoot(sourcePath)) {
    throw new Error("不能直接迁移磁盘根目录");
  }
  if (isDriveRoot(targetPath)) {
    throw new Error("目标路径不能是磁盘根目录");
  }
  if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error("源路径和目标路径不能相同");
  }
  if (isSameOrNestedPath(targetPath, sourcePath) || isSameOrNestedPath(sourcePath, targetPath)) {
    throw new Error("源路径和目标路径不能互相包含");
  }
  if (await exists(targetPath)) {
    throw new Error("目标目录已存在。为避免覆盖或回滚时误删已有文件，请选择一个尚不存在的新目录");
  }

  let targetCreatedByMigration = false;
  let sourceRenamed = false;
  let junctionCreated = false;
  let backupPath: string | null = null;

  emitProgress(onProgress, "check_lock", 0, 3, "正在统计源目录文件数...");
  const sourceStats = await collectDirectoryStats(sourcePath);
  emitProgress(onProgress, "check_lock", 0, 5, "准备检测目录占用");

  try {
    if (checkLock) {
      await ensureDirectoryUnlocked(sourcePath, onProgress, "check_lock", 0, "检测到占用");
    }
    emitProgress(onProgress, "check_lock", 0, 100, "未检测到占用，继续执行");

    emitProgress(onProgress, "copy", 1, 5, "开始复制目录");
    await mkdir(dirname(targetPath), { recursive: true });
    await mkdir(targetPath);
    targetCreatedByMigration = true;
    await runRoboCopy(sourcePath, targetPath, (percent, detail) =>
      emitProgress(onProgress, "copy", 1, percent, detail),
      sourceStats.fileCount
    );
    emitProgress(onProgress, "copy", 1, 100, "目录复制完成");

    emitProgress(onProgress, "verify_copy", 2, 25, "校验复制结果");
    const targetStats = await collectDirectoryStats(targetPath);
    if (sourceStats.fileCount !== targetStats.fileCount || sourceStats.totalSize !== targetStats.totalSize) {
      throw new Error(
        `复制校验失败：源(${sourceStats.fileCount} files/${sourceStats.totalSize} bytes) != 目标(${targetStats.fileCount} files/${targetStats.totalSize} bytes)`
      );
    }
    emitProgress(onProgress, "verify_copy", 2, 100, "文件数与总大小一致");

    if (checkLock) {
      await ensureDirectoryUnlocked(sourcePath, onProgress, "rename_bak", 3, "重命名前检测到占用");
    }
    emitProgress(onProgress, "rename_bak", 3, 30, "重命名原目录");
    backupPath = await findBackupPath(sourcePath);
    try {
      await rename(sourcePath, backupPath);
    } catch (error) {
      throw new Error(describeRenameFailure(error, sourcePath));
    }
    sourceRenamed = true;
    emitProgress(onProgress, "rename_bak", 3, 100, `已重命名为 ${basename(backupPath)}`);

    emitProgress(onProgress, "create_junction", 4, 35, "创建 Junction");
    await symlink(targetPath, sourcePath, "junction");
    junctionCreated = true;
    emitProgress(onProgress, "create_junction", 4, 100, "Junction 创建成功");

    emitProgress(onProgress, "validate_junction", 5, 45, "验证 Junction");
    await verifyJunction(sourcePath, targetPath);
    emitProgress(onProgress, "validate_junction", 5, 100, "Junction 验证通过");

    if (options.backupAction === "delete_now" && backupPath) {
      emitProgress(onProgress, "cleanup_backup", 6, 25, "删除备份目录");
      await removePathSafely(backupPath);
      backupPath = null;
      emitProgress(onProgress, "cleanup_backup", 6, 100, "备份目录已删除");
    }

    return {
      success: true,
      sourcePath,
      targetPath,
      backupPath,
      sourceSize: sourceStats.totalSize,
      fileCount: sourceStats.fileCount,
      bytesFreed: options.backupAction === "delete_now" ? sourceStats.totalSize : 0
    };
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : "迁移失败";
    // rollback
    try {
      if (junctionCreated && (await exists(sourcePath))) {
        await rm(sourcePath, { recursive: true, force: true });
      }
      if (sourceRenamed && backupPath && (await exists(backupPath)) && !(await exists(sourcePath))) {
        await rename(backupPath, sourcePath);
      }
      if (targetCreatedByMigration && (await exists(targetPath))) {
        await removePathSafely(targetPath);
      }
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
      throw new Error(`迁移失败：${originalMessage}；回滚异常：${rollbackMessage}`);
    }

    throw new Error(`迁移失败，已自动回滚：${originalMessage}`);
  }
}

export async function rollbackMigration(
  sourcePathInput: string,
  targetPathInput: string,
  onProgress?: (progress: MigrateProgress) => void
): Promise<RollbackResult> {
  const sourcePath = normalizePath(sourcePathInput);
  const targetPath = normalizePath(targetPathInput);
  emitProgress(onProgress, "check_lock", 0, 5, "准备撤销迁移");

  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isSymbolicLink()) {
    throw new Error("原路径不是 Junction，无法撤销");
  }

  const targetStats = await collectDirectoryStats(targetPath);
  emitProgress(onProgress, "copy", 1, 10, "移回目标目录数据");

  // Remove junction first so source path can be restored as normal directory.
  await rm(sourcePath, { recursive: true, force: true });
  await mkdir(sourcePath, { recursive: true });

  await runRoboCopy(targetPath, sourcePath, (percent, detail) =>
    emitProgress(onProgress, "copy", 1, percent, detail)
  );
  emitProgress(onProgress, "verify_copy", 2, 35, "验证回滚结果");
  const restoredStats = await collectDirectoryStats(sourcePath);
  if (restoredStats.fileCount !== targetStats.fileCount || restoredStats.totalSize !== targetStats.totalSize) {
    throw new Error("回滚验证失败：移回文件不完整");
  }
  emitProgress(onProgress, "verify_copy", 2, 100, "回滚文件校验通过");

  emitProgress(onProgress, "cleanup_backup", 3, 30, "清理目标路径数据");
  await removePathSafely(targetPath);
  emitProgress(onProgress, "cleanup_backup", 3, 100, "目标路径已清理");

  return {
    success: true,
    sourcePath,
    targetPath,
    restoredSize: restoredStats.totalSize,
    restoredFiles: restoredStats.fileCount
  };
}
