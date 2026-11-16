import {ChainIndexAggregate, ChainReorganization} from "../../domain/chain-index.js";
import {GateAggregate} from "../../domain/gate.js";
import {AddressBook} from "../../domain/address-book.js";
import {
  Between,
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  type EntityManager,
  type Repository,
  type ObjectLiteral
} from "typeorm";
import {isDeepStrictEqual} from "node:util";
import {NotFoundError} from "../../domain/errors.js";
import type {Gate, Withdrawal, IndexerState} from "../../domain/models.js";
import {DepositAggregate} from "../../domain/deposit.js";
import {WithdrawalAggregate} from "../../domain/withdrawal.js";
import type {
  Gates,
  Addresses,
  Withdrawals,
  IndexStore,
  StoredBlock,
  WalletQueries,
  QueryFilter,
  DepositView
} from "../../application/ports/repositories.js";
import type {
  GateRecord,
  AddressRecord,
  WithdrawalRecord,
  DepositRecord,
  BlockRecord,
  IndexStateRecord
} from "./entities.js";
import {Database} from "./database.js";

const now = () => "CURRENT_TIMESTAMP";

/** TypeORM gate reader that strips transport configuration from domain snapshots. */
export class TypeOrmGates implements Gates {
  constructor(private readonly db: Database) {}

  /** Finds a gate by its public name, including the supported legacy alias. */
  async gate(name: string) {
    const row = await (
      await this.db.repository("gates")
    ).findOneBy({name: name === "ethereum_sepolia" ? "eth_sepolia" : name});

    return row ? {...new GateAggregate(row).state} : undefined;
  }

  /** Finds a gate by its persistent identity. */
  async byId(id: number) {
    const row = await (await this.db.repository("gates")).findOneBy({id});

    return row ? {...new GateAggregate(row).state} : undefined;
  }

  /** Resolves and validates the base network associated with an asset gate. */
  async base(gate: Gate): Promise<Gate> {
    return new GateAggregate(gate).resolveBase(
      gate.parent_gate_id === null ? undefined : await this.byId(gate.parent_gate_id)
    );
  }

  /** Lists child assets of a base gate in identity order. */
  async children(id: number) {
    return (await (await this.db.repository("gates")).find({where: {parent_gate_id: id}, order: {id: "ASC"}})).map(
      (row) => ({...new GateAggregate(row).state})
    );
  }
}

/** Serializes address allocation on the base-gate row within a transaction. */
export class TypeOrmAddresses implements Addresses {
  constructor(private readonly db: Database) {}

  /** Lists addresses belonging to a base gate. */
  async forGate(id: number) {
    return (await this.db.repository("addresses")).findBy({gate_id: id});
  }

  /** Locks the base gate and atomically reuses or inserts the address selected by the domain book. */
  async allocate(book: AddressBook, create: (index: number) => Promise<string>) {
    const {gate: base, path} = AddressBook.prototype.scope.call(book);
    const source = await this.db.connection();

    return source.transaction(async (manager) => {
      const gate = manager
        .getRepository<GateRecord>("gates")
        .createQueryBuilder("gate")
        .where("gate.id = :id", {id: base.id});

      if (source.options.type === "mysql") gate.setLock("pessimistic_write");

      await gate.getOne();

      const repository = manager.getRepository<AddressRecord>("addresses");
      const scope = {
        gate_id: base.id,
        account: path.account,
        change: path.change
      };
      const row =
        path.index == null
          ? await repository
              .createQueryBuilder("address")
              .select("MAX(address.address_index)", "highest")
              .where(scope)
              .getRawOne<{highest: number | null}>()
          : undefined;
      const index = book.allocate(row?.highest == null ? null : Number(row.highest));
      const exact = {...scope, address_index: index};
      const existing = await repository.findOneBy(exact);

      if (existing) return {address: existing, created: false};

      const address = await create(index);

      await repository.insert(book.address(index, address));

      return {
        address: await repository.findOneByOrFail(exact),
        created: true
      };
    });
  }
}

/** Persists withdrawal aggregates through locked, synchronous domain operations. */
export class TypeOrmWithdrawals implements Withdrawals {
  constructor(private readonly db: Database) {}

  /** Reads a withdrawal snapshot by identity without granting mutation access. */
  async find(id: number) {
    return (await (await this.db.repository("withdrawals")).findOneBy({id})) ?? undefined;
  }

