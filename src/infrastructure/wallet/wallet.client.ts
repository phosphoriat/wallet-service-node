import type {Gate} from "../../domain/models.js";
import {Database} from "../persistence/database.js";
import type {Wallet, WalletSession, SignParams, SignedTransaction} from "../../application/ports/wallet.js";
import {Injectable} from "@nestjs/common";
import {Config} from "../config.js";

/** HTTP wallet adapter that resolves gate settings before transaction-bound operations. */
@Injectable()
export class WalletClient implements Wallet {
  constructor(
    private readonly config: Config,
    private readonly db: Database
  ) {}

  /** Resolves infrastructure settings and returns a session for a base gate. */
  async forGate(base: Gate): Promise<WalletSession> {
    const settings = await (await this.db.repository("gates")).findOneByOrFail({id: base.id});
    const gate = settings.wallet_gate || "ethereum";

    return {
      createAddress: (account, change, index) => this.createAddress(gate, account, change, index),
      validateAddress: (address) => this.validateAddress(gate, address),
      sign: (account, change, index, params) => this.sign(gate, account, change, index, params)
    };
  }

  /** Sends an authenticated wallet request and validates the JSON response envelope. */
  private async post(path: string, body: object): Promise<Record<string, unknown>> {
    const {url, token, timeout} = this.config.wallet;
    const response = await fetch(url.replace(/\/$/, "") + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? {Authorization: `Bearer ${token}`} : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) throw new Error(`Wallet service HTTP ${response.status}`);

    const result: unknown = await response.json();

    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Wallet service returned invalid JSON");

    return result as Record<string, unknown>;
  }

  /** Derives an address for the requested account, change and index. */
  private async createAddress(gate: string, account: number, change: number, address_index: number): Promise<string> {
    const result = await this.post("/api/v1/createaddress", {
      gate,
      account,
      change,
      address_index
    });

    if (typeof result.address !== "string" || !/^0x[a-f\d]{40}$/i.test(result.address))
      throw new Error("Wallet service returned invalid address");

    return result.address.toLowerCase();
  }

  /** Asks the wallet service whether the recipient address is valid. */
  private async validateAddress(gate: string, address: string): Promise<boolean> {
    return (await this.post("/api/v1/validateaddress", {gate, address})).valid === true;
  }

  /** Signs exact transaction parameters without broadcasting them. */
  private async sign(
    gate: string,
    account: number,
    change: number,
    address_index: number,
    tx_params: SignParams
  ): Promise<SignedTransaction> {
    const result = await this.post("/api/v1/tx", {
      gate,
      account,
      change,
      address_index,
      tx_params
    });

    if (
      typeof result.signed_tx !== "string" ||
      !/^0x(?:[a-f\d]{2})+$/i.test(result.signed_tx) ||
      typeof result.tx_hash !== "string" ||
      !/^0x[a-f\d]{64}$/i.test(result.tx_hash)
    )
      throw new Error("Wallet service returned invalid signed_tx/tx_hash");

    if (result.from != null && (typeof result.from !== "string" || !/^0x[a-f\d]{40}$/i.test(result.from)))
      throw new Error("Wallet service returned invalid signer");

    return {
      signed_tx: result.signed_tx,
      tx_hash: result.tx_hash.toLowerCase(),
      from: (result.from as string | null) ?? null
    };
  }
}
