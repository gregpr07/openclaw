import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePackageActivationAnchor } from "./package-update-activation-paths.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  runPackageActivationRecovery,
} from "./package-update-activation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

// Reader facts from v2026.9.6's in-anchor schema (eb377ac59e6c), independent of today's writer.
function releasedJournal(phase = "publication-complete") {
  const root = fs.realpathSync(dirs.make("released-package-journal-"));
  const installKey = path.join(root, "openclaw");
  const anchor = resolvePackageActivationAnchor(installKey);
  fs.mkdirSync(anchor, { mode: 0o700 });
  const journal = path.join(anchor, "operation.sqlite");
  const helper = path.join(anchor, "recovery.mjs");
  fs.writeFileSync(helper, "// inert\n", { mode: 0o600 });
  using db = new DatabaseSync(journal);
  fs.chmodSync(journal, 0o600);
  const identity = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const operationId = randomUUID();
  const descriptor = {
    version: 1,
    operationId,
    authority: { installKey },
    anchorIdentity: identity(anchor),
    journalIdentity: identity(journal),
    parentIdentity: identity(root),
  };
  db.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE package_activation (slot INTEGER PRIMARY KEY, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
  );
  db.prepare("INSERT INTO package_activation VALUES (1,0,?,?,'null','[]')").run(
    phase,
    JSON.stringify(descriptor),
  );
  const snapshot = () =>
    fs
      .readdirSync(anchor)
      .toSorted()
      .map((name) => {
        const file = path.join(anchor, name);
        const { ino, mode, mtimeMs: mtime } = fs.lstatSync(file);
        return { name, ino, mode, mtime, bytes: fs.readFileSync(file) };
      });
  return { installKey, anchor, journal, helper, operationId, descriptor, snapshot };
}

describe.skipIf(process.platform === "win32")("released package activation journals", () => {
  it.each(["publication-complete", "retired"])(
    "shows the original helper for %s without admitting a current writer",
    async (phase) => {
      const f = releasedJournal(phase);
      const before = f.snapshot();
      const command = `node ${f.helper} status`;
      expect(readPackageActivationReceipt(f.installKey)).toEqual({
        phase,
        operationId: f.operationId,
        installKey: f.installKey,
        recoveryCommand: command,
      });
      expect(() => assertNoPendingPackageActivation(f.installKey)).toThrow(command);
      for (const action of ["repair", "retire"] as const) {
        await expect(runPackageActivationRecovery(f.anchor, action, f.operationId)).rejects.toThrow(
          "original recovery owner",
        );
      }
      expect(f.snapshot()).toEqual(before);
      expect(fs.existsSync(`${f.anchor}.control`)).toBe(false);
    },
  );

  it("refuses a released journal naming another installation without changing it", () => {
    const f = releasedJournal();
    {
      using db = new DatabaseSync(f.journal);
      db.prepare("UPDATE package_activation SET descriptor_json = ?").run(
        JSON.stringify({
          ...f.descriptor,
          authority: { ...f.descriptor.authority, installKey: path.join(f.anchor, "other") },
        }),
      );
    }
    const before = f.snapshot();
    expect(() => readPackageActivationReceipt(f.installKey)).toThrow("installation");
    expect(() => assertNoPendingPackageActivation(f.installKey)).toThrow("installation");
    expect(f.snapshot()).toEqual(before);
  });
});
