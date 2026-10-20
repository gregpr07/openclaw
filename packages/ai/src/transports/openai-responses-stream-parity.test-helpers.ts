import type { AssistantMessage, AssistantMessageEvent } from "@openclaw/llm-core";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { createAssistantOutput } from "./assistant-output.js";
import {
  processResponsesStream as processTransportStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

type ProjectedEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
};

type ProjectedBlock =
  | { type: "thinking"; thinking: string; encrypted: boolean }
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson: boolean;
    };

type ProcessResult = {
  events: ProjectedEvent[];
  content: ProjectedBlock[];
  responseId: string | null;
  stopReason: string;
  error: string | null;
};

export type ParityFixture = {
  name: string;
  events: Record<string, unknown>[];
  canonical: ProcessResult;
};

const model = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "GPT-5.6 Luna",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200_000,
});

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

function projectEvent(event: AssistantMessageEvent): ProjectedEvent | undefined {
  if (!("contentIndex" in event)) {
    return undefined;
  }
  return {
    type: event.type,
    contentIndex: event.contentIndex,
    ...("delta" in event ? { delta: event.delta } : {}),
    ...("content" in event ? { content: event.content } : {}),
  };
}

function projectBlock(block: AssistantMessage["content"][number]): ProjectedBlock {
  if (block.type === "thinking") {
    let encrypted = false;
    if (block.thinkingSignature) {
      try {
        const item = JSON.parse(block.thinkingSignature) as { encrypted_content?: unknown };
        encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      } catch {
        encrypted = false;
      }
    }
    return { type: "thinking", thinking: block.thinking, encrypted };
  }
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  return {
    type: "toolCall",
    id: block.id.replace(/^call_[a-f0-9]{24}/, "call_<generated>"),
    name: block.name,
    arguments: block.arguments,
    partialJson: "partialJson" in block,
  };
}

export async function runFixture(
  events: readonly Record<string, unknown>[],
  options?: Parameters<typeof processTransportStream>[4],
): Promise<ProcessResult> {
  const output = { ...createAssistantOutput(model), timestamp: 0 };
  const captured: AssistantMessageEvent[] = [];
  let error: string | null = null;
  try {
    await processTransportStream(
      eventStream(events),
      output,
      { push: (event) => captured.push(event as AssistantMessageEvent) },
      model,
      options,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    events: captured.map(projectEvent).filter((event) => event !== undefined),
    content: output.content.map(projectBlock),
    responseId: output.responseId ?? null,
    stopReason: output.stopReason,
    error,
  };
}

export const completed = (id: string, output: unknown[] = []) => ({
  type: "response.completed",
  sequence_number: 99,
  response: { id, status: "completed", output },
});

export function outputItem(event: "added" | "done", item: Record<string, unknown>, index?: number) {
  return {
    type: `response.output_item.${event}`,
    ...(index === undefined ? {} : { output_index: index }),
    item,
  };
}
export function message(id: string, text: string, phase?: "commentary" | "final_answer") {
  return {
    ...startedMessage(id),
    status: "completed",
    ...(phase ? { phase } : {}),
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
export function startedMessage(id: string, phase?: "final_answer") {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "in_progress",
    ...(phase ? { phase } : {}),
    content: [],
  };
}

export function reasoning(id: string, text?: string, encrypted_content?: string) {
  return {
    id,
    type: "reasoning",
    summary: text === undefined ? [] : [{ type: "summary_text", text }],
    content: [],
    ...(encrypted_content === undefined ? {} : { encrypted_content }),
  };
}
export function tool(
  id: string,
  args: string,
  status?: "completed" | "incomplete" | "in_progress",
  name = "lookup",
) {
  return {
    id: `fc_${id}`,
    call_id: `call_${id}`,
    type: "function_call",
    name,
    arguments: args,
    ...(status === undefined ? {} : { status }),
  };
}
export function toolCall(
  id: string,
  name: string,
  args: unknown,
): ParityFixture["canonical"]["content"][number] {
  return { type: "toolCall", id, name, arguments: args, partialJson: false };
}

export function textEvents(text: string, contentIndex = 0) {
  return [
    { type: "text_start", contentIndex },
    { type: "text_end", contentIndex, content: text },
  ];
}

export function expected(
  responseId: string | null,
  events: ParityFixture["canonical"]["events"],
  content: ParityFixture["canonical"]["content"],
  outcome: Partial<Pick<ParityFixture["canonical"], "error" | "stopReason">> = {},
): ParityFixture["canonical"] {
  return { responseId, events, content, error: null, stopReason: "stop", ...outcome };
}

export function outputTextDelta(item_id: string, delta: string, output_index = 0) {
  return { type: "response.output_text.delta", output_index, item_id, content_index: 0, delta };
}

export function outputTextPart(item_id: string, output_index = 0) {
  return {
    type: "response.content_part.added",
    output_index,
    item_id,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  };
}
