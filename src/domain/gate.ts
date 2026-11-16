import type {Gate} from "./models.js";
import {ValidationError} from "./errors.js";

/** Owns network relationships and eligibility for address allocation and indexing. */
export class GateAggregate {
  readonly state: Readonly<Gate>;

  constructor(gate: Gate) {
    const {id, name, chain_id, confirmations_required, parent_gate_id, asset_type, token_contract, token_decimals} =
      gate;

    this.state = Object.freeze({
      id,
      name,
      chain_id,
      confirmations_required,
      parent_gate_id,
      asset_type,
      token_contract,
      token_decimals
    });
    Object.freeze(this);
  }

  /** Combines child assets with the native base asset when applicable. */
  static assets(base: Gate, children: Gate[]): Gate[] {
    return base.asset_type === "NATIVE" ? [base, ...children] : children;
  }

  /** Rejects address allocation through a child asset gate. */
  assertAddressBase(): void {
    if (this.state.parent_gate_id !== null) throw new ValidationError("Addresses are created for BASE gate only");
  }

  /** Validates the base gate and the requested scan limit. */
  assertIndexable(maxBlocks: number): void {
    if (this.state.parent_gate_id !== null) throw new Error("Indexer requires a BASE gate");

    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new Error("Invalid max_blocks");
  }

  /** Resolves a parent network and rejects invalid gate relationships. */
  resolveBase(parent: Gate | undefined): Gate {
    if (this.state.parent_gate_id === null) return {...this.state};

    if (!parent || parent.id !== this.state.parent_gate_id || parent.parent_gate_id !== null)
      throw new Error("Invalid parent gate");

    return {...new GateAggregate(parent).state};
  }
}
