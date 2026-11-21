/** Shared REST response helpers — docs/API_AND_AI_CONTRACTS.md §1. */
import type { Context } from 'hono';
import type { ApiErrorCode, OrderRow } from '@datawan/shared';

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

export function apiError(c: Context, code: ApiErrorCode, message: string, status: ErrStatus) {
  return c.json({ error: { code, message } }, status);
}

/** Maps services/orderActions.ts conflict reasons to the contract's error codes. */
export function conflictError(c: Context, reason: 'INVALID_FROM_STATE' | 'WRONG_ACTOR' | 'VERSION_CONFLICT', order: OrderRow) {
  if (reason === 'VERSION_CONFLICT') return apiError(c, 'VERSION_CONFLICT', 'order has changed, refetch', 409);
  return apiError(c, 'ORDER_STATE_INVALID', `order ${order.code} is not in a state that allows this action`, 409);
}

/** `If-Match: <version>` (API_AND_AI_CONTRACTS.md §1.1). Only enforced when the header is sent. */
export function checkIfMatch(c: Context, order: OrderRow): Response | null {
  const header = c.req.header('if-match');
  if (header !== undefined && Number(header) !== order.version) {
    return apiError(c, 'VERSION_CONFLICT', 'If-Match does not match the current order version', 409);
  }
  return null;
}
