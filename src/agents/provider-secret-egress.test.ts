import { describe, expect, it } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { looksLikeSecretSentinel, mintSecretSentinel } from "../secrets/sentinel.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import { unwrapModelHeaderSentinelsForProviderEgress } from "./provider-secret-egress.js";

const sentinel = (value: string) => mintSecretSentinel(value, { label: "egress-test" });
const transportModel = (
  request: Parameters<typeof attachModelProviderRequestTransport>[1],
  headers?: Record<string, string>,
) => attachModelProviderRequestTransport({ id: "test-model", headers }, request);
const unwrap = <T extends { headers?: Record<string, unknown> }>(model: T) =>
  unwrapModelHeaderSentinelsForProviderEgress(model, "egress test");

describe("protectPreparedProviderRuntimeAuth", () => {
  it("sentinels a real credential returned by the auth exchange and registers it for redaction", () => {
    const runtimeToken = "bedrock-api-key-egress-runtime-token";
    const result = protectPreparedProviderRuntimeAuth({
      provider: "amazon-bedrock-mantle",
      preparedAuth: {
        apiKey: runtimeToken,
        request: { auth: { mode: "authorization-bearer", token: runtimeToken } },
      },
    });

    expect(result?.apiKey).not.toBe(runtimeToken);
    expect(looksLikeSecretSentinel(result?.apiKey ?? "")).toBe(true);
    const auth = result?.request?.auth;
    const bearerToken = auth?.mode === "authorization-bearer" ? auth.token : "";
    expect(looksLikeSecretSentinel(bearerToken)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(runtimeToken)).toBe(true);
  });

  it("leaves non-secret auth markers untouched", () => {
    const result = protectPreparedProviderRuntimeAuth({
      provider: "ollama",
      preparedAuth: { apiKey: "ollama-local" },
    });

    expect(result?.apiKey).toBe("ollama-local");
    expect(isSecretValueRegisteredForRedaction("ollama-local")).toBe(false);
  });
});

describe("unwrapModelHeaderSentinelsForProviderEgress", () => {
  it("unwraps sentinels in visible headers and attached request transport overrides", () => {
    const headerSecret = "egress-visible-header-secret";
    const bearerSecret = "egress-runtime-bearer-secret";
    const overrideHeaderSecret = "egress-override-header-secret";
    const model = transportModel(
      {
        headers: { "x-extra": sentinel(overrideHeaderSecret) },
        auth: { mode: "authorization-bearer", token: sentinel(bearerSecret) },
      },
      { "x-api-key": sentinel(headerSecret) },
    );
    const unwrapped = unwrap(model);
    expect(unwrapped.headers?.["x-api-key"]).toBe(headerSecret);
    const request = getModelProviderRequestTransport(unwrapped);
    expect(request?.headers?.["x-extra"]).toBe(overrideHeaderSecret);
    expect(request?.auth).toEqual({ mode: "authorization-bearer", token: bearerSecret });
    // Original model stays sentineled: unwrap must not mutate shared state.
    expect(model.headers!["x-api-key"]).not.toBe(headerSecret);
    expect(getModelProviderRequestTransport(model)?.auth).not.toEqual(request?.auth);
  });

  it("unwraps header-mode auth values in attached request transport overrides", () => {
    const headerAuthSecret = "egress-header-auth-secret";
    const model = transportModel({
      auth: {
        mode: "header",
        headerName: "x-goog-api-key",
        value: sentinel(headerAuthSecret),
      },
    });
    const request = getModelProviderRequestTransport(unwrap(model));
    expect(request?.auth).toEqual({
      mode: "header",
      headerName: "x-goog-api-key",
      value: headerAuthSecret,
    });
  });

  it("returns the same model instance when nothing is sentineled", () => {
    const model = transportModel(
      { auth: { mode: "provider-default" } },
      { "x-plain": "plain-value" },
    );
    expect(unwrap(model)).toBe(model);
  });

  it("rejects unknown sentinel-shaped values in attached overrides", () => {
    const model = transportModel({
      auth: {
        mode: "authorization-bearer",
        token: "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
      },
    });
    expect(() => unwrap(model)).toThrow(/not registered in this process/);
  });
});
