// test/dialect-tools-check.ts — 工具调用、块顺序、思考档位在两种方言之间转得对。
//
//   node --experimental-strip-types test/dialect-tools-check.ts
//
// 离线：只测 lib/dialect 的纯函数，不起网关，不连任何上游。
//
// 覆盖：
//   1. 流式 OpenAI → Anthropic：工具调用变成 tool_use 块，stop_reason=tool_use；
//      上游没发 finish_reason 就断了，攒下的工具调用照样发出去；
//   2. 流式 thinking/text 交错：同一时间只有一个打开的块，index 递增、配对；
//   3. 流式 Anthropic → OpenAI：tool_use 块变成 tool_calls，finish_reason=tool_calls；
//   4. 非流式两个方向的工具调用与收尾原因；
//   5. reasoning_effort=none 不开思考；max_tokens 很小时不开思考或预算 < max_tokens；
//   6. tool_result 的数组内容拼成文本，is_error 带前缀。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dialect-tools-"));
process.env.BUDDY_DATA_DIR = tmp;

const { openaiStreamToAnthropic, anthropicStreamToOpenAI } = await import("../lib/dialect/stream.ts");
const { openaiToAnthropicResponse, anthropicToOpenAIResponse } = await import("../lib/dialect/response.ts");
const { openaiToAnthropic, anthropicToOpenAI } = await import("../lib/dialect/request.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** Run the OpenAI → Anthropic stream converter and parse the events back. */
async function toAnthropicEvents(chunks: any[]): Promise<any[]> {
  const events: any[] = [];
  for await (const frame of openaiStreamToAnthropic(from(chunks), "m")) {
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (data) events.push(JSON.parse(data));
  }
  return events;
}

/**
 * Is the block sequence legal: one block open at a time, every start has a
 * stop, deltas go to the open block, indexes are 0, 1, 2, …
 */
function blockOrderProblem(events: any[]): string {
  let open: number | null = null;
  let next = 0;
  for (const e of events) {
    if (e.type === "content_block_start") {
      if (open !== null) return `block ${e.index} started while ${open} is open`;
      if (e.index !== next) return `block index ${e.index}, expected ${next}`;
      open = e.index;
      next++;
    } else if (e.type === "content_block_delta") {
      if (e.index !== open) return `delta for ${e.index} while ${open} is open`;
    } else if (e.type === "content_block_stop") {
      if (e.index !== open) return `stop for ${e.index} while ${open} is open`;
      open = null;
    } else if (e.type === "message_delta" || e.type === "message_stop") {
      if (open !== null) return `${e.type} while ${open} is open`;
    }
  }
  return "";
}

const stopOf = (events: any[]) => events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
const toolBlocks = (events: any[]) =>
  events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
const argsOf = (events: any[], index: number) =>
  events
    .filter((e) => e.type === "content_block_delta" && e.index === index && e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json)
    .join("");

const toolChunks = [
  { choices: [{ delta: { content: "让我查一下" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "ls", arguments: "{}" } }] } }] },
];

console.log("");
console.log("流式 OpenAI → Anthropic：工具调用");
{
  const events = await toAnthropicEvents([
    ...toolChunks,
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } },
  ]);
  const tools = toolBlocks(events);
  check("两个 tool_use 块", tools.length === 2, String(tools.length));
  check("id 与名字带过去了", tools[0]?.content_block?.id === "call_a" && tools[1]?.content_block?.name === "ls");
  check("参数拼完整了", argsOf(events, tools[0]?.index) === '{"path":"x"}', argsOf(events, tools[0]?.index));
  check("stop_reason 是 tool_use", stopOf(events) === "tool_use", stopOf(events));
  check("块顺序合法", blockOrderProblem(events) === "", blockOrderProblem(events));
  check("usage 记上了", events.find((e) => e.type === "message_delta")?.usage?.output_tokens === 7);
}

