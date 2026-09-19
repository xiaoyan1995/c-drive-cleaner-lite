import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DirTree, FileInfo, FileType, ScanEngine, ScanProgress, ScanResult } from "../../shared/types";
import { ScanEngineUnavailableError } from "./errors";
import type { DiskScanner, ScanControl, ScanOptions } from "./types";

const execFileAsync = promisify(execFile);

export interface EverythingAvailability {
  available: boolean;
  cliPath?: string;
  installed: boolean;
  running: boolean;
  reason?: string;
}

interface TreeNode extends DirTree {
  children: TreeNode[];
}

interface RegistryEntry {
  displayName?: string;
  installLocation?: string;
  displayIcon?: string;
}

interface TreeBuildResult {
  root: TreeNode;
  directoryCount: number;
}

function fileTypeFromName(name: string): FileType {
  const lower = name.toLowerCase();
  if (/\.(mp4|mov|mkv|avi|wmv|flv|webm)$/.test(lower)) return "video";
  if (/\.(zip|rar|7z|tar|gz|iso)$/.test(lower)) return "archive";
  if (/\.(exe|msi|msix|appx)$/.test(lower)) return "installer";
  if (/\.(log|dmp|etl)$/.test(lower)) return "log";
  if (/\.(jpg|jpeg|png|gif|webp|bmp|heic|svg)$/.test(lower)) return "image";
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md)$/.test(lower)) return "document";
  return "other";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function registryEntryFromUnknown(value: unknown): RegistryEntry | null {
  if (!isRecord(value)) return null;
  const displayName = typeof value.DisplayName === "string" ? value.DisplayName : undefined;
  const installLocation = typeof value.InstallLocation === "string" ? value.InstallLocation : undefined;
  const displayIcon = typeof value.DisplayIcon === "string" ? value.DisplayIcon : undefined;
  if (!displayName && !installLocation && !displayIcon) return null;
  return { displayName, installLocation, displayIcon };
}

function cliPathFromDisplayIcon(displayIcon: string): string | null {
  const cleaned = displayIcon.replace(/^"|"$/g, "").replace(/,\d+$/, "");
  if (!cleaned || !/Everything(?:64)?\.exe$/i.test(cleaned)) {
    return null;
  }
  return join(dirname(cleaned), "es.exe");
}

async function getRegistryCandidates(): Promise<string[]> {
  const script = [
    "$paths = @(",
    "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ");",
    "Get-ItemProperty $paths -ErrorAction SilentlyContinue |",
    "Where-Object { $_.DisplayName -like '*Everything*' } |",
    "Select-Object DisplayName,InstallLocation,DisplayIcon |",
    "ConvertTo-Json -Compress"
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], { windowsHide: true });

    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    const entries = (Array.isArray(parsed) ? parsed : [parsed])
      .map(registryEntryFromUnknown)
      .filter((entry): entry is RegistryEntry => entry !== null);

    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.installLocation) {
        candidates.push(join(entry.installLocation, "es.exe"));
      }
      if (entry.displayIcon) {
        const fromIcon = cliPathFromDisplayIcon(entry.displayIcon);
        if (fromIcon) candidates.push(fromIcon);
      }
    }
    return unique(candidates);
  } catch {
    return [];
  }
}

function commonCliPaths(): string[] {
  const candidates = [
    "es.exe",
    "C:\\Program Files\\Everything\\es.exe",
    "C:\\Program Files (x86)\\Everything\\es.exe"
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "Everything", "es.exe"));
  }
  return candidates;
}

async function findCliPath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where.exe", ["es.exe"], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // Fall back to common install paths.
  }

  const candidates = unique([
    ...await getRegistryCandidates(),
    ...commonCliPaths()
  ]);
  return candidates.find((candidate) => candidate !== "es.exe" && existsSync(candidate));
}

async function isEverythingRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$process = Get-Process Everything,Everything64 -ErrorAction SilentlyContinue | Select-Object -First 1;",
        "$service = Get-Service Everything -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 1;",
        "if ($process -or $service) { 'running' }"
      ].join(" ")
    ], { windowsHide: true });
    return stdout.trim() === "running";
  } catch {
    return false;
  }
}

async function isEverythingInstalled(): Promise<boolean> {
  const cliPath = await findCliPath();
  if (cliPath) return true;
  return (await getRegistryCandidates()).length > 0;
}

function normalizeRootPath(path: string): string {
  return path.endsWith("\\") ? path : `${path}\\`;
}

function joinWindowsPath(parent: string, child: string): string {
  return parent.endsWith("\\") ? `${parent}${child}` : `${parent}\\${child}`;
}

