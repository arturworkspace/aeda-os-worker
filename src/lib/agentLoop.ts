import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';

export interface LoopTool {
  schema: {
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface LoopConfig {
  model: string;
  systemPrompt: string;
  initialMessage: string;
  customTools: LoopTool[];
  builtInTools?: object[];
  maxIterations?: number;
  agentId: string;
  jobName: string;
}

export interface LoopResult {
  finalResponse: string;
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runAgentLoop(config: LoopConfig): Promise<LoopResult> {
  const client = new Anthropic();
  const maxIterations = config.maxIterations ?? 30;

  const allTools = [
    ...(config.builtInTools ?? []),
    ...config.customTools.map(t => t.schema),
  ];

  const handlerMap = new Map<string, LoopTool['handler']>();
  for (const tool of config.customTools) {
    handlerMap.set(tool.schema.name, tool.handler);
  }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: config.initialMessage }
  ];

  let iterations = 0;
  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalResponse = '';

  const db = await getDb();
  const auditLog = db.collection('os_audit_log');

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model: config.model,
      max_tokens: 4096,
      system: config.systemPrompt,
      tools: allTools as Anthropic.Tool[],
      messages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    const textBlocks = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('');

    if (textBlocks) finalResponse = textBlocks;

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        b => b.type === 'tool_use'
      ) as Anthropic.ToolUseBlock[];

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const handler = handlerMap.get(toolUse.name);

        if (handler) {
          toolCallCount++;
          let result: unknown;
          let isError = false;

          try {
            result = await handler(toolUse.input as Record<string, unknown>);
            await auditLog.insertOne({
              agentId: config.agentId,
              jobName: config.jobName,
              action: 'tool_call',
              toolName: toolUse.name,
              input: toolUse.input,
              result: typeof result === 'string'
                ? result.slice(0, 500)
                : JSON.stringify(result).slice(0, 500),
              createdAt: new Date(),
            });
          } catch (err) {
            isError = true;
            result = `Error: ${(err as Error).message}`;
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string'
              ? result
              : JSON.stringify(result),
            is_error: isError,
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: '',
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  if (iterations >= maxIterations) {
    await auditLog.insertOne({
      agentId: config.agentId,
      jobName: config.jobName,
      action: 'loop_max_iterations_reached',
      iterations,
      toolCallCount,
      createdAt: new Date(),
    });
  }

  return {
    finalResponse,
    iterations,
    toolCallCount,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}
