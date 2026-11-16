/** Transaction fields required to recognize native-asset deposits. */
export interface RpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
}

/** Block header and transaction data used to verify canonical ranges. */
export interface RpcBlock {
  number: string;
  hash: string;
  parentHash: string;
  baseFeePerGas?: string;
  transactions: RpcTransaction[];
}

/** Receipt fields required to verify inclusion and execution status. */
export interface RpcReceipt {
  blockNumber: string;
  blockHash: string;
  status?: string;
}

/** Event-log fields required to recognize canonical ERC20 transfers. */
export interface RpcLog {
  removed?: boolean;
  topics: string[];
  address: string;
  blockNumber: string;
  blockHash: string;
  data: string;
  transactionHash: string;
  logIndex: string;
}
