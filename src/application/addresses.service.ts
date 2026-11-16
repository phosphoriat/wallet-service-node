import type {Address, Gate} from "../domain/models.js";
import {DerivationPath} from "../domain/derivation-path.js";
import {AddressBook} from "../domain/address-book.js";
import type {Addresses} from "./ports/repositories.js";
import type {Wallet} from "./ports/wallet.js";
import type {ApplicationOptions} from "./ports/runtime.js";

/** Address allocation result, including whether this request created the address. */
export interface AddressResult {
  address: Address;
  created: boolean;
}

/** Coordinates address allocation and wallet calls within the base gate boundary. */
export class AddressesService {
  constructor(
    private readonly addresses: Addresses,
    private readonly wallet: Wallet,
    private readonly config: ApplicationOptions
  ) {}

  /** Allocates or reuses a derivation path and obtains its wallet address. */
  async create(base: Gate, account = 0, change = 0, index?: number | null): Promise<AddressResult> {
    const book = new AddressBook(base, new DerivationPath(account, change, index));
    const wallet = await this.wallet.forGate(base);

    return this.addresses.allocate(book, (index) => wallet.createAddress(account, change, index));
  }

  /** Returns the hot-wallet address selected by application configuration. */
  async hot(base: Gate): Promise<Address> {
    const {account, change, address_index} = this.config.hot;

    return (await this.create(base, account, change, address_index)).address;
  }
}
