import {ValidationError} from "./errors.js";

/** Immutable validated account, change and optional address-index selection. */
export class DerivationPath {
  constructor(
    readonly account: number,
    readonly change: number,
    readonly index?: number | null
  ) {
    for (const value of [account, change, ...(index == null ? [] : [index])]) {
      if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
        throw new ValidationError("Derivation indices must be in [0, 2^31-1]");
    }

    Object.freeze(this);
  }

  /** Returns an explicit or sequential index and rejects index exhaustion. */
  allocate(highest: number | null): number {
    const index = this.index ?? (highest === null ? 0 : highest + 1);

    if (index > 0x7fffffff) throw new ValidationError("Address index exhausted");

    return index;
  }
}
