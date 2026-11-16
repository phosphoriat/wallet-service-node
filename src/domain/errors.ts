/** Transport-independent business failure with a category and optional field errors. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly kind: "validation" | "conflict" | "not_found",
    readonly errors?: Record<string, string[]>
  ) {
    super(message);
  }
}

/** Invalid domain input, optionally associated with a public input field. */
export class ValidationError extends DomainError {
  constructor(message: string, field?: string) {
    super(message, "validation", field ? {[field]: [message]} : undefined);
  }
}

/** Business conflict such as reuse of an idempotency key for another request. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "conflict");
  }
}

/** Missing domain resource requested by an application scenario. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, "not_found");
  }
}
