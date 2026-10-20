import { afterEach, vi, type Mock } from "vitest";
import type {
  fetchWithTimeoutGuarded,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "../provider-http.js";

type RequestConfig = Parameters<typeof resolveProviderHttpRequestConfig>[0];
type GuardedFetchArgs = Parameters<typeof fetchWithTimeoutGuarded>;
type RequestHeaders = Parameters<typeof resolveProviderRequestHeaders>[0];
type MultipartRequest = Parameters<typeof postMultipartRequest>[0];
type ModelRequest = Parameters<typeof sanitizeConfiguredModelProviderRequest>[0];

type RequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
};

type AnyMock = Mock<(...args: unknown[]) => unknown>;

type TransportMock =
  | "executeProviderOperationWithRetryMock"
  | "postJsonRequestMock"
  | "postMultipartRequestMock"
  | "fetchWithTimeoutMock"
  | "fetchWithTimeoutGuardedMock"
  | "pollProviderOperationJsonMock";
type ProviderHttpMocks = Omit<
  typeof mocks,
  TransportMock | "fetchProviderOperationResponseMock" | "fetchProviderDownloadResponseMock"
> &
  Record<TransportMock, AnyMock>;

const mocks = vi.hoisted(() => ({
  waitProviderOperationPollIntervalMock: vi.fn<typeof waitProviderOperationPollInterval>(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  executeProviderOperationWithRetryMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  pollProviderOperationJsonMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  assertOkOrThrowProviderErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  readProviderJsonResponseMock:
    vi.fn<<T>(response: Response, label: string, opts?: { maxBytes?: number }) => Promise<T>>(),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request: ModelRequest) => request),
  resolveProviderHttpRequestConfigMock: vi.fn((params: RequestConfig): RequestConfigResult => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork:
      (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  resolveProviderRequestHeadersMock: vi.fn(
    (params: RequestHeaders): Record<string, string> | undefined => {
      if (params.provider === "google") {
        return {
          ...params.defaultHeaders,
          "x-goog-api-client": "openclaw/test",
          ...params.callerHeaders,
        };
      }
      return params.callerHeaders ?? params.defaultHeaders;
    },
  ),
}));

mocks.fetchWithTimeoutGuardedMock.mockImplementation(async (...args: GuardedFetchArgs) => {
  const [url, init, timeoutMs, fetchFn] = args;
  const response = await mocks.fetchWithTimeoutMock(url, init ?? {}, timeoutMs ?? 60_000, fetchFn);
  return { response, finalUrl: url, release: async () => {} };
});

mocks.postMultipartRequestMock.mockImplementation(async (params: MultipartRequest) => {
  const response = await mocks.fetchWithTimeoutMock(
    params.url,
    { method: "POST", headers: params.headers, body: params.body },
    params.timeoutMs ?? 60_000,
    params.fetchFn,
  );
  return { response, release: async () => {} };
});

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  mocks.waitProviderOperationPollIntervalMock.mockImplementation(
    actual.waitProviderOperationPollInterval,
  );
  const timeoutTransport = await vi.importActual<typeof import("../../utils/fetch-timeout.js")>(
    "../../utils/fetch-timeout.js",
  );
  const guardedTransport = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  const postTransport = await vi.importActual<typeof import("../../media-understanding/shared.js")>(
    "../../media-understanding/shared.js",
  );
  const { resolveTransientProviderRetryOptions } =
    await import("../../provider-runtime/operation-retry.js");
  // Earlier SDK imports can retain the actual transport namespace; bind it at each call
  // so both those imports and tests that restore spies use the fixture transport.
  const installTimeoutTransportMock = () => {
    vi.spyOn(timeoutTransport, "fetchWithTimeout").mockImplementation((...args) =>
      mocks.fetchWithTimeoutMock(...args),
    );
  };
  // A completed submission can download directly without first installing polling mocks.
  installTimeoutTransportMock();
  const installTransportMocks = () => {
    installTimeoutTransportMock();
    vi.spyOn(guardedTransport, "fetchWithSsrFGuard").mockImplementation(async (params) => ({
      response: await mocks.fetchWithTimeoutMock(
        params.url,
        params.init ?? {},
        params.timeoutMs,
        params.fetchImpl,
      ),
      finalUrl: params.url,
      release: async () => {},
    }));
  };
  const withTransport =
    <T, R>(run: (params: T) => R) =>
    (params: T): R => {
      installTransportMocks();
      return run(params);
    };
  mocks.readProviderJsonResponseMock.mockImplementation(actual.readProviderJsonResponse);
  mocks.pollProviderOperationJsonMock.mockImplementation(
    withTransport(actual.pollProviderOperationJson),
  );
  mocks.fetchProviderOperationResponseMock.mockImplementation(
    withTransport(actual.fetchProviderOperationResponse),
  );
  mocks.fetchProviderDownloadResponseMock.mockImplementation(
    withTransport(actual.fetchProviderDownloadResponse),
  );
  mocks.executeProviderOperationWithRetryMock.mockImplementation(
    (params: Parameters<typeof actual.executeProviderOperationWithRetry>[0]) => {
      const retry = resolveTransientProviderRetryOptions(
        actual.providerOperationRetryConfig(params.stage, params.retry),
      );
      return actual.executeProviderOperationWithRetry({
        ...params,
        ...(retry ? { retry: { ...retry, sleep: retry.sleep ?? (async () => {}) } } : {}),
      });
    },
  );
  return {
    ...actual,
    ...Object.fromEntries(
      Object.entries(mocks)
        .filter(([name]) => name !== "resolveApiKeyForProviderMock")
        .map(([name, mock]) => [name.slice(0, -"Mock".length), mock]),
    ),
    postJsonResponse: (params: Parameters<typeof actual.postJsonResponse>[0]) => {
      vi.spyOn(postTransport, "postJsonRequest").mockImplementation((request) =>
        mocks.postJsonRequestMock(request),
      );
      return actual.postJsonResponse(params);
    },
    resolveProviderApiKeyHttpRequestConfig: (
      params: Parameters<typeof actual.resolveProviderApiKeyHttpRequestConfig>[0],
    ) => {
      vi.spyOn(postTransport, "resolveProviderHttpRequestConfig").mockImplementation((request) =>
        mocks.resolveProviderHttpRequestConfigMock(request),
      );
      return actual.resolveProviderApiKeyHttpRequestConfig(params);
    },
  };
});

export function getProviderHttpMocks(): ProviderHttpMocks {
  return mocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    mocks.postJsonRequestMock.mockReset();
    mocks.fetchWithTimeoutMock.mockReset();
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
  });
}
