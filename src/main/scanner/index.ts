import type { ScanEngine, ScanProgress, ScanResult } from "../../shared/types";
import { ScanEngineUnavailableError } from "./errors";
import { EverythingDiskScanner } from "./everything-engine";
import { MftDiskScanner } from "./mft-engine";
import { WalkDiskScanner } from "./walk-engine";
import type { DiskScanner, ScanOptions } from "./types";

class ActiveScanControl {
  readonly controller = new AbortController();
  private paused = false;
  private resume?: () => void;
  private pausePromise: Promise<void> | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.pausePromise = new Promise((resolve) => {
      this.resume = resolve;
    });
  }

  resumeScan(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.resume?.();
    this.resume = undefined;
    this.pausePromise = null;
  }

  abort(): void {
    this.resumeScan();
    this.controller.abort();
  }

  async waitIfPaused(): Promise<void> {
    if (this.paused && this.pausePromise) {
      await this.pausePromise;
    }
  }
}

export class ScannerService {
  private readonly everythingScanner = new EverythingDiskScanner();
  private readonly mftScanner: MftDiskScanner;
  private readonly walkScanner = new WalkDiskScanner();
  private activeControl: ActiveScanControl | null = null;
  private lastResult: ScanResult | null = null;
  private selectedEngine: ScanEngine = "walk";
  private lastFallbackReason: string | null = null;

  constructor(isAdmin: () => boolean) {
    this.mftScanner = new MftDiskScanner(isAdmin);
  }

  getEngine(): ScanEngine {
    return this.selectedEngine;
  }

  getStatus(): { engine: ScanEngine; fallbackReason: string | null } {
    return {
      engine: this.selectedEngine,
      fallbackReason: this.lastFallbackReason
    };
  }

  async refreshEngine(path = "C:\\"): Promise<{ engine: ScanEngine; fallbackReason: string | null }> {
    const engines = await this.chooseEngines({ path, preferredEngine: "auto" });
    this.selectedEngine = engines[0]?.engine ?? "walk";
    return this.getStatus();
  }

  getLastResult(): ScanResult | null {
    return this.lastResult;
  }

  private async chooseEngines(options: ScanOptions): Promise<DiskScanner[]> {
    this.lastFallbackReason = null;
    const preferred = options.preferredEngine ?? "auto";
    const allowFallback = options.allowFallback !== false;
    if (preferred === "walk") {
      return [this.walkScanner];
    }
    if (preferred === "mft") {
      return allowFallback ? [this.mftScanner, this.walkScanner] : [this.mftScanner];
    }
    if (preferred === "everything") {
      return allowFallback ? [this.everythingScanner, this.walkScanner] : [this.everythingScanner];
    }

    const engines: DiskScanner[] = [];
    try {
      const everything = await this.everythingScanner.checkAvailability();
      if (everything.available) {
        engines.push(this.everythingScanner);
      } else {
        this.lastFallbackReason = `Everything: ${everything.reason ?? "unavailable"}`;
      }
    } catch (e) {
      this.lastFallbackReason = `Everything: ${e instanceof Error ? e.message : "check failed"}`;
    }

    try {
      const mft = await this.mftScanner.checkAvailability(options.path);
      if (mft.available) {
        engines.push(this.mftScanner);
      } else {
        this.lastFallbackReason = [this.lastFallbackReason, `MFT: ${mft.reason ?? "unavailable"}`].filter(Boolean).join("; ");
      }
    } catch (e) {
      this.lastFallbackReason = [this.lastFallbackReason, `MFT: ${e instanceof Error ? e.message : "check failed"}`].filter(Boolean).join("; ");
    }

    if (allowFallback) {
      engines.push(this.walkScanner);
    }
    return engines;
  }

  async scan(
    options: ScanOptions,
    onProgress?: (progress: ScanProgress) => void,
    abortSignal?: AbortSignal
  ): Promise<ScanResult> {
    this.activeControl?.abort();
    const control = new ActiveScanControl();
    this.activeControl = control;
    const forwardAbort = (): void => control.abort();
    if (abortSignal && typeof abortSignal.addEventListener === "function") {
      abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      const engines = await this.chooseEngines(options);
      let lastError: unknown;
      for (const engine of engines) {
        try {
          const result = await engine.scan(options, control, onProgress);
          this.selectedEngine = engine.engine;
          this.lastResult = result;
          return result;
        } catch (error) {
          lastError = error;
          const reason = error instanceof ScanEngineUnavailableError ? error.reason : error instanceof Error ? error.message : "unknown error";
          this.lastFallbackReason = [this.lastFallbackReason, `${engine.engine}: ${reason}`].filter(Boolean).join("; ");
          if (control.signal.aborted) {
            throw error;
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error("No scan engine available");
    } finally {
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", forwardAbort);
      }
      if (this.activeControl === control) {
        this.activeControl = null;
      }
    }
  }

  pause(): boolean {
    if (!this.activeControl) {
      return false;
    }
    this.activeControl.pause();
    return true;
  }

  resume(): boolean {
    if (!this.activeControl) {
      return false;
    }
    this.activeControl.resumeScan();
    return true;
  }

  stop(): boolean {
    if (!this.activeControl) {
      return false;
    }
    this.activeControl.abort();
    return true;
  }
}
