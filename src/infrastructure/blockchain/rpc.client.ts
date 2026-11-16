import {Database} from "../persistence/database.js";
import {
  RpcError,
  type Blockchain,
  type BlockchainFactory,
  type RpcBlock,
  type RpcReceipt,
  type RpcLog
} from "../../application/ports/blockchain.js";
import {Injectable} from "@nestjs/common";
import {Config} from "../config.js";
import {hex, safeInt} from "../../domain/amount.js";
import type {Gate} from "../../domain/models.js";

/** JSON-RPC request envelope with a client-generated correlation identifier. */
interface Request {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

/** JSON-RPC result or error envelope returned by a node. */
interface Reply {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: {code: number; message: string; data?: unknown};
}

/** HTTP JSON-RPC adapter with correlation checks, batching and transport retry. */
export class RpcClient implements Blockchain {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly timeout = 20000,
    private readonly batchEnabled = true
  ) {}

  /** Builds a request envelope with a monotonically increasing identifier. */
  private request(method: string, params: unknown[]): Request {
    return {jsonrpc: "2.0", id: ++this.id, method, params};
  }

  /** Validates correlation and extracts a result or raises a typed RPC error. */
  private result<T>(reply: Reply, request: Request): T {
    if (!reply || reply.jsonrpc !== "2.0" || reply.id !== request.id) throw new RpcError("Malformed JSON-RPC response");

    if (reply.error) throw new RpcError(`${request.method}: ${reply.error.message}`, reply.error.code);

    if (!Object.hasOwn(reply, "result")) throw new RpcError("Missing JSON-RPC result");

    return reply.result as T;
  }

  /** Sends an RPC payload with a timeout and one transport retry. */
  private async post(payload: Request | Request[]): Promise<Reply | Reply[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout)
        });

        if (!response.ok) throw new RpcError(`RPC HTTP ${response.status}`);

        return (await response.json()) as Reply | Reply[];
      } catch (error) {
        if (attempt === 1)
          throw new RpcError(`RPC transport error: ${error instanceof Error ? error.message : "Unknown error"}`);

        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  /** Invokes a chain RPC method and returns its decoded result. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const request = this.request(method, params);

    return this.result<T>((await this.post(request)) as Reply, request);
  }

  /** Resolves batch responses in request order and rejects missing or duplicate identifiers. */
  async batch<T>(calls: [string, unknown[]][]): Promise<T[]> {
    if (!calls.length) return [];

    if (!this.batchEnabled) {
      const results: T[] = [];

      for (const [method, params] of calls) results.push(await this.call<T>(method, params));

      return results;
    }

    const requests = calls.map(([method, params]) => this.request(method, params));
    const replies = await this.post(requests);

    if (!Array.isArray(replies)) throw new RpcError("RPC rejected batch", replies.error?.code ?? null);

    const indexed = new Map<number, Reply>();

    for (const reply of replies) {
      if (indexed.has(reply.id)) throw new RpcError("Duplicate RPC response ID");

      indexed.set(reply.id, reply);
    }

    return requests.map((request) => {
      const reply = indexed.get(request.id);

      if (!reply) throw new RpcError("Incomplete RPC response");

      return this.result<T>(reply, request);
    });
  }

  /** Returns the node's current block height as a safe integer. */
  async blockNumber(): Promise<number> {
    return safeInt(await this.call<string>("eth_blockNumber"));
  }

  /** Loads a block by height or tag; missing blocks are represented by null. */
  block(number: number | string, full = false): Promise<RpcBlock | null> {
    return this.call("eth_getBlockByNumber", [typeof number === "number" ? hex(number) : number, full]);
  }

  /** Loads full blocks in the same order as the requested heights. */
  blocks(numbers: number[]): Promise<(RpcBlock | null)[]> {
    return this.batch(numbers.map((n) => ["eth_getBlockByNumber", [hex(n), true]]));
  }

  /** Loads receipts in transaction-hash order, retaining null for missing receipts. */
  receipts(hashes: string[]): Promise<(RpcReceipt | null)[]> {
    return this.batch(hashes.map((h) => ["eth_getTransactionReceipt", [h]]));
  }

  /** Loads logs matching the supplied block, contract and topic filter. */
  logs(filter: object): Promise<RpcLog[]> {
    return this.call("eth_getLogs", [filter]);
  }
}
/** Resolves RPC connection settings from infrastructure persistence. */
@Injectable()
export class RpcFactory implements BlockchainFactory {
  constructor(
    private readonly config: Config,
    private readonly db: Database
  ) {}

  /** Creates a client using infrastructure settings for the supplied gate. */
  async create(base: Gate): Promise<RpcClient> {
    const settings = await (await this.db.repository("gates")).findOneByOrFail({id: base.id});

    if (!settings.rpc_url) throw new Error(`Gate ${base.name}: rpc_url is not set`);

    return new RpcClient(settings.rpc_url, this.config.rpc.timeout, this.config.rpc.batch);
  }
}
