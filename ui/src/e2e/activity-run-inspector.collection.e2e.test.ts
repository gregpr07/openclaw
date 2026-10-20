import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiRunInspectorLocator,
  withControlUiRunInspector,
} from "../test-helpers/control-ui-run-inspector.ts";
import { showHeading } from "./activity-assertions.test-support.ts";
import { decisionDisplay, presentResult } from "./activity-run-inspector.test-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Run Inspector evidence collection",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("binds rendered receipt evidence across reload and navigation without replacing Chat", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ context, page: chat }) => {
      await installMockGateway(chat, { historyMessages: [] });
      const runId = "run:evidence/one";
      const executionId = "execution:evidence/one";
      const receiptId = "approval-decision:102";
      const decisionCursor = "a:10:2";
      const result = presentResult(runId, executionId);
      result.decisionDisplays = [
        decisionDisplay({
          id: receiptId,
          summary: "The requested action was denied.",
          outcome: "denied",
          reasonCode: "operator_approval_denied_by_reviewer",
          coverageState: "enforced",
          remediation: "Review the recorded denial.",
        }),
      ];
      const assertReceipt = async (page: Page, inspector: Locator) => {
        const detail = inspector.locator('[aria-labelledby="run-inspector-receipt-detail"]');
        await showHeading(page, "Receipt detail");
        expect(await inspector.evaluate((element) => ({ ...element.dataset }))).toMatchObject({
          runId,
          executionId,
        });
        expect(await detail.getAttribute("data-receipt-selector-id")).toBe(receiptId);
        expect(await detail.textContent()).toContain("operator_approval_denied_by_reviewer");
      };
      await chat.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const composer = chat.getByRole("textbox", { name: "Chat composer", exact: true });
      await composer.fill("Unsent evidence collection draft");
      const chatUrl = chat.url();
      for (const selector of [
        { kind: "run", id: runId },
        { kind: "execution", id: executionId },
      ] as const) {
        let gateway: Awaited<ReturnType<typeof installMockGateway>> | undefined;
        const collected = await withControlUiRunInspector(
          context,
          {
            baseUrl: suite.server.baseUrl,
            selector,
            receipt: { id: receiptId, decisionCursor },
            preparePage: async (page) => {
              gateway = await installMockGateway(page, {
                featureMethods: ["audit.run.inspect"],
                methodResponses: { "audit.run.inspect": result },
              });
            },
          },
          async (page, inspector) => {
            await assertReceipt(page, inspector);
            await page.reload();
            await assertReceipt(page, inspector);
            expect((await gateway?.waitForRequest("audit.run.inspect"))?.params).toEqual({
              [`${selector.kind}Id`]: selector.id,
              decisionCursor,
              decisionLimit: 50,
              ...(selector.kind === "run" ? { executionLimit: 50 } : {}),
            });
            await page.getByRole("link", { name: "Back to sessions" }).click();
            await page.getByRole("tab", { name: "Sessions" }).waitFor();
            expect(await inspector.count()).toBe(0);
            await page.goBack();
            await assertReceipt(page, inspector);
            const selectedUrl = page.url();
            const other = new URL(selectedUrl);
            other.searchParams.set(selector.kind, "another-run");
            await page.goto(other.href);
            await assertReceipt(page, inspector);
            expect(
              await controlUiRunInspectorLocator(page, { ...selector, id: "another-run" }).count(),
            ).toBe(0);
            const missing = new URL(selectedUrl);
            missing.searchParams.set("receipt", "missing-receipt");
            await page.goto(missing.href);
            await showHeading(page, "Receipt not found on this page");
            expect(await inspector.locator("[data-receipt-selector-id]").count()).toBe(0);
            return receiptId;
          },
        );
        expect(collected).toBe(receiptId);
        expect({
          pages: context.pages(),
          url: chat.url(),
          draft: await composer.inputValue(),
        }).toEqual({ pages: [chat], url: chatUrl, draft: "Unsent evidence collection draft" });
      }
      await expect(
        withControlUiRunInspector(
          context,
          {
            baseUrl: suite.server.baseUrl,
            selector: { kind: "execution", id: executionId },
            preparePage: () => Promise.reject(new Error("Collector setup failed")),
          },
          async () => {
            throw new Error("Collection must not run");
          },
        ),
      ).rejects.toThrow("Collector setup failed");
      expect(context.pages()).toEqual([chat]);
      await chat.reload();
      await composer.waitFor();
      expect(chat.url()).toBe(chatUrl);
    });
  });
});
