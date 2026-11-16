import {Catch, type ArgumentsHost, type ExceptionFilter} from "@nestjs/common";
import type {Response} from "express";
import {DomainError} from "../../domain/errors.js";

/** Preserve the public NestJS error contract without coupling the domain to HTTP. */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  /** Maps domain categories and field errors to the existing HTTP error response format. */
  catch(error: DomainError, host: ArgumentsHost): void {
    const [status, label]: [number, string] =
      error.kind === "validation"
        ? [422, "Unprocessable Entity"]
        : error.kind === "conflict"
          ? [409, "Conflict"]
          : [404, "Not Found"];

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json(
        error.errors
          ? {message: error.message, errors: error.errors}
          : {message: error.message, error: label, statusCode: status}
      );
  }
}
