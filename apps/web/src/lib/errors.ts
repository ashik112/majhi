import { ApiRequestError } from "./api";

/** One line for the owner: the server's message, plus its first detail when it adds something. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const detail = error.details[0];
    return detail && detail !== error.message ? `${error.message}: ${detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Every detail line the server sent with an error, for forms that list each problem. */
export function errorDetails(error: unknown): string[] {
  return error instanceof ApiRequestError ? error.details : [];
}
