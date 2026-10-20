import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const readFile = vi.fn();
const stat = vi.fn();
const detectMime = vi.fn();
const resolveStrictExistingUploadPaths =
  vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();
vi.mock("./paths.js", () => ({ resolveStrictExistingUploadPaths }));
vi.mock("node:fs/promises", () => ({ default: { readFile, stat } }));
vi.mock("openclaw/plugin-sdk/media-mime", () => ({ detectMime }));
const { setFileChooserFilesViaPlaywright, setInputFilesViaPlaywright } =
  await import("./pw-tools-core.interactions.content.js");
const session = getPwToolsCoreSessionMocks();
const canonical = "/private/tmp/openclaw/uploads/ok.txt";
const paths = ["/tmp/openclaw/uploads/ok.txt"];
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const remote = { cdpUrl: "https://browser.example/cdp", ssrfPolicy: {} };
const extension = {
  browserFilesystemLocal: false,
  uploadPathsFallbackOnPayloadLimit: true,
  ssrfPolicy: {},
};
const payload = {
  name: "ok.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("upload contents"),
  lastModifiedMs: 1700000000000,
};
const nativeOptions = (timeout = DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS) => ({
  timeout,
  signal: expect.any(AbortSignal),
});
const fileStats = (size: number) => ({ size, mtimeMs: payload.lastModifiedMs });
const setInputFiles = vi.fn(async () => {});
const elementHandle = vi.fn(async () => {
  throw new Error("manual upload event dispatch is forbidden");
});
const page = {
  locator: () => ({ first: () => ({ setInputFiles, elementHandle }) }),
  url: () => "https://allowed.example/form",
};
function upload(options: Partial<Parameters<typeof setInputFilesViaPlaywright>[0]> = {}) {
  return setInputFilesViaPlaywright({ ...target, inputRef: "e7", paths, ...options });
}
const expectUpload = (files: (string | typeof payload)[]) =>
  expect(setInputFiles).toHaveBeenCalledExactlyOnceWith(files, nativeOptions());

beforeEach(() => {
  vi.clearAllMocks();
  setPwToolsCoreCurrentPage(page);
  setPwToolsCoreCurrentRefLocator({ setInputFiles, elementHandle });
  readFile.mockResolvedValue(payload.buffer);
  stat.mockResolvedValue(fileStats(payload.buffer.byteLength));
  detectMime.mockResolvedValue(payload.mimeType);
  resolveStrictExistingUploadPaths.mockResolvedValue({ ok: true, paths: [canonical] });
});

it("converts guarded chooser uploads to payloads", async () => {
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  await setFileChooserFilesViaPlaywright({
    ...target,
    ...remote,
    page: page as never,
    fileChooser: fileChooser as never,
    paths,
    timeoutMs: 250,
  });
  expect(stat).toHaveBeenCalledWith(canonical);
  expect(readFile).toHaveBeenCalledWith(canonical);
  expect(fileChooser.setFiles).toHaveBeenCalledWith([payload], nativeOptions(250));
});

it("uses an octet-stream payload when mime detection has no answer", async () => {
  detectMime.mockResolvedValueOnce(undefined);
  await upload(remote);
  expect(setInputFiles).toHaveBeenCalledWith(
    [{ ...payload, mimeType: "application/octet-stream" }],
    nativeOptions(),
  );
});

it("checks aggregate payload size before reading any files", async () => {
  stat
    .mockResolvedValueOnce(fileStats(30 * 1024 * 1024))
    .mockResolvedValueOnce(fileStats(30 * 1024 * 1024));
  const requestedPaths = ["one.txt", "two.txt"].map((name) => `/tmp/openclaw/uploads/${name}`);
  resolveStrictExistingUploadPaths.mockResolvedValueOnce({
    ok: true,
    paths: requestedPaths.map((file) => `/private${file}`),
  });
  await expect(upload({ ...remote, paths: requestedPaths })).rejects.toThrow(
    "Cannot set buffer larger than 50Mb",
  );
  expect(readFile).not.toHaveBeenCalled();
  expect(setInputFiles).not.toHaveBeenCalled();
});

it.each([46, 47, 48, 50])(
  "hands off %i MiB extension uploads within the relay bound",
  async (mib) => {
    stat.mockResolvedValueOnce(fileStats(mib * 1024 * 1024));
    await upload(extension);
    expect(readFile.mock.calls).toEqual(mib === 46 ? [[canonical]] : []);
    expectUpload([mib === 46 ? payload : canonical]);
  },
);

it("keeps guarded local-filesystem uploads as paths inside the policy guard", async () => {
  await upload({
    browserFilesystemLocal: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  });
  for (const unused of [stat, readFile, detectMime, elementHandle]) {
    expect(unused).not.toHaveBeenCalled();
  }
  expectUpload([canonical]);
  expect(resolveStrictExistingUploadPaths).toHaveBeenCalledWith({ requestedPaths: paths });
  expect(session.refLocator).toHaveBeenCalledWith(page, "e7");
  expect(session.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
  expect(session.assertPageNavigationCompletedSafely).toHaveBeenCalledOnce();
});

it("rejects paths outside the allowed directory before native upload", async () => {
  const error = "Invalid path: must stay within inbound media directory";
  resolveStrictExistingUploadPaths.mockResolvedValueOnce({
    ok: false,
    error,
  });
  await expect(
    upload({
      inputRef: undefined,
      element: "input[type=file]",
      paths: ["/tmp/openclaw/uploads/missing.txt"],
    }),
  ).rejects.toThrow(error);
  expect(setInputFiles).not.toHaveBeenCalled();
});
