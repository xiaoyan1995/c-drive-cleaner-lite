import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { ScanEngine, ScanProgress, ScanResult } from "../../shared/types";
import { ScanEngineUnavailableError } from "./errors";
import type { DiskScanner, ScanControl, ScanOptions } from "./types";

const execFileAsync = promisify(execFile);

export interface MftAvailability {
  available: boolean;
  reason?: string;
}

interface HelperCommand {
  command: string;
  argsPrefix: string[];
}

function driveFromPath(path: string): string {
  const match = /^[a-zA-Z]:/.exec(path);
  return match ? match[0].toUpperCase() : "C:";
}

async function runFsutil(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("fsutil.exe", args, { windowsHide: true });
  return `${stdout}\n${stderr}`.trim();
}

async function hasDotnet(): Promise<boolean> {
  try {
    await execFileAsync("dotnet", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function helperExeCandidates(): string[] {
  const exe = "CDriveCleaner.MftReader.exe";
  return [
    join(process.cwd(), "native", "mft-reader", "bin", "Release", "net9.0", exe),
    join(process.cwd(), "native", "mft-reader", "bin", "Debug", "net9.0", exe),
    join(process.cwd(), "resources", "native", "mft-reader", exe),
    join(process.resourcesPath ?? "", "native", "mft-reader", exe)
  ];
}

async function resolveHelperCommand(): Promise<HelperCommand | null> {
  const exe = helperExeCandidates().find((candidate) => candidate && existsSync(candidate));
  if (exe) {
    return { command: exe, argsPrefix: [] };
  }

  const projectPath = join(process.cwd(), "native", "mft-reader", "CDriveCleaner.MftReader.csproj");
  if (existsSync(projectPath) && await hasDotnet()) {
    return { command: "dotnet", argsPrefix: ["run", "--project", projectPath, "--"] };
  }

  return null;
}

function parseProgressLine(line: string): ScanProgress | null {
  try {
    const payload = JSON.parse(line) as Partial<ScanProgress> & { type?: string };
    if (payload.type !== "progress") {
      return null;
    }
    return {
      filesScanned: Number(payload.filesScanned ?? 0),
      directoriesScanned: Number(payload.directoriesScanned ?? 0),
      bytesScanned: Number(payload.bytesScanned ?? 0),
      currentPath: String(payload.currentPath ?? ""),
      percent: Number(payload.percent ?? 0)
    };
  } catch {
    return null;
  }
}

function runHelper(
  helper: HelperCommand,
  args: string[],
  control?: ScanControl,
  onProgress?: (progress: ScanProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper.command, [...helper.argsPrefix, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stderrLineBuffer = "";
    let settled = false;

    const abort = (): void => {
      if (!settled) {
        child.kill();
      }
    };
    if (control?.signal && typeof control.signal.addEventListener === "function") {
      control.signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrLineBuffer += chunk;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseProgressLine(line);
        if (progress) {
          if (typeof onProgress === "function") {
            onProgress(progress);
          }
        }
      }
    });

    child.on("error", (error) => {
      settled = true;
      if (control?.signal && typeof control.signal.removeEventListener === "function") {
        control.signal.removeEventListener("abort", abort);
      }
      reject(error);
    });

    child.on("close", (code) => {
      settled = true;
      if (control?.signal && typeof control.signal.removeEventListener === "function") {
        control.signal.removeEventListener("abort", abort);
      }
      if (control?.signal.aborted) {
        reject(new Error("Scan aborted"));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `MFT helper exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export class MftDiskScanner implements DiskScanner {
  readonly engine: ScanEngine = "mft";

  constructor(private readonly isAdmin: () => boolean) {}

  async checkAvailability(path = "C:\\"): Promise<MftAvailability> {
    if (process.platform !== "win32") {
      return { available: false, reason: "MFT scanning is Windows-only" };
    }
    if (!this.isAdmin()) {
      return { available: false, reason: "Administrator permission is required" };
    }

    const drive = driveFromPath(path);
    try {
      const volumeInfo = await runFsutil(["fsinfo", "volumeinfo", drive]);
      if (!/\bNTFS\b/i.test(volumeInfo)) {
        return { available: false, reason: `${drive} is not NTFS` };
      }
      await runFsutil(["usn", "queryJournal", drive]);
      const helper = await resolveHelperCommand();
      if (!helper) {
        return { available: false, reason: "MFT helper is not built and dotnet runtime is unavailable" };
      }
      await runHelper(helper, ["probe", "--path", `${drive}\\`]);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "Failed to probe MFT/USN support"
      };
    }
  }

  async scan(
    options: ScanOptions,
    control: ScanControl,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const availability = await this.checkAvailability(options.path);
    if (!availability.available) {
      throw new ScanEngineUnavailableError(this.engine, availability.reason ?? "Not available");
    }

    const helper = await resolveHelperCommand();
    if (!helper) {
      throw new ScanEngineUnavailableError(this.engine, "MFT helper is unavailable");
    }

    await control.waitIfPaused();
    const tempDir = await mkdtemp(join(tmpdir(), "cdrive-mft-"));
    const outputPath = join(tempDir, "scan-result.json");

    try {
      await runHelper(
        helper,
        [
          "scan",
          "--path",
          options.path,
          "--max-depth",
          String(options.maxDepth ?? 2),
          "--large-file-threshold",
          String(options.largeFileThreshold ?? 100 * 1024 * 1024),
          "--max-large-files",
          String(options.maxLargeFiles ?? 50),
          "--output",
          outputPath
        ],
        control,
        onProgress
      );

      const raw = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
      const result = JSON.parse(raw) as ScanResult;
      return result;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