function makeDir(path: string): TreeNode {
  return {
    path,
    name: basename(path) || path,
    size: 0,
    fileCount: 0,
    children: []
  };
}

function addFile(root: TreeNode, directories: Map<string, TreeNode>, file: FileInfo): void {
  if (!file.path.toLowerCase().startsWith(root.path.toLowerCase())) {
    return;
  }

  const relative = file.path.slice(root.path.length).replace(/^\\+/, "");
  const parts = relative.split("\\").filter(Boolean);
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const childPath = joinWindowsPath(node.path, part);
    const key = childPath.toLowerCase();
    let child = directories.get(key);
    if (!child) {
      child = makeDir(childPath);
      node.children.push(child);
      directories.set(key, child);
    }
    node = child;
  }

  node.size += file.size;
  node.fileCount = (node.fileCount ?? 0) + 1;
}

function finalizeTree(node: TreeNode): number {
  let total = node.size;
  let files = node.fileCount ?? 0;
  for (const child of node.children) {
    total += finalizeTree(child);
    files += child.fileCount ?? 0;
  }
  node.size = total;
  node.fileCount = files;
  node.children.sort((a, b) => b.size - a.size);
  return total;
}

function buildTree(rootPath: string, files: FileInfo[]): TreeBuildResult {
  const root = makeDir(rootPath);
  const directories = new Map<string, TreeNode>([[root.path.toLowerCase(), root]]);
  for (const file of files) {
    addFile(root, directories, file);
  }
  finalizeTree(root);
  return { root, directoryCount: directories.size };
}

function parseEverythingLine(line: string): FileInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\t/);
  const fullPath = parts[0];
  const size = Number(parts[1] ?? 0);
  if (!fullPath || !Number.isFinite(size)) {
    return null;
  }
  return {
    name: basename(fullPath),
    path: fullPath,
    size,
    modifiedAt: parts[2] ? new Date(parts[2]).toISOString() : new Date().toISOString(),
    type: fileTypeFromName(fullPath)
  };
}

export class EverythingDiskScanner implements DiskScanner {
  readonly engine: ScanEngine = "everything";
  private cliPath: string | null = null;

  async checkAvailability(): Promise<EverythingAvailability> {
    if (process.platform !== "win32") {
      return { available: false, installed: false, running: false, reason: "Everything is Windows-only" };
    }

    const cliPath = await findCliPath();
    const installed = Boolean(cliPath) || await isEverythingInstalled();
    if (!cliPath) {
      return {
        available: false,
        installed,
        running: false,
        reason: installed ? "Everything is installed, but es.exe CLI was not found" : "Everything is not installed"
      };
    }
    const running = await isEverythingRunning();
    if (!running) {
      return { available: false, installed: true, running: false, cliPath, reason: "Everything process/service is not running" };
    }

    this.cliPath = cliPath;
    return { available: true, installed: true, running: true, cliPath };
  }

  async scan(
    options: ScanOptions,
    control: ScanControl,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const availability = await this.checkAvailability();
    if (!availability.available || !availability.cliPath) {
      throw new ScanEngineUnavailableError(this.engine, availability.reason ?? "Not available");
    }

    const startedAt = Date.now();
    await control.waitIfPaused();
    const rootPath = normalizeRootPath(options.path);
    const query = `${rootPath}*`;
    const { stdout } = await execFileAsync(availability.cliPath, [
      "-path",
      query,
      "-size",
      "-date-modified",
      "-full-path-and-name"
    ], {
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true
    });

    if (control.signal.aborted) {
      throw new Error("Scan aborted");
    }
    await control.waitIfPaused();

    const files = stdout.split(/\r?\n/).map(parseEverythingLine).filter((file): file is FileInfo => file !== null);
    const largeFiles = files
      .filter((file) => file.size >= (options.largeFileThreshold ?? 100 * 1024 * 1024))
      .sort((a, b) => b.size - a.size)
      .slice(0, options.maxLargeFiles ?? 20);

    const { root, directoryCount } = buildTree(rootPath, files);

    onProgress?.({
      filesScanned: files.length,
      directoriesScanned: directoryCount,
      bytesScanned: root.size,
      currentPath: options.path,
      percent: 100
    });

    return {
      engine: this.engine,
      tree: root,
      elapsed: Date.now() - startedAt,
      skipped: [],
      largeFiles,
      stats: {
        fileCount: files.length,
        directoryCount,
        bytesScanned: root.size,
        largeFileCount: largeFiles.length,
        elapsedMs: Date.now() - startedAt,
        skippedCount: 0
      }
    };
  }
}
