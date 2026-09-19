import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DirTree, DuplicateGroup, DuplicateProgress, DuplicateScanResult } from "../../shared/types";
import type { ScannerService } from "../scanner";

const DEFAULT_MAX_DEPTH = Number.POSITIVE_INFINITY;
const DEFAULT_MIN_SIZE = 1;
const DEFAULT_QUICK_HASH_BYTES = 65536; // 64 KB — better dedup signal than 4 KB
const DEFAULT_HASH_ALGORITHM = "md5";   // MD5 is 3x faster than SHA256; fine for dedup
const COLLECTING_WEIGHT = 20;
const QUICK_HASH_WEIGHT = 35;
const FULL_HASH_WEIGHT = 45;
const PROGRESS_EVERY_FILES = 500;
const STAT_CONCURRENCY = 64;  // parallel stat calls during collection
const HASH_CONCURRENCY = 8;   // parallel hash streams

/** Run up to `limit` async tasks concurrently from an iterable of task factories. */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}

interface DuplicateScanOptions {
  path?: string;
  paths?: string[];
  maxDepth?: number;
  minSize?: number;
  quickHashBytes?: number;
  hashAlgorithm?: "sha256" | "md5";
  extensions?: string[];
}

interface NormalizedOptions {
  paths: string[];
  maxDepth: number;
  minSize: number;
  quickHashBytes: number;
  hashAlgorithm: "sha256" | "md5";
  extensions: Set<string> | null;
}

interface FileCandidate {
  path: string;
  size: number;
}

interface ProgressState {
  scannedFiles: number;
  scannedBytes: number;
  candidateGroups: number;
  candidates: number;
  lastCollectingEmitAt: number;
}

class DuplicateScanControl {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    this.controller.abort();
  }
}

function normalizeOptions(options: DuplicateScanOptions, fallbackPath: string): NormalizedOptions {
  const rawPaths = options.paths ?? (options.path ? [options.path] : [fallbackPath]);
  const paths = rawPaths.filter((p) => typeof p === "string" && p.length > 0);
  const exts = options.extensions && options.extensions.length > 0
    ? new Set(options.extensions.map((e) => e.toLowerCase().replace(/^\./, "").trim()).filter(Boolean).map((e) => `.${e}`))
    : null;
  return {
    paths: paths.length > 0 ? paths : [fallbackPath],
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    minSize: Math.max(0, options.minSize ?? DEFAULT_MIN_SIZE),
    quickHashBytes: Math.max(64, options.quickHashBytes ?? DEFAULT_QUICK_HASH_BYTES),
    hashAlgorithm: options.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM,
    extensions: exts
  };
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Duplicate scan aborted");
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
}

function isPathInside(path: string, root: string): boolean {
  const p = normalizePathKey(path);
  const r = normalizePathKey(root);
  return p === r || p.startsWith(`${r}\\`);
}

function isSkippableReadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("eacces")
    || message.includes("eperm")
    || message.includes("ebusy")
    || message.includes("operation not permitted")
    || message.includes("permission denied")
    || message.includes("unknown: unknown error, read")
    || message.includes("resource busy");
}

function emitProgress(
  onProgress: ((progress: DuplicateProgress) => void) | undefined,
  state: ProgressState,
  payload: Pick<DuplicateProgress, "phase" | "currentPath" | "percent">
): void {
  onProgress?.({
    phase: payload.phase,
    scannedFiles: state.scannedFiles,
    scannedBytes: state.scannedBytes,
    candidateGroups: state.candidateGroups,
    candidates: state.candidates,
    currentPath: payload.currentPath,
    percent: Math.min(100, Math.max(0, payload.percent))
  });
}

async function hashFile(
  filePath: string,
  algorithm: "sha256" | "md5",
  signal: AbortSignal,
  quickBytes?: number
): Promise<string> {
  ensureActive(signal);
  return await new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = quickBytes
      ? createReadStream(filePath, { start: 0, end: Math.max(0, quickBytes - 1) })
      : createReadStream(filePath);

    const abort = (): void => {
      stream.destroy(new Error("Duplicate scan aborted"));
    };
    if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abort, { once: true });
    }

    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", (error) => {
      if (typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abort);
      }
      reject(error);
    });
    stream.on("end", () => {
      if (typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abort);
      }
      resolve(hash.digest("hex"));
    });
  });
}

/** Flatten a DirTree (from MFT/Everything scan) into FileCandidate[], skipping stat entirely. */
function flattenTreeFiles(tree: DirTree, options: NormalizedOptions, out: FileCandidate[]): void {
  if (tree.isFile) {
    if (tree.size >= options.minSize) {
      const dotExt = tree.path.slice(tree.path.lastIndexOf(".")).toLowerCase();
      if (options.extensions === null || options.extensions.has(dotExt)) {
        out.push({ path: tree.path, size: tree.size });
      }
    }
    return;
  }
  for (const child of tree.children ?? []) {
    flattenTreeFiles(child, options, out);
  }
}

