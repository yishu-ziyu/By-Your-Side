import type { Context } from "@earendil-works/pi-ai";

/**
 * 模型实际收到的系统提示词、工具和对话。Pi 1.0 的循环把提示词和工具放进请求开头的 system 消息；
 * 单次判断调用仍直接带 systemPrompt、tools。两种写法都按模型看到的内容读出来。
 */
export function seenByModel(context: Context) {
  const system = context.messages.find(message => message.role === "system");
  const leading = system?.role === "system" ? system : undefined;
  const text = Array.isArray(leading?.content) ? leading.content.map(part => part.text).join("") : leading?.content;

  return {
    systemPrompt: context.systemPrompt ?? text,
    tools: context.tools ?? leading?.toolsAdded,
    messages: context.messages.filter(message => message.role !== "system"),
  };
}
