import { vi } from "vitest";
import { createChangeListeners } from "../../../../src/shared/listeners.ts";
import type { GatewaySessionRow } from "../../api/types.ts";

export function sessionRow(key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, sessionId: `${key}-id`, kind: "direct", updatedAt: 1, ...extra };
}

export function sessionSelection() {
  const changes = createChangeListeners();
  const state = { selectedId: "main" };
  return {
    state,
    subscribe: changes.subscribe,
    select(selectedId: string) {
      state.selectedId = selectedId;
      changes.publish();
    },
  };
}

export function gatewayRequest(handlers: Record<string, (params?: unknown) => unknown>) {
  return vi.fn(async (method: string, params?: unknown) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler(params);
  });
}