/** Phase 1a: recursively walk dirs and collect all file paths (no stat — just opendir). */
async function gatherPaths(
  dirPath: string,
  depth: number,
  maxDepth: number,
  signal: AbortSignal,
  out: string[]
): Promise<void> {
  ensureActive(signal);
  let dir;
  try {
    dir = await opendir(dirPath);
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for await (const entry of dir) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) subdirs.push(entryPath);
    } else if (entry.isFile()) {
      out.push(entryPath);
    }
  }
  for (const sub of subdirs) {
    ensureActive(signal);
    await gatherPaths(sub, depth + 1, maxDepth, signal, out);
  }
}

/** Phase 1b: parallel-stat all paths and populate sizeGroups. */
async function statAndGroup(
  paths: string[],
  options: NormalizedOptions,
  signal: AbortSignal,
  state: ProgressState,
  sizeGroups: Map<number, FileCandidate[]>,
  onProgress?: (progress: DuplicateProgress) => void
): Promise<void> {
  await runConcurrent(paths, STAT_CONCURRENCY, async (filePath) => {
    ensureActive(signal);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }
    state.scannedFiles += 1;
    state.scannedBytes += fileStat.size;
    if (fileStat.size >= options.minSize) {
      if (options.extensions !== null) {
        const dotExt = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        if (!options.extensions.has(dotExt)) return;
      }
      const items = sizeGroups.get(fileStat.size) ?? [];
      items.push({ path: filePath, size: fileStat.size });
      sizeGroups.set(fileStat.size, items);
    }
    if (state.scannedFiles - state.lastCollectingEmitAt >= PROGRESS_EVERY_FILES) {
      state.lastCollectingEmitAt = state.scannedFiles;
      emitProgress(onProgress, state, {
        phase: "collecting",
        currentPath: filePath,
        percent: Math.min(COLLECTING_WEIGHT, Math.round(state.scannedFiles / 1000))
      });
    }
  });
}

export class DuplicateFinderService {
  private activeControl: DuplicateScanControl | null = null;
  private lastResult: DuplicateScanResult | null = null;
  private readonly fallbackPath: string;
  private readonly scanner: ScannerService | null;

  constructor(fallbackPath: string, scanner: ScannerService | null = null) {
    this.fallbackPath = fallbackPath;
    this.scanner = scanner;
  }

  getLastResult(): DuplicateScanResult | null {
    return this.lastResult;
  }

  stop(): boolean {
    if (!this.activeControl) {
      return false;
    }
    this.activeControl.abort();
    return true;
  }

