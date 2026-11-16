import type {Gates, WalletQueries, QueryFilter} from "./ports/repositories.js";

/** Exposes application read operations independently of persistence adapters. */
export class WalletQueriesService {
  constructor(
    private readonly gates: Gates,
    private readonly queries: WalletQueries
  ) {}

  /** Finds a gate by its public name. */
  gate(name: string) {
    return this.gates.gate(name);
  }

  /** Finds a gate by identity for response projection. */
  gateById(id: number) {
    return this.gates.byId(id);
  }

  /** Lists the public address projection with gate names. */
  addresses() {
    return this.queries.addresses();
  }

  /** Lists deposit projections matching the requested filters. */
  deposits(filter: QueryFilter) {
    return this.queries.deposits(filter);
  }

  /** Lists withdrawal projections matching the requested filters. */
  withdrawals(filter: QueryFilter) {
    return this.queries.withdrawals(filter);
  }
}