  /** Reads the withdrawal associated with an idempotency key. */
  async byKey(key: string) {
    return (await (await this.db.repository("withdrawals")).findOneBy({idempotency_key: key})) ?? undefined;
  }

  /** Inserts only a fresh aggregate created through its domain factory. */
  async create(aggregate: WithdrawalAggregate): Promise<Withdrawal> {
    const values = WithdrawalAggregate.prototype.newRecord.call(aggregate);
    const repository = await this.db.repository("withdrawals");

    await repository.insert(values);

    return repository.findOneByOrFail({
      idempotency_key: values.idempotency_key
    });
  }

  /**
   * Loads current state under a row lock, applies a synchronous domain operation and commits its result.
   *
   * @param operation Synchronous mutation through aggregate methods; its return value is ignored.
   * @throws Rolls back when loading, the domain operation or persistence fails.
   */
  async change(id: number, operation: (aggregate: WithdrawalAggregate) => void): Promise<Withdrawal> {
    const source = await this.db.connection();

    return source.transaction(async (manager) => {
      const repository = manager.getRepository<WithdrawalRecord>("withdrawals");
      const query = locked(repository, manager).where({id});
      const row = await query.getOne();

      if (!row) throw new NotFoundError("Withdrawal not found");

      const aggregate = WithdrawalAggregate.rehydrate(row);
      const before = aggregate.state;

      synchronous(operation, aggregate);

      const after = aggregate.state;

      if (!isDeepStrictEqual(before, after)) await repository.update({id}, {...after, updated_at: now});

      return {...after};
    });
  }

  /** Finds the highest reserved nonce across native and token assets of one account. */
  async highestReservedNonce(baseId: number, address: string): Promise<number | string | null> {
    const gates = await (
      await this.db.repository("gates")
    ).find({
      where: [{id: baseId}, {parent_gate_id: baseId}],
      select: {id: true}
    });
    const reserved = await (
      await this.db.repository("withdrawals")
    )
      .createQueryBuilder("w")
      .select("MAX(w.nonce)", "highest")
      .where({
        asset_gate_id: In(gates.map((g) => g.id)),
        from_address: address,
        status: In(WithdrawalAggregate.reservedStatuses)
      })
      .getRawOne<{highest: number | string | null}>();

    return reserved?.highest ?? null;
  }

  /** Lists withdrawals eligible for receipt tracking, ordered and bounded by the limit. */
  async pending(gateIds: number[], limit: number) {
    return (await this.db.repository("withdrawals")).find({
      where: {
        asset_gate_id: In(gateIds),
        status: In(WithdrawalAggregate.trackedStatuses),
        tx_hash: Not(IsNull())
      },
      order: {id: "ASC"},
      take: limit
    });
  }
}

/** Persists validated chain changes and their aggregate effects atomically. */
export class TypeOrmIndexStore implements IndexStore {
  constructor(private readonly db: Database) {}

  /** Reads the last committed indexing position for a base gate. */
  async state(gateId: number) {
    return (await (await this.db.repository("indexer_states")).findOneBy({gate_id: gateId})) ?? undefined;
  }

  /** Atomically inserts the initial cursor and its matching anchor block. */
  async initialize(state: IndexerState, block: StoredBlock): Promise<void> {
    new ChainIndexAggregate({
      gate_id: block.gate_id,
      last_block_number: block.number,
      last_block_hash: block.hash
    }).assertCheckpoint(state);
    await (
      await this.db.connection()
    ).transaction(async (manager) => {
      await manager.getRepository<BlockRecord>("blocks").upsert(block, ["gate_id", "number"]);
      await manager.getRepository<IndexStateRecord>("indexer_states").insert(state);
    });
  }

