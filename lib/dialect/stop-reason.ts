// lib/dialect/stop-reason.ts — 两种方言的收尾原因怎么互换。
//
// 流式与非流式各转一遍，两个方向，一共四处要用。写在一处，免得哪天一处
// 认了新的原因、另一处还按老规矩落成 end_turn。

/** OpenAI finish_reason → Anthropic stop_reason。没有原因就是正常收尾。 */
export function anthropicStopReason(finishReason: unknown): string {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls") return "tool_use";
  return "end_turn";
}

/** Anthropic stop_reason → OpenAI finish_reason。 */
export function openaiFinishReason(stopReason: unknown): string {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  return "stop";
}
