import { opendir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DirTree, FileInfo, FileType, ScanProgress, ScanResult } from "../../shared/types";
import type { DiskScanner, ScanControl, ScanOptions, WalkScanContext, WalkScanOptions } from "./types";

const DEFAULT_LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_LARGE_FILES = 50;
const PROGRESS_EVERY_FILES = 1000;

function normalizeOptions(options: ScanOptions): WalkScanOptions {
  return {
    path: options.path,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    largeFileThreshold: options.largeFileThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD,
    maxLargeFiles: options.maxLargeFiles ?? DEFAULT_MAX_LARGE_FILES,
    estimatedBytes: options.estimatedBytes
  };
}

function ensureActive(control: ScanControl): void {
  if (control.signal.aborted) {
    throw new Error("Scan aborted");
  }
}

function fileTypeFromName(name: string): FileType {
  const lower = name.toLowerCase();
  if (/\.(mp4|mov|mkv|avi|wmv|flv|webm)$/.test(lower)) {
    return "video";
  }
  if (/\.(zip|rar|7z|tar|gz|iso)$/.test(lower)) {
    return "archive";
  }
  if (/\.(exe|msi|msix|appx)$/.test(lower)) {
    return "installer";
  }
  if (/\.(log|dmp|etl)$/.test(lower)) {
    return "log";
  }
  if (/\.(jpg|jpeg|png|gif|webp|bmp|heic|svg)$/.test(lower)) {
    return "image";
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md)$/.test(lower)) {
    return "document";
  }
  return "other";
}

function pushLargeFile(context: WalkScanContext, file: FileInfo, maxLargeFiles: number): void {
  context.largeFiles.push(file);
  context.largeFiles.sort((a, b) => b.size - a.size);
  if (context.largeFiles.length > maxLargeFiles) {
    context.largeFiles.length = maxLargeFiles;
  }
}

function emitProgress(context: WalkScanContext, currentPath: string, estimatedBytes?: number): void {
  if (!context.onProgress) {
    return;
  }
  if (context.fileCount - context.lastProgressAt < PROGRESS_EVERY_FILES && context.fileCount !== 0) {
    return;
  }

  context.lastProgressAt = context.fileCount;
  const percent = estimatedBytes && estimatedBytes > 0
    ? Math.min(99, Math.round((context.bytesScanned / estimatedBytes) * 100))
    : 0;
  context.onProgress({
    filesScanned: context.fileCount,
    directoriesScanned: context.directoryCount,
    bytesScanned: context.bytesScanned,
    currentPath,
    percent
  });
}

async function scanDirectory(
  dirPath: string,
  depth: number,
  options: WalkScanOptions,
  control: ScanControl,
  context: WalkScanContext
): Promise<DirTree> {
  ensureActive(control);
  await control.waitIfPaused();

  const node: DirTree = {
    path: dirPath,
    name: basename(dirPath) || dirPath,
    size: 0,
    fileCount: 0,
    children: depth < options.maxDepth ? [] : undefined
  };

  context.directoryCount += 1;

  let dir;
  try {
    dir = await opendir(dirPath);
  } catch (error) {
    context.skipped.push({
      path: dirPath,
      reason: error instanceof Error ? error.message : "Cannot open directory"
    });
    return node;
  }

  try {
    for await (const entry of dir) {
      ensureActive(control);
      await control.waitIfPaused();

      const entryPath = join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        context.skipped.push({ path: entryPath, reason: "Skipped symbolic link or junction" });
        continue;
      }

      if (entry.isDirectory()) {
        const child = await scanDirectory(entryPath, depth + 1, options, control, context);
        node.size += child.size;
        node.fileCount = (node.fileCount ?? 0) + (child.fileCount ?? 0);
        if (node.children) {
          node.children.push(child);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const fileStat = await stat(entryPath);
        context.fileCount += 1;
        context.bytesScanned += fileStat.size;
        node.size += fileStat.size;
        node.fileCount = (node.fileCount ?? 0) + 1;

        if (fileStat.size >= options.largeFileThreshold) {
          pushLargeFile(
            context,
            {
              name: entry.name,
              path: entryPath,
              size: fileStat.size,
              modifiedAt: fileStat.mtime.toISOString(),
              type: fileTypeFromName(entry.name)
            },
            options.maxLargeFiles
          );
        }

        emitProgress(context, entryPath, options.estimatedBytes);
      } catch (error) {
        context.skipped.push({
          path: entryPath,
          reason: error instanceof Error ? error.message : "Cannot stat file"
        });
      }
    }
  } finally {
    node.children?.sort((a, b) => b.size - a.size);
  }

  return node;
}

export class WalkDiskScanner implements DiskScanner {
  readonly engine = "walk" as const;

  async scan(
    rawOptions: ScanOptions,
    control: ScanControl,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const options = normalizeOptions(rawOptions);
    const startedAt = Date.now();
    const context: WalkScanContext = {
      fileCount: 0,
      directoryCount: 0,
      bytesScanned: 0,
      skipped: [],
      largeFiles: [],
      onProgress,
      lastProgressAt: 0,
      startedAt
    };

    const tree = await scanDirectory(options.path, 0, options, control, context);
    const elapsed = Date.now() - startedAt;
    onProgress?.({
      filesScanned: context.fileCount,
      directoriesScanned: context.directoryCount,
      bytesScanned: context.bytesScanned,
      currentPath: options.path,
      percent: 100
    });

    return {
      engine: this.engine,
      tree,
      elapsed,
      skipped: context.skipped,
      largeFiles: context.largeFiles,
      stats: {
        fileCount: context.fileCount,
        directoryCount: context.directoryCount,
        bytesScanned: context.bytesScanned,
        largeFileCount: context.largeFiles.length,
        elapsedMs: elapsed,
        skippedCount: context.skipped.length
      }
    };
  }
}
