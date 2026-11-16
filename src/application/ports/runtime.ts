/** Runtime policies consumed by scenarios without reading environment variables. */
export interface ApplicationOptions {
  hot: {account: number; change: number; address_index: number};
  fees: {multiplier: number; gasPercent: number; minPriority: string};
  indexer: {
    start: number | null;
    batchSize: number;
    maxBlocks: number;
    keepBlocks: number;
    maxReorgDepth: number;
    addressChunk: number;
    withdrawalsPerRun: number;
  };
}

/** Coordinates exclusive work and allows ownership checks before irreversible steps. */
export interface Lock {
  /** Runs work under a named lock and releases it even when work fails. */
  lock<T>(name: string, timeout: number, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
}

/** Supplies application timestamps independently of the system clock. */
export interface Clock {
  /** Returns the current timestamp in the persistence-compatible UTC format. */
  now(): string;
}

/** Minimal logging port for indexer diagnostics. */
export interface Log {
  /** Records an indexing error requiring operational attention. */
  error(message: string): void;

  /** Records a recoverable indexing condition or reorganization. */
  warn(message: string): void;
}
