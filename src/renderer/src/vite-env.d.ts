/// <reference types="vite/client" />

interface CDriveCleanerApi {
  invoke<T>(channel: string, args?: unknown): Promise<T>;
  on<T>(channel: string, listener: (payload: T) => void): () => void;
  window: {
    minimize: () => Promise<unknown>;
    toggleMaximize: () => Promise<unknown>;
    close: () => Promise<unknown>;
  };
}

interface Window {
  cDriveCleaner?: CDriveCleanerApi;
}

