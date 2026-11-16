import {UnprocessableEntityException} from "@nestjs/common";

/** Raises a field-level HTTP validation error using the public response format. */
export function invalid(field: string, message: string): never {
  throw new UnprocessableEntityException({
    message,
    errors: {[field]: [message]}
  });
}

/** Rejects request bodies that are not plain JSON-object-shaped values. */
export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body", "Expected JSON object");

  return value as Record<string, unknown>;
}

/** Validates an optional or required string field and its maximum length. */
export function stringField(
  input: Record<string, unknown>,
  field: string,
  max: number,
  required = false
): string | undefined {
  const value = input[field];

  if (value === undefined && !required) return undefined;

  if (typeof value !== "string" || value.length > max || (required && value.length === 0))
    invalid(field, `Invalid ${field}`);

  return value;
}

/** Accepts supported integer representations within the derivation-index range. */
export function indexField(input: Record<string, unknown>, field: string, nullable = false): number | undefined {
  const value = input[field];

  if (value === undefined || (nullable && value === null)) return undefined;

  if (
    !(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) ||
    !Number.isInteger(Number(value)) ||
    Number(value) < 0 ||
    Number(value) > 0x7fffffff
  )
    invalid(field, `${field} must be an integer in [0, 2^31-1]`);

  return Number(value);
}

/** Validates a UUID header and normalizes its case for idempotent lookup. */
export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value))
    invalid("idempotency_key", "Idempotency-Key must be a UUID");

  return value.toLowerCase();
}
