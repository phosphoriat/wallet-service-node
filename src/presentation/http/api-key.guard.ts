import {Inject, CanActivate, ExecutionContext, Injectable, UnauthorizedException} from "@nestjs/common";
import {timingSafeEqual} from "node:crypto";

export const API_KEY = Symbol("API_KEY");

/** Protects API routes using a constant-time comparison of the configured key. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(API_KEY) private readonly apiKey: string) {}

  /** Allows requests when auth is disabled or the supplied API key matches. */
  canActivate(context: ExecutionContext): boolean {
    if (!this.apiKey) return true;

    const actual = context.switchToHttp().getRequest().headers["x-api-key"];
    const expected = Buffer.from(this.apiKey);

    if (
      typeof actual !== "string" ||
      Buffer.byteLength(actual) !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), expected)
    )
      throw new UnauthorizedException({error: "Unauthorized"});

    return true;
  }
}
