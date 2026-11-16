import "dotenv/config";
import {Injectable} from "@nestjs/common";

/** Reads and validates a bounded integer environment setting. */
function integer(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);

  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);

  return value;
}
/** Validated environment configuration for transport adapters and application policies. */
@Injectable()
export class Config {
  readonly port = integer("PORT", 8080, 1, 65535);
  readonly apiKey = process.env.GATES_API_KEY ?? "";
  readonly wallet = {
    url: process.env.WALLET_SERVICE_URL || "http://127.0.0.1:8000",
    token: process.env.WALLET_SERVICE_TOKEN || "",
    timeout: integer("WALLET_SERVICE_TIMEOUT", 10, 1) * 1000
  };
  readonly rpc = {
    timeout: integer("RPC_TIMEOUT", 20, 1) * 1000,
    batch: !["false", "0"].includes(process.env.RPC_BATCH_ENABLED ?? "true")
  };
  readonly hot = {
    account: integer("HOT_WALLET_ACCOUNT", 1, 0, 0x7fffffff),
    change: integer("HOT_WALLET_CHANGE", 0, 0, 0x7fffffff),
    address_index: integer("HOT_WALLET_INDEX", 0, 0, 0x7fffffff)
  };
  readonly fees = {
    multiplier: integer("FEE_BASE_FEE_MULTIPLIER", 2, 1),
    gasPercent: integer("GAS_LIMIT_MULTIPLIER_PERCENT", 120, 100),
    minPriority: process.env.FEE_MIN_PRIORITY_FEE_WEI || "1000000000"
  };
  readonly indexer = {
    start: process.env.INDEXER_START_BLOCK ? integer("INDEXER_START_BLOCK", 0) : null,
    batchSize: integer("INDEXER_BATCH_SIZE", 10, 1),
    maxBlocks: integer("INDEXER_MAX_BLOCKS_PER_RUN", 500, 1),
    keepBlocks: integer("INDEXER_KEEP_BLOCKS", 256, 64),
    maxReorgDepth: integer("INDEXER_MAX_REORG_DEPTH", 128, 1),
    addressChunk: 200,
    withdrawalsPerRun: 100
  };

  constructor() {
    if (this.indexer.maxReorgDepth > this.indexer.keepBlocks)
      throw new Error("INDEXER_MAX_REORG_DEPTH must not exceed INDEXER_KEEP_BLOCKS");

    if (!/^\d+$/.test(this.fees.minPriority)) throw new Error("Invalid FEE_MIN_PRIORITY_FEE_WEI");
  }
}
