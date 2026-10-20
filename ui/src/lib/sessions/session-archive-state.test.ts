// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

const row = (sessionId: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: "agent:main:archive",
  sessionId,
  kind: "direct",
  ...extra,
});
function fixture(publishedRow: () => GatewaySessionRow | undefined) {
  const provenance = createSessionRowProvenance();
  const archives = createSessionArchiveState(publishedRow, () => {}, provenance);
  const observe = (value: GatewaySessionRow, archived: boolean, clock: number) => {
    provenance.observeReadRow(value, clock);
    archives.observe(value.key, archived, value);
  };
  return { archives, provenance, observe };
}

it.each([
  { pending: false, archived: undefined, publishedId: "same", expected: undefined },
  { pending: false, archived: false, publishedId: "same", expected: undefined },
  { pending: true, archived: undefined, publishedId: null, expected: "pending" },
  { pending: false, archived: true, publishedId: null, expected: "archived" },
  { pending: false, archived: true, publishedId: "replacement", expected: undefined },
  { pending: false, archived: true, publishedId: undefined, expected: undefined },
  { pending: true, archived: true, publishedId: "same", expected: "pending" },
  { pending: true, archived: false, publishedId: "same", expected: "pending" },
])(
  "resolves visibility with pending=$pending archived=$archived publishedId=$publishedId",
  ({ pending, archived, publishedId, expected }) => {
    const value = row("same");
    const publishedRow = vi.fn(() =>
      publishedId === null ? undefined : { ...value, sessionId: publishedId },
    );
    const { archives, observe } = fixture(publishedRow);
    if (archived !== undefined) {
      observe(value, archived, 1);
    }
    if (pending) {
      archives.beginPending(value.key, value.sessionId);
    }
    expect(archives.visibility(` ${value.key} `)).toBe(expected);
    if (!pending && !archived) {
      for (const key of [value.key, "agent:main:unknown", " "]) {
        expect(archives.visibility(key)).toBeUndefined();
      }
      expect(publishedRow).not.toHaveBeenCalled();
    }
  },
);

it("keeps a successor's archive pending when an older same-key archive confirms", () => {
  const previous = row("previous");
  let published = previous;
  const { archives, observe } = fixture(() => published);
  const finishPrevious = archives.beginPending(previous.key, previous.sessionId);
  published = { ...previous, sessionId: "successor" };
  expect(archives.visibility(previous.key)).toBeUndefined();
  const finishSuccessor = archives.beginPending(published.key, published.sessionId);

  observe(previous, true, 1);
  finishPrevious?.();
  expect(archives.visibility(published.key)).toBe("pending");

  observe(published, true, 2);
  expect(archives.visibility(published.key)).toBe("archived");
  finishSuccessor?.();
  expect(archives.visibility(published.key)).toBe("archived");
});

it("keeps a confirmed archive until a newer authoritative archive observation", () => {
  const value = row("confirmed-archive", { archived: false, updatedAt: 1 });
  const { archives, provenance, observe } = fixture(() => value);
  observe(value, false, 1);
  archives.confirm(value.key, true, { sessionId: "confirmed-archive", updatedAt: 2 });

  const unrelated = { ...value, label: "Updated title", updatedAt: 3 };
  provenance.observeReadRow(unrelated, 3);
  expect(archives.applyRow(unrelated).archived).toBe(true);

  const pendingRead = { ...value };
  observe(pendingRead, false, 2);
  expect(archives.applyRow(pendingRead).archived).toBe(true);

  const freshRead = { ...value, updatedAt: 4 };
  observe(freshRead, false, 4);
  expect(archives.applyRow(freshRead).archived).toBe(false);
});
