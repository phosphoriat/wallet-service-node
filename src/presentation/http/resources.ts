import type {Address, Withdrawal} from "../../domain/models.js";

/** Projects an address with its derivation path for public responses. */
export function addressResource(a: Address, gate: string) {
  return {
    id: a.id,
    gate,
    account: a.account,
    change: a.change,
    address_index: a.address_index,
    path: `m/44'/60'/${a.account}'/${a.change}/${a.address_index}`,
    address: a.address
  };
}

/** Projects a withdrawal without exposing signed bytes or internal transaction fields. */
export function withdrawalResource(w: Withdrawal, gate: string) {
  return {
    id: w.id,
    asset_gate: gate,
    amount: w.amount,
    amount_base_units: w.amount_base_units,
    status: w.status,
    tx_hash: w.tx_hash,
    from_address: w.from_address,
    to_address: w.to_address,
    nonce: w.nonce,
    block_number: w.block_number,
    error: w.error
  };
}
