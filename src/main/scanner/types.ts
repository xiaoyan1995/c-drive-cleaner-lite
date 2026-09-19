import type { FileInfo, ScanEngine, ScanProgress, ScanResult, ScanSkipped } from "../../shared/types";

export interface ScanOptions {
  path: string;
  preferredEngine?: ScanEngine | "auto";
  allowFallback?: boolean;
  maxDepth?: number;
  largeFileThreshold?: number;
  maxLargeFiles?: number;
  estimatedBytes?: number;
}

export interface ScanControl {
  signal: AbortSignal;
  waitIfPaused: () => Promise<void>;
}

export interface WalkScanOptions extends Required<Omit<ScanOptions, "estimatedBytes" | "preferredEngine" | "allowFallback">> {
  estimatedBytes?: number;
}

export interface WalkScanContext {
  fileCount: number;
  directoryCount: number;
  bytesScanned: number;
  skipped: ScanSkipped[];
  largeFiles: FileInfo[];
  onProgress?: (progress: ScanProgress) => void;
  lastProgressAt: number;
  startedAt: number;
}

export interface DiskScanner {
  readonly engine: ScanEngine;
  scan: (
    options: ScanOptions,
    control: ScanControl,
    onProgress?: (progress: ScanProgress) => void
  ) => Promise<ScanResult>;
}