  async scan(
    rawOptions: DuplicateScanOptions,
    onProgress?: (progress: DuplicateProgress) => void
  ): Promise<DuplicateScanResult> {
    this.activeControl?.abort();
    const control = new DuplicateScanControl();
    this.activeControl = control;
    const signal = control.signal;
    const options = normalizeOptions(rawOptions, this.fallbackPath);
    const startedAt = Date.now();

    const state: ProgressState = {
      scannedFiles: 0,
      scannedBytes: 0,
      candidateGroups: 0,
      candidates: 0,
      lastCollectingEmitAt: 0
    };
    const sizeGroups = new Map<number, FileCandidate[]>();

    try {
      emitProgress(onProgress, state, {
        phase: "collecting",
        currentPath: options.paths[0] ?? "",
        percent: 0
      });

      // Phase 1 (fast path): use MFT/Everything scanner — gives path+size in one shot
      let usedFastPath = false;
      const cached = this.scanner?.getLastResult() ?? null;
      if (
        cached
        && options.paths.length === 1
        && isPathInside(options.paths[0] ?? "", cached.tree.path)
      ) {
        const scanPath = options.paths[0] ?? cached.tree.path;
        const candidates: FileCandidate[] = [];
        flattenTreeFiles(cached.tree, options, candidates);
        for (const c of candidates) {
          if (!isPathInside(c.path, scanPath)) {
            continue;
          }
          state.scannedFiles += 1;
          state.scannedBytes += c.size;
          const items = sizeGroups.get(c.size) ?? [];
          items.push(c);
          sizeGroups.set(c.size, items);
        }
        usedFastPath = true;
      }

      if (this.scanner) {
        try {
          for (const scanPath of options.paths) {
            if (usedFastPath) break;
            const result = await this.scanner.scan(
              { path: scanPath, preferredEngine: "auto", allowFallback: false, maxDepth: Number.POSITIVE_INFINITY, maxLargeFiles: 0 },
              onProgress ? (p) => emitProgress(onProgress, state, { phase: "collecting", currentPath: p.currentPath ?? scanPath, percent: Math.min(COLLECTING_WEIGHT - 1, p.percent ?? 0) }) : undefined,
              signal
            );
            const candidates: FileCandidate[] = [];
            flattenTreeFiles(result.tree, options, candidates);
            for (const c of candidates) {
              state.scannedFiles += 1;
              state.scannedBytes += c.size;
              const items = sizeGroups.get(c.size) ?? [];
              items.push(c);
              sizeGroups.set(c.size, items);
            }
            usedFastPath = true;
          }
        } catch {
          sizeGroups.clear();
          state.scannedFiles = 0;
          state.scannedBytes = 0;
        }
      }

      if (!usedFastPath) {
        // Phase 1a: gather all file paths (opendir only, no stat — very fast)
        const allPaths: string[] = [];
        for (const scanPath of options.paths) {
          await gatherPaths(scanPath, 0, options.maxDepth, signal, allPaths);
        }
        // Phase 1b: parallel stat + size-group (64 concurrent workers)
        await statAndGroup(allPaths, options, signal, state, sizeGroups, onProgress);
      }

      const initialCandidates = [...sizeGroups.values()].filter((group) => group.length >= 2);
      state.candidateGroups = initialCandidates.length;
      state.candidates = initialCandidates.reduce((sum, group) => sum + group.length, 0);
      if (initialCandidates.length === 0) {
        const empty: DuplicateScanResult = {
          groups: [],
          scannedFiles: state.scannedFiles,
          scannedBytes: state.scannedBytes,
          elapsedMs: Date.now() - startedAt
        };
        this.lastResult = empty;
        emitProgress(onProgress, state, {
          phase: "done",
          currentPath: options.paths[0] ?? "",
          percent: 100
        });
        return empty;
      }

      // Phase 2: quick-hash (parallel, HASH_CONCURRENCY workers)
      const allQuickFiles = initialCandidates.flat();
      const quickHashMap = new Map<string, { file: FileCandidate; digest: string }[]>();
      let quickProcessed = 0;
      await runConcurrent(allQuickFiles, HASH_CONCURRENCY, async (file) => {
        ensureActive(signal);
        let digest: string;
        try {
          digest = await hashFile(file.path, options.hashAlgorithm, signal, options.quickHashBytes);
        } catch (error) {
          if (signal.aborted) throw error;
          if (isSkippableReadError(error)) return;
          throw error;
        }
        const key = `${file.size}:${digest}`;
        const bucket = quickHashMap.get(key) ?? [];
        bucket.push({ file, digest });
        quickHashMap.set(key, bucket);
        quickProcessed += 1;
        emitProgress(onProgress, state, {
          phase: "quick-hash",
          currentPath: file.path,
          percent: COLLECTING_WEIGHT + Math.round((quickProcessed / state.candidates) * QUICK_HASH_WEIGHT)
        });
      });

      const quickCandidates = new Map<string, FileCandidate[]>();
      for (const [key, entries] of quickHashMap.entries()) {
        if (entries.length >= 2) {
          quickCandidates.set(key, entries.map((e) => e.file));
        }
      }

      // Phase 3: full-hash (parallel, HASH_CONCURRENCY workers)
      const fullHashGroups = new Map<string, FileCandidate[]>();
      const fullHashCandidates = [...quickCandidates.values()].flat();
      const totalFull = fullHashCandidates.length;
      let fullProcessed = 0;
      await runConcurrent(fullHashCandidates, HASH_CONCURRENCY, async (file) => {
        ensureActive(signal);
        let fullDigest: string;
        try {
          fullDigest = await hashFile(file.path, options.hashAlgorithm, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          if (isSkippableReadError(error)) return;
          throw error;
        }
        const key = `${file.size}:${fullDigest}`;
        const items = fullHashGroups.get(key) ?? [];
        items.push(file);
        fullHashGroups.set(key, items);
        fullProcessed += 1;
        emitProgress(onProgress, state, {
          phase: "full-hash",
          currentPath: file.path,
          percent: COLLECTING_WEIGHT + QUICK_HASH_WEIGHT + Math.round((fullProcessed / Math.max(1, totalFull)) * FULL_HASH_WEIGHT)
        });
      });

      const groups: DuplicateGroup[] = [...fullHashGroups.entries()]
        .filter(([, files]) => files.length >= 2)
        .map(([key, files]) => {
          const [sizeText, hash] = key.split(":");
          const size = Number(sizeText);
          const uniquePaths = [...new Set(files.map((file) => file.path))];
          return {
            hash,
            size,
            files: uniquePaths,
            reclaimable: Math.max(0, uniquePaths.length - 1) * size
          };
        })
        .sort((a, b) => b.reclaimable - a.reclaimable || b.size - a.size || a.hash.localeCompare(b.hash));

      const result: DuplicateScanResult = {
        groups,
        scannedFiles: state.scannedFiles,
        scannedBytes: state.scannedBytes,
        elapsedMs: Date.now() - startedAt
      };
      this.lastResult = result;
      emitProgress(onProgress, state, {
        phase: "done",
        currentPath: options.paths[0] ?? "",
        percent: 100
      });
      return result;
    } finally {
      if (this.activeControl === control) {
        this.activeControl = null;
      }
    }
  }
}