  /** Validates and atomically persists contiguous blocks, deposits and their cursor. */
  async commitRange(state: IndexerState, blocks: StoredBlock[], deposits: DepositAggregate[]): Promise<void> {
    await (
      await this.db.connection()
    ).transaction(async (manager) => {
      const cursorRepository = manager.getRepository<IndexStateRecord>("indexer_states");
      const current = await locked(cursorRepository, manager).where({gate_id: state.gate_id}).getOneOrFail();
      const index = new ChainIndexAggregate(current);

      index.advance(blocks);
      index.assertCheckpoint(state);

      const gateRepository = manager.getRepository<GateRecord>("gates");
      const base = await gateRepository.findOneByOrFail({id: state.gate_id});
      const assets = GateAggregate.assets(base, await gateRepository.findBy({parent_gate_id: state.gate_id}));

      for (const observation of deposits)
        index.assertObservation(
          observation,
          blocks,
          assets.map((g) => g.id)
        );

      for (const block of blocks)
        await manager.getRepository<BlockRecord>("blocks").upsert(block, ["gate_id", "number"]);

      const repository = manager.getRepository<DepositRecord>("deposits");

      for (const observation of deposits) {
        const record = DepositAggregate.prototype.newRecord.call(observation);
        const existing = await locked(repository, manager)
          .where({
            asset_gate_id: record.asset_gate_id,
            tx_hash: record.tx_hash,
            log_index: record.log_index
          })
          .getOne();

        if (existing) {
          const aggregate = DepositAggregate.rehydrate(existing);

          aggregate.reobserve(observation);
          await repository.update({id: existing.id}, {...aggregate.state, updated_at: now});
        } else await repository.insert(record);
      }

      await manager
        .getRepository<IndexStateRecord>("indexer_states")
        .update({gate_id: state.gate_id}, {...state, updated_at: now});
    });
  }

  /** Loads retained blocks in the inclusive height window. */
  async blocks(gateId: number, low: number, high: number) {
    return (await this.db.repository("blocks")).findBy({
      gate_id: gateId,
      number: Between(low, high)
    });
  }

  /** Finds a retained block by network and height. */
  async block(gateId: number, number: number) {
    return (await (await this.db.repository("blocks")).findOneBy({gate_id: gateId, number})) ?? undefined;
  }

  /** Deletes retained block headers strictly below the supplied height. */
  async prune(gateId: number, before: number): Promise<void> {
    await (await this.db.repository("blocks")).delete({gate_id: gateId, number: LessThan(before)});
  }

  /** Applies a validated reorganization atomically and reports orphaned confirmed deposits. */
  async rollback(command: ChainReorganization): Promise<{id: number; tx_hash: string}[]> {
    const state = ChainReorganization.prototype.target.call(command);

    return (await this.db.connection()).transaction(async (manager) => {
      const current = await locked(manager.getRepository<IndexStateRecord>("indexer_states"), manager)
        .where({gate_id: state.gate_id})
        .getOneOrFail();

      command.assertCurrent(current);

      const index = new ChainIndexAggregate(current);
      const anchor = await manager
        .getRepository<BlockRecord>("blocks")
        .findOneBy({gate_id: state.gate_id, number: state.last_block_number});
      const gateRepository = manager.getRepository<GateRecord>("gates");
      const base = await gateRepository.findOneByOrFail({id: state.gate_id});
      const ids = GateAggregate.assets(base, await gateRepository.findBy({parent_gate_id: state.gate_id})).map(
        (g) => g.id
      );
      const scope = {
        asset_gate_id: In(ids),
        block_number: MoreThan(state.last_block_number)
      };
      const depositRepository = manager.getRepository<DepositRecord>("deposits");
      const withdrawalRepository = manager.getRepository<WithdrawalRecord>("withdrawals");
      const deposits = (
        await locked(depositRepository, manager).where(scope).orderBy("entity.id", "ASC").getMany()
      ).map((row) => DepositAggregate.rehydrate(row));
      const withdrawals = (
        await locked(withdrawalRepository, manager).where(scope).orderBy("entity.id", "ASC").getMany()
      ).map((row) => WithdrawalAggregate.rehydrate(row));
      const beforeDeposits = deposits.map((a) => a.state),
        beforeWithdrawals = withdrawals.map((a) => a.state);
      const lost = index.rewind(anchor, deposits, withdrawals);

      index.assertCheckpoint(state);

      for (const [index, aggregate] of deposits.entries())
        if (!isDeepStrictEqual(beforeDeposits[index], aggregate.state))
          await depositRepository.update({id: aggregate.state.id}, {...aggregate.state, updated_at: now});

      for (const [index, aggregate] of withdrawals.entries())
        if (!isDeepStrictEqual(beforeWithdrawals[index], aggregate.state))
          await withdrawalRepository.update({id: aggregate.state.id}, {...aggregate.state, updated_at: now});

      await manager.getRepository<BlockRecord>("blocks").delete({
        gate_id: state.gate_id,
        number: MoreThan(state.last_block_number)
      });
      await manager
        .getRepository<IndexStateRecord>("indexer_states")
        .update({gate_id: state.gate_id}, {...state, updated_at: now});

      return lost;
    });
  }

