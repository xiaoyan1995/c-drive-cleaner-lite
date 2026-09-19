export class ScanEngineUnavailableError extends Error {
  constructor(
    readonly engine: string,
    readonly reason: string
  ) {
    super(`${engine} unavailable: ${reason}`);
    this.name = "ScanEngineUnavailableError";
  }
}
