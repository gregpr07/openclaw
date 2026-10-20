import { describe, expect, it, vi } from "vitest";
import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
  filterCodeModePayloadTools,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";

function withThrowingGetter(field: string): Record<string, unknown> {
  return Object.defineProperty({}, field, {
    enumerable: true,
    get() {
      throw new Error(`unexpected ${field} getter`);
    },
  }) as Record<string, unknown>;
}
const named = (name: string) => ({ name });
const fn = (name: string) => ({ type: "function", name });
const nestedFn = (name: string) => ({ type: "function", function: named(name) });
const hosted = (type: string) => ({ type });
const grouped = (...names: string[]) => ({ functionDeclarations: names.map(named) });
const visibleToolNames = new Set(["exec", "wait", "computer"]);
const allowedHostedToolTypes = new Set(["web_search"]);
function expectViolation(payload: unknown, hostedTypes?: ReadonlySet<string>) {
  expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames, hostedTypes)).toThrow(
    /tool surface violation/,
  );
}

describe("OpenAI Code Mode payload tool names", () => {
  it("uses only tool names declared in the current request", () => {
    expect(
      resolveCodeModeResponsesVisibleToolNames({
        tools: [
          { name: "exec" },
          { function: { name: "wait" } },
          { name: "computer" },
          withThrowingGetter("name"),
          Object.create({ name: "rogue" }),
          null,
        ],
      } as unknown as Parameters<typeof resolveCodeModeResponsesVisibleToolNames>[0]),
    ).toEqual(new Set(["exec", "wait", "computer"]));
  });
});

describe("OpenAI Code Mode payload tool filtering", () => {
  it.each(["functionDeclarations", "function_declarations"] as const)(
    "filters grouped %s without admitting provider-native tools",
    (field) => {
      const payload: { tools: unknown[] } = {
        tools: [
          fn("exec"),
          nestedFn("wait"),
          {
            [field]: [
              { name: "computer", parameters: { type: "object" } },
              { name: "web_search", parameters: { type: "object" } },
              withThrowingGetter("name"),
            ],
          },
          hosted("web_search"),
          withThrowingGetter("name"),
        ],
      };

      filterCodeModePayloadTools(payload, visibleToolNames);

      expect(payload.tools).toEqual([
        fn("exec"),
        nestedFn("wait"),
        { [field]: [{ name: "computer", parameters: { type: "object" } }] },
      ]);
    },
  );

  it("keeps only explicitly allowed hosted tools alongside visible client functions", () => {
    const payload = {
      tools: [
        fn("exec"),
        fn("rogue"),
        hosted("web_search"),
        hosted("file_search"),
        { type: "web_search", name: "exec" },
        { type: "web_search", function: { name: "wait" } },
        { type: "web_search", functionDeclarations: [{ name: "exec" }] },
        fn("wait"),
      ],
    };

    filterCodeModePayloadTools(payload, visibleToolNames, allowedHostedToolTypes);
    enforceCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes);

    expect(payload.tools).toEqual([fn("exec"), hosted("web_search"), fn("wait")]);
    expect(() =>
      assertCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes),
    ).not.toThrow();
  });

  it("observes exact final-egress identities without a second payload parser", () => {
    const observer = vi.fn();
    const payload = {
      tools: [
        fn("exec"),
        nestedFn("wait"),
        grouped("computer", "rogue"),
        hosted("web_search"),
        hosted("file_search"),
      ],
    };

    enforceCodeModeResponsesToolSurface(
      payload,
      visibleToolNames,
      allowedHostedToolTypes,
      observer,
    );

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith({
      beforeToolIdentities: [
        "client:exec",
        "client:wait",
        "client:computer",
        "client:rogue",
        "hosted:web_search",
        "hosted:file_search",
      ],
      afterToolIdentities: ["client:exec", "client:wait", "hosted:web_search"],
    });
  });

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "rejects and removes grouped %s from final OpenAI payloads",
    (field) => {
      const payload = {
        tools: [named("exec"), named("wait"), { [field]: [named("exec"), named("computer")] }],
      };

      expectViolation(payload);

      enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

      expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
      expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
    },
  );

  it.each([
    [named("exec"), named("exec"), named("wait")],
    [named("exec"), named("computer")],
    [named("exec"), named("wait"), named("web_search")],
  ])("rejects duplicate, missing, or undeclared controls", (...tools) => {
    expectViolation({ tools });
  });

  it.each([
    [fn("exec"), fn("wait"), hosted("web_search"), hosted("web_search")],
    [fn("exec"), fn("wait"), hosted("file_search")],
  ])("rejects duplicate or undeclared hosted tools", (...tools) => {
    expectViolation({ tools }, allowedHostedToolTypes);
  });

  it("fails closed when the asserted payload tools getter throws", () => {
    expectViolation(withThrowingGetter("tools"));
  });
});
