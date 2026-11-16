import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  UseFilters
} from "@nestjs/common";
import type {Response} from "express";
import {WalletQueriesService} from "../../application/wallet-queries.service.js";
import {DomainErrorFilter} from "./domain-error.filter.js";
import {AddressesService} from "../../application/addresses.service.js";
import {WithdrawalsService} from "../../application/withdrawals.service.js";
import {ApiKeyGuard} from "./api-key.guard.js";
import {addressResource, withdrawalResource} from "./resources.js";
import {bodyObject, idempotencyKey, indexField, invalid, stringField} from "./validation.js";

/** Translates HTTP wallet requests into application scenarios and public responses. */
@Controller("api")
@UseGuards(ApiKeyGuard)
@UseFilters(DomainErrorFilter)
export class ApiController {
  constructor(
    private readonly queries: WalletQueriesService,
    private readonly addresses: AddressesService,
    private readonly withdrawals: WithdrawalsService
  ) {}

  /** Returns address resources with their derivation paths and gate names. */
  @Get("addresses")
  async listAddresses() {
    const rows = await this.queries.addresses();

    return {addresses: rows.map((a) => addressResource(a, a.gate_name))};
  }

  /** Validates input and returns 201 for creation or 200 for an existing address. */
  @Post("addresses")
  async createAddress(@Body() value: unknown, @Res({passthrough: true}) response: Response) {
    const input = bodyObject(value);
    const name = stringField(input, "base_gate", 64) ?? "eth_sepolia";
    const account = indexField(input, "account") ?? 0,
      change = indexField(input, "change") ?? 0,
      index = indexField(input, "address_index", true);
    const gate = await this.queries.gate(name);

    if (!gate) invalid("base_gate", "Unknown gate");

    const result = await this.addresses.create(gate, account, change, index);

    response.status(result.created ? 201 : 200);

    return {address: addressResource(result.address, gate.name)};
  }

  /** Returns deposits filtered by status, asset and recipient address. */
  @Get("deposits")
  async deposits(@Query() input: Record<string, unknown>) {
    const status = stringField(input, "status", 255),
      gate = stringField(input, "asset_gate", 255);
    const address = stringField(input, "to_address", 255) ?? stringField(input, "address", 255);

    return {deposits: await this.queries.deposits({status, gate, address})};
  }

  /** Returns filtered withdrawal resources without signed transaction bytes. */
  @Get("withdrawals")
  async listWithdrawals(@Query() input: Record<string, unknown>) {
    const status = stringField(input, "status", 255),
      gate = stringField(input, "asset_gate", 255);
    const rows = await this.queries.withdrawals({status, gate});

    return {withdrawals: rows.map((w) => withdrawalResource(w, w.gate_name))};
  }

  /** Validates a withdrawal identity and returns its public resource. */
  @Get("withdrawals/:id")
  async show(@Param("id") id: string) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new NotFoundException();

    const w = await this.withdrawals.find(Number(id));
    const gate = await this.queries.gateById(w.asset_gate_id);

    return {withdrawal: withdrawalResource(w, gate!.name)};
  }

  /** Validates an idempotent request and maps its outcome to the HTTP status contract. */
  @Post("withdrawals")
  async createWithdrawal(
    @Body() value: unknown,
    @Headers("idempotency-key") header: unknown,
    @Res({passthrough: true}) response: Response
  ) {
    const input = bodyObject(value),
      key = idempotencyKey(header);
    const name = stringField(input, "asset_gate", 64, true)!;
    const to = stringField(input, "to_address", 64, true)!;
    const amount = stringField(input, "amount", 100, true)!;
    const gate = await this.queries.gate(name);

    if (!gate) invalid("asset_gate", "Unknown asset gate");

    const {withdrawal: w, created} = await this.withdrawals.create(gate, to, amount, key);

    response.status(
      w.status === "CREATED" || w.status === "SIGNED"
        ? 202
        : w.status === "FAILED"
          ? 422
          : w.status === "BROADCASTED" && created
            ? 201
            : 200
    );

    return {withdrawal: withdrawalResource(w, gate!.name)};
  }
}
/** Exposes a health endpoint that does not require external service calls. */
@Controller()
export class HealthController {
  /** Reports that the HTTP application is running. */
  @Get("up") up() {
    return {status: "ok"};
  }
}
