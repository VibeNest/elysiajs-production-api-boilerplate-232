import { Elysia } from "elysia";
import { isProduction } from "../config/env";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * Centralized error handling. Maps domain errors (AppError) and framework
 * error codes to a consistent JSON shape: { error, message, details? }.
 * Scoped so it covers all routes registered on the app that uses it.
 */
export const errorPlugin = new Elysia({ name: "error" }).onError(
  { as: "scoped" },
  ({ code, error, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return { error: error.code, message: error.message };
    }

    switch (code) {
      case "VALIDATION":
        set.status = 400;
        return {
          error: "VALIDATION",
          message: "Request validation failed",
          details: error.all,
        };
      case "NOT_FOUND":
        set.status = 404;
        return { error: "NOT_FOUND", message: "Route not found" };
      case "PARSE":
        set.status = 400;
        return { error: "PARSE", message: "Malformed request body" };
    }

    // Unexpected error — log it and hide internals in production.
    logger.error({ err: error, code }, "unhandled error");
    set.status = 500;
    return {
      error: "INTERNAL",
      message: isProduction
        ? "Internal server error"
        : ((error as Error)?.message ?? "Unknown error"),
    };
  },
);
