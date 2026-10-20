// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

const base: GatewaySessionRow = {
  key: "agent:main:archive",
  sessionId: "same",
  kind: "direct",
};
const fixture = (published: () => GatewaySessionRow | undefined) =>
  createSessionArchiveState(published, () => {}, createSessionRowProvenance());

it.each([
  [false, undefined, "same", undefined],
  [false, false, "same", undefined],
  [true, undefined, null, "pending"],
  [false, true, null, "archived"],
  [false, true, "replacement", undefined],
  [false, true, undefined, undefined],
  [true, true, "same", "pending"],
  [true, false, "same", "pending"],
] as const)(
  "visibility: pending=%s archived=%s published=%s → %s",
  (pending, archived, publishedId, expected) => {
    const publishedRow = vi.fn(() =>
      publishedId === null ? undefined : { ...base, sessionId: publishedId },
    );
    const archives = fixture(publishedRow);
    if (archived !== undefined) {
      archives.observe(base.key, archived, base);
    }
    if (pending) {
      archives.beginPending(base.key, base.sessionId);
    }
    expect(archives.visibility(` ${base.key} `)).toBe(expected);
    if (!pending && !archived) {
      for (const key of [base.key, "agent:main:unknown", " "]) {
        expect(archives.visibility(key)).toBeUndefined();
      }
      expect(publishedRow).not.toHaveBeenCalled();
    }
  },
);

it("keeps a successor's archive pending when an older same-key archive confirms", () => {
  const previous = { ...base, sessionId: "previous" };
  let published = previous;
  const archives = fixture(() => published);
  const finishPrevious = archives.beginPending(previous.key, previous.sessionId);
  published = { ...previous, sessionId: "successor" };
  expect(archives.visibility(previous.key)).toBeUndefined();
  const finishSuccessor = archives.beginPending(published.key, published.sessionId);

  archives.observe(previous.key, true, previous);
  finishPrevious?.();
  expect(archives.visibility(published.key)).toBe("pending");

  archives.observe(published.key, true, published);
  expect(archives.visibility(published.key)).toBe("archived");
  finishSuccessor?.();
  expect(archives.visibility(published.key)).toBe("archived");
});

it("keeps a confirmed archive until a newer authoritative archive observation", () => {
  const value = { ...base, sessionId: "confirmed-archive", archived: false, updatedAt: 1 };
  const archives = fixture(() => value);
  archives.observe(value.key, false, value);
  archives.confirm(value.key, true, { sessionId: "confirmed-archive", updatedAt: 2 });

  expect(archives.applyRow({ ...value, label: "Updated title", updatedAt: 3 }).archived).toBe(true);
  for (const updatedAt of [1, 4]) {
    const read = { ...value, updatedAt };
    archives.observe(read.key, false, read);
    expect(archives.applyRow(read).archived).toBe(updatedAt === 1);
  }
});
