import type {Gate} from "../src/domain/models.js";
import type {Blockchain, BlockchainFactory, RpcBlock, RpcLog, RpcReceipt} from "../src/application/ports/blockchain.js";
import type {Wallet, WalletSession, SignParams} from "../src/application/ports/wallet.js";
import {hex} from "../src/domain/amount.js";

export const recipient = "0x" + "ab".repeat(20);

export const sender = "0x" + "cd".repeat(20);

export const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");

export class FakeWallet implements Wallet {
  async forGate(gate: Gate): Promise<WalletSession> {
    return {
      createAddress: (account, change, index) => this.createAddress(gate, account, change, index),
      validateAddress: () => this.validateAddress(),
      sign: (account, change, index, params) => this.sign(gate, account, change, index, params)
    };
  }

  signatures: SignParams[] = [];
  calls = 0;
  valid = true;
  signer: string | null = null;
  failSign = false;

  async createAddress(_gate: Gate, account: number, _change: number, index: number) {
    this.calls++;

    return "0x" + (account * 1000 + index + 1).toString(16).padStart(40, "0");
  }

  async validateAddress() {
    return this.valid;
  }

  async sign(_gate: Gate, _account: number, _change: number, _index: number, params: SignParams) {
    if (this.failSign) throw new Error("Signer unavailable");

    this.signatures.push(params);

    return {
      signed_tx: "0x" + (params.nonce + 1).toString(16).padStart(2, "0"),
      tx_hash: hash(params.nonce + 100),
      from: this.signer
    };
  }
}

export class FakeRpc implements Blockchain {
  chain = new Map<number, RpcBlock>();
  receiptMap = new Map<string, RpcReceipt>();
  events: RpcLog[] = [];
  broadcastError: Error | null = null;
  broadcasts: string[] = [];
  pendingNonce = 0;

  add(number: number, variant = 0): RpcBlock {
    const block = {
      number: hex(number),
      hash: hash(number + variant),
      parentHash: number ? this.chain.get(number - 1)!.hash : hash(999),
      baseFeePerGas: hex(10),
      transactions: []
    };

    this.chain.set(number, block);

    return block;
  }

  async blockNumber() {
    return Math.max(...this.chain.keys());
  }

  async block(number: number | string) {
    return this.chain.get(number === "latest" ? await this.blockNumber() : Number(number)) || null;
  }

  async blocks(numbers: number[]) {
    return numbers.map((n) => this.chain.get(n) || null);
  }

  async receipts(hashes: string[]) {
    return hashes.map((h) => this.receiptMap.get(h) || null);
  }

  async logs(filter: {fromBlock?: string; toBlock?: string}) {
    return this.events.filter(
      (l) => Number(l.blockNumber) >= Number(filter.fromBlock) && Number(l.blockNumber) <= Number(filter.toBlock)
    );
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (method === "eth_getTransactionCount") return hex(this.pendingNonce) as T;

    if (method === "eth_estimateGas") return hex(21000) as T;

    if (method === "eth_maxPriorityFeePerGas") return hex(1) as T;

    if (method === "eth_sendRawTransaction") {
      this.broadcasts.push(params[0] as string);

      if (this.broadcastError) throw this.broadcastError;

      return hash(Number(params[0]) - 1 + 100) as T;
    }

    throw new Error(`Unexpected RPC ${method}`);
  }
}

export function factory(rpc: FakeRpc): BlockchainFactory {
  return {create: async (_base: Gate) => rpc};
}