  /** Executes synchronous domain operations on pending deposits under row locks. */
  async changePendingDeposits(gateIds: number[], operation: (deposit: DepositAggregate) => void): Promise<void> {
    await (
      await this.db.connection()
    ).transaction(async (manager) => {
      const repository = manager.getRepository<DepositRecord>("deposits");
      const rows = await locked(repository, manager)
        .where({asset_gate_id: In(gateIds), status: "PENDING"})
        .orderBy("entity.id", "ASC")
        .getMany();

      for (const row of rows) {
        const aggregate = DepositAggregate.rehydrate(row),
          before = aggregate.state;

        synchronous(operation, aggregate);

        if (!isDeepStrictEqual(before, aggregate.state))
          await repository.update({id: row.id}, {...aggregate.state, updated_at: now});
      }
    });
  }
}

/** Builds bounded read projections for public wallet responses. */
export class TypeOrmWalletQueries implements WalletQueries {
  constructor(private readonly db: Database) {}

  /** Lists the public address projection with gate names. */
  async addresses() {
    return (await this.db.repository("addresses"))
      .createQueryBuilder("a")
      .innerJoin("gates", "g", "a.gate_id = g.id")
      .select("a.*")
      .addSelect("g.name", "gate_name")
      .orderBy("a.id", "ASC")
      .limit(100)
      .getRawMany<AddressRecord & {gate_name: string}>();
  }

  /** Lists deposit projections matching the requested filters. */
  async deposits({status, gate, address}: QueryFilter): Promise<DepositView[]> {
    const query = (await this.db.repository("deposits"))
      .createQueryBuilder("d")
      .innerJoin("gates", "g", "g.id = d.asset_gate_id");
    const fields = [
      "id",
      "tx_hash",
      "log_index",
      "from_address",
      "to_address",
      "amount",
      "amount_base_units",
      "block_number",
      "block_hash",
      "confirmations",
      "status",
      "confirmed_at"
    ];

    query.select("g.name", "asset_gate");

    for (const field of fields) query.addSelect(`d.${field}`, field);

    if (status) query.andWhere("d.status = :status", {status});

    if (gate)
      query.andWhere("g.name = :gate", {
        gate: gate === "ethereum_sepolia" ? "eth_sepolia" : gate
      });

    if (address)
      query.andWhere("d.to_address = :address", {
        address: address.toLowerCase()
      });

    return query.orderBy("d.block_number", "DESC").addOrderBy("d.id", "DESC").limit(100).getRawMany<DepositView>();
  }

  /** Lists withdrawal projections matching the requested filters. */
  async withdrawals({status, gate}: QueryFilter) {
    const query = (await this.db.repository("withdrawals"))
      .createQueryBuilder("w")
      .innerJoin("gates", "g", "g.id = w.asset_gate_id")
      .select("w.*")
      .addSelect("g.name", "gate_name");

    if (status) query.andWhere("w.status = :status", {status});

    if (gate)
      query.andWhere("g.name = :gate", {
        gate: gate === "ethereum_sepolia" ? "eth_sepolia" : gate
      });

    return query.orderBy("w.id", "DESC").limit(100).getRawMany<Withdrawal & {gate_name: string}>();
  }
}

/** Adds a pessimistic write lock when the configured driver supports MySQL row locks. */
function locked<T extends ObjectLiteral>(repository: Repository<T>, manager: EntityManager) {
  const query = repository.createQueryBuilder("entity");

  if (manager.connection.options.type === "mysql") query.setLock("pessimistic_write");

  return query;
}

/** Rejects asynchronous callbacks that could escape the aggregate transaction boundary. */
function synchronous<T>(operation: (aggregate: T) => void, aggregate: T): void {
  const result: unknown = operation(aggregate);

  if (result && typeof (result as {then?: unknown}).then === "function")
    throw new Error("Aggregate operations must be synchronous");
}