console.log("");
console.log("流式 OpenAI → Anthropic：没有 finish_reason 就断了");
{
  const events = await toAnthropicEvents(toolChunks);
  const tools = toolBlocks(events);
  check("工具调用没丢", tools.length === 2, String(tools.length));
  check("参数完整", argsOf(events, tools[0]?.index) === '{"path":"x"}', argsOf(events, tools[0]?.index));
  check("stop_reason 是 tool_use（不是 end_turn）", stopOf(events) === "tool_use", stopOf(events));
  check("块顺序合法", blockOrderProblem(events) === "", blockOrderProblem(events));
  check("以 message_stop 收尾", events.at(-1)?.type === "message_stop");
}
{
  const events = await toAnthropicEvents([{ choices: [{ delta: { content: "hi" } }] }]);
  check("没有工具调用时仍是 end_turn", stopOf(events) === "end_turn", stopOf(events));
}
{
  // 工具调用只发一次：finish_reason 之后的收尾不能再发一遍。
  const events = await toAnthropicEvents([...toolChunks, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
  check("finish_reason 之后不重复发工具调用", toolBlocks(events).length === 2, String(toolBlocks(events).length));
}

console.log("");
console.log("流式 thinking/text 交错");
{
  const events = await toAnthropicEvents([
    { choices: [{ delta: { reasoning_content: "想一下" } }] },
    { choices: [{ delta: { content: "先说" } }] },
    { choices: [{ delta: { reasoning_content: "再想" } }] },
    { choices: [{ delta: { content: "再说", reasoning_content: "同一帧" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  check("块顺序合法", blockOrderProblem(events) === "", blockOrderProblem(events));
  const kinds = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type);
  check(
    "按到达顺序开块（同帧的思考接着已打开的思考块）",
    kinds.join(",") === "thinking,text,thinking,text",
    kinds.join(","),
  );
  check("stop_reason 是 end_turn", stopOf(events) === "end_turn", stopOf(events));
}
{
  const events = await toAnthropicEvents([
    { choices: [{ delta: { reasoning_content: "想" } }] },
    { choices: [{ delta: { content: "答" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] } }] },
  ]);
  check("思考 + 正文 + 工具（无 finish_reason）块顺序合法", blockOrderProblem(events) === "", blockOrderProblem(events));
  check("工具在", toolBlocks(events).length === 1);
}
{
  const events = await toAnthropicEvents([{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }]);
  check("length → max_tokens", stopOf(events) === "max_tokens", stopOf(events));
}

console.log("");
console.log("流式 Anthropic → OpenAI：工具调用");
{
  const frames = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 3 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const sse = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const body = new Response(sse).body!;
  const chunks: any[] = [];
  for await (const frame of anthropicStreamToOpenAI(body, "m")) {
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (data && data !== "[DONE]") chunks.push(JSON.parse(data));
  }
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
  check("tool_calls 的开头带 id 与名字", calls[0]?.id === "toolu_1" && calls[0]?.function?.name === "read");
  check(
    "参数拼得回来",
    calls.map((c: any) => c.function?.arguments ?? "").join("") === '{"a":1}',
    calls.map((c: any) => c.function?.arguments ?? "").join(""),
  );
  const reasons = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
  check("finish_reason 是 tool_calls（只一次）", reasons.join(",") === "tool_calls", reasons.join(","));
}

console.log("");
console.log("非流式两个方向");
{
  const anthropic = openaiToAnthropicResponse(
    {
      choices: [
        {
          message: { content: null, tool_calls: [{ id: "call_x", function: { name: "f", arguments: '{"k":2}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    "m",
  );
  const block = anthropic.content.find((b: any) => b.type === "tool_use");
  check("OpenAI → Anthropic：tool_use 块", block?.id === "call_x" && block?.input?.k === 2, JSON.stringify(block));
  check("OpenAI → Anthropic：stop_reason=tool_use", anthropic.stop_reason === "tool_use", anthropic.stop_reason);

  const openai = anthropicToOpenAIResponse(
    { content: [{ type: "tool_use", id: "toolu_y", name: "g", input: { z: 1 } }], stop_reason: "tool_use" },
    "m",
  );
  const call = openai.choices[0].message.tool_calls?.[0];
  check("Anthropic → OpenAI：tool_calls", call?.id === "toolu_y" && JSON.parse(call.function.arguments).z === 1);
  check("Anthropic → OpenAI：finish_reason=tool_calls", openai.choices[0].finish_reason === "tool_calls");
  check(
    "max_tokens ↔ length",
    anthropicToOpenAIResponse({ content: [], stop_reason: "max_tokens" }, "m").choices[0].finish_reason === "length" &&
      openaiToAnthropicResponse({ choices: [{ message: {}, finish_reason: "length" }] }, "m").stop_reason === "max_tokens",
  );
}

console.log("");
console.log("思考档位与 max_tokens");
{
  const none = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "none" }, 32000);
  check("reasoning_effort=none 不开思考", none.thinking === undefined, JSON.stringify(none.thinking));

  const noneBack = anthropicToOpenAI({ model: "m", messages: [], thinking: { type: "enabled" }, effort: "none" });
  check("Anthropic → OpenAI 的 none 不带档位", noneBack.reasoning_effort === undefined, String(noneBack.reasoning_effort));

  const tiny = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "high", max_tokens: 500 }, 32000);
  check("max_tokens=500 不开思考", tiny.thinking === undefined, JSON.stringify(tiny.thinking));

  const small = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "high", max_tokens: 4000 }, 32000);
  check(
    "预算夹到 max_tokens 以下",
    small.thinking?.budget_tokens === 3999 && small.thinking.budget_tokens < small.max_tokens,
    JSON.stringify(small.thinking),
  );

  const roomy = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "medium", max_tokens: 64000 }, 32000);
  check("空间够时预算照旧", roomy.thinking?.budget_tokens === 8192, JSON.stringify(roomy.thinking));

  const minimal = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "minimal" }, 32000);
  check("minimal 仍开思考（最小档）", minimal.thinking?.budget_tokens === 2048, JSON.stringify(minimal.thinking));
}

console.log("");
console.log("tool_result 的内容");
{
  const out = anthropicToOpenAI({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: [
              { type: "text", text: "line one" },
              { type: "image", source: { type: "base64", data: "xx" } },
              { type: "text", text: "line two" },
            ],
          },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ],
  });
  const [first, second] = out.messages;
  check("is_error 带前缀", first?.content.startsWith("[tool error] "), first?.content);
  check("文本块拼起来了", first?.content.includes("line one") && first?.content.includes("line two"), first?.content);
  check("非文本块留了占位", first?.content.includes("[image block omitted]"), first?.content);
  check("不是 JSON 原样", !first?.content.includes('"type"'), first?.content);
  check("没出错的没有前缀", second?.content === "ok", second?.content);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
