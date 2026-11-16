import type {Address, Gate} from "./models.js";
import {GateAggregate} from "./gate.js";
import {DerivationPath} from "./derivation-path.js";

/** The base gate is the consistency boundary for sequential address allocation. */
export class AddressBook {
  readonly #gate: Readonly<Gate>;
  readonly #path: DerivationPath;

  /** Returns the immutable base-gate definition used for allocation. */
  get gate() {
    return this.#gate;
  }

  /** Returns the validated derivation path requested by the caller. */
  get path() {
    return this.#path;
  }

  /** Returns the authenticated allocation scope from private aggregate fields. */
  scope() {
    return {gate: this.#gate, path: this.#path};
  }

  constructor(gate: Gate, path: DerivationPath) {
    const aggregate = new GateAggregate(gate);

    aggregate.assertAddressBase();
    this.#gate = aggregate.state;
    this.#path = new DerivationPath(path.account, path.change, path.index);
    Object.freeze(this);
  }

  /** Selects the explicit or next available derivation index. */
  allocate(highest: number | null): number {
    return this.path.allocate(highest);
  }

  /** Builds an address record with the allocation scope and normalized address. */
  address(index: number, value: string): Omit<Address, "id"> {
    new DerivationPath(this.path.account, this.path.change, index);

    return {
      gate_id: this.gate.id,
      account: this.path.account,
      change: this.path.change,
      address_index: index,
      address: value.toLowerCase()
    };
  }
}
