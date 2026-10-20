import type * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { BATCH_SIZE, insertBlocksInBatches } from "./docx-batch-insert.js";
import type { FeishuDocxBlock } from "./docx-types.js";

type InsertBlocksClient = Parameters<typeof insertBlocksInBatches>[0];
type DocxDescendantCreate = Lark.Client["docx"]["documentBlockDescendant"]["create"];
type DocxDescendantCreateParams = Parameters<DocxDescendantCreate>[0];
type DocxDescendantCreateResponse = Awaited<ReturnType<DocxDescendantCreate>>;

function setup() {
  const create = vi.fn(
    async (params?: DocxDescendantCreateParams): Promise<DocxDescendantCreateResponse> => ({
      code: 0,
      data: {
        children: (params?.data?.children_id ?? []).map((block_id) => ({
          block_id,
          block_type: 2,
        })),
      },
    }),
  );
  const client = { docx: { documentBlockDescendant: { create } } } as InsertBlocksClient;
  return {
    create,
    insert: (blocks: FeishuDocxBlock[], ids: string[]) =>
      insertBlocksInBatches(client, "doc_1", blocks, ids),
    data(index = 0) {
      const data = create.mock.calls.at(index)?.[0]?.data;
      if (!data) {
        throw new Error(`Expected DOCX descendant create data ${index}`);
      }
      return data;
    },
  };
}

describe("insertBlocksInBatches", () => {
  it("splits flat trees at the API block limit", async () => {
    const blockCount = BATCH_SIZE + 200;
    const blocks = Array.from({ length: blockCount }, (_, i) => ({
      block_id: `block_${i}`,
      block_type: 2,
    }));
    const { create, insert, data } = setup();
    const result = await insert(
      blocks,
      blocks.map((block) => block.block_id),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(data().children_id).toHaveLength(BATCH_SIZE);
    expect(data(1).children_id).toHaveLength(200);
    expect(result).toHaveLength(blockCount);
  });

  it("keeps nested descendants grouped with their roots without repeating shared or cyclic blocks", async () => {
    const { create, insert, data } = setup();
    const blocks: FeishuDocxBlock[] = [
      { block_id: "root_a", block_type: 1, children: ["child_a"] },
      { block_id: "child_a", block_type: 2, children: "root_a" },
      { block_id: "root_b", block_type: 1, children: ["child_a", "child_b"] },
      { block_id: "child_b", block_type: 2, children: ["missing"] },
    ];

    await insert(blocks, ["root_a", "root_b"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(data().children_id).toEqual(["root_a", "root_b"]);
    const ids = ["root_a", "child_a", "root_b", "child_b"];
    expect(data().descendants.map((block) => block.block_id ?? "")).toEqual(ids);
  });
});
