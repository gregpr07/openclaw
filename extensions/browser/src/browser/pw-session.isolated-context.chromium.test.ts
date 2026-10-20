import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  getPageForTargetId,
} from "./pw-session.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readStorage = () => ({ cookie: document.cookie, identity: localStorage.getItem("identity") });

it.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "isolates profile/sibling credentials and closes the owned popup with its context",
  async () => {
    const receivedCookies: string[] = [];
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/session-context/")) {
        receivedCookies.push(request.headers.cookie ?? "");
      }
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const admin = await getPlaywrightCore().chromium.launchPersistentContext(
      tempDirs.make("openclaw-isolated-context-"),
      {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [`--remote-debugging-port=${port}`],
      },
    );
    const owned: Array<Awaited<ReturnType<typeof createPageViaPlaywright>>> = [];
    try {
      const adminPage = admin.pages()[0] ?? (await admin.newPage());
      await admin.addCookies([{ name: "admin_session", value: "private", url }]);
      await adminPage.goto(url);
      await adminPage.evaluate(() => localStorage.setItem("identity", "admin"));
      for (let index = 0; index < 2; index++) {
        owned.push(
          await createPageViaPlaywright({
            cdpUrl,
            url: `${url}session-context/${index}`,
            isolatedContext: true,
            ssrfPolicy: { allowPrivateNetwork: true },
          }),
        );
      }
      const [firstOwned, secondOwned] = owned;
      assert(firstOwned && secondOwned, "Both isolated pages must be created");
      const first = await getPageForTargetId({ cdpUrl, targetId: firstOwned.targetId });
      const second = await getPageForTargetId({ cdpUrl, targetId: secondOwned.targetId });
      expect(first.context()).not.toBe(second.context());
      expect(receivedCookies).toHaveLength(2);
      expect(receivedCookies.every((cookie) => !cookie.includes("admin_session"))).toBe(true);
      expect(await first.context().cookies(url)).toEqual([]);
      expect(await second.context().cookies(url)).toEqual([]);
      expect(await first.evaluate(readStorage)).toEqual({ cookie: "", identity: null });
      await first.evaluate(() => {
        document.cookie = "session_only=one";
        localStorage.setItem("identity", "one");
      });
      expect(await second.evaluate(readStorage)).toEqual({ cookie: "", identity: null });
      expect(await adminPage.evaluate(() => localStorage.getItem("identity"))).toBe("admin");
      const popupPromise = first.waitForEvent("popup");
      await first.evaluate((target) => {
        window.open(target);
      }, url);
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(popup.context()).toBe(first.context());
      await firstOwned.close();
      expect([first, popup].map((page) => page.isClosed())).toEqual([true, true]);
      expect(owned.map((page) => page.isCurrent())).toEqual([false, true]);
      expect(adminPage.isClosed()).toBe(false);
    } finally {
      await Promise.allSettled(owned.map((page) => page.close()));
      await closePlaywrightBrowserConnection({ cdpUrl });
      await admin.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
  60_000,
);
