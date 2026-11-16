import type {Clock} from "../application/ports/runtime.js";

/** UTC clock adapter used for application-generated persistence timestamps. */
export class SystemClock implements Clock {
  /** Returns the current timestamp in the persistence-compatible UTC format. */
  now(): string {
    return new Date().toISOString().slice(0, 23).replace("T", " ");
  }
}
