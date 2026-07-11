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

export interface ContextManagementEdit {
  type: 'clear_tool_uses_20250919';
  trigger?: { type: 'input_tokens' | 'tool_uses'; value: number };
  keep?: { type: 'tool_uses'; value: number };
  clear_at_least?: { type: 'input_tokens'; value: number };
  exclude_tools?: string[];
  clear_tool_inputs?: boolean;
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
  contextManagement?: {
    edits: ContextManagementEdit[];
  };
}

export interface ContextEditStats {
  type: string;
  cleared_tool_uses?: number;
  cleared_input_tokens?: number;
}

export interface LoopResult {
  finalResponse: string;
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  contextEditsApplied?: ContextEditStats[];
  tokensSavedByEdits?: number;
}

export async function runAgentLoop(config: LoopConfig): Promise<LoopResult> {
  const client = new Anthropic();
  const maxIterations = config.maxIterations ?? 30;
  const useContextManagement = !!config.contextManagement?.edits?.length;

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
  const allContextEdits: ContextEditStats[] = [];
  let totalTokensSavedByEdits = 0;

  const db = await getDb();
  const auditLog = db.collection('os_audit_log');

  while (iterations < maxIterations) {
    iterations++;

    // Use beta API if context management is enabled
    let response: Anthropic.Message;
    if (useContextManagement) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const betaResponse = await (client.beta.messages.create as any)({
        model: config.model,
        max_tokens: 4096,
        system: config.systemPrompt,
        tools: allTools,
        messages,
        betas: ['context-management-2025-06-27'],
        context_management: config.contextManagement,
      });
      response = betaResponse as Anthropic.Message;

      // Track context edits applied
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contextMgmt = (betaResponse as any).context_management;
      if (contextMgmt?.applied_edits?.length) {
        for (const edit of contextMgmt.applied_edits) {
          allContextEdits.push({
            type: edit.type,
            cleared_tool_uses: edit.cleared_tool_uses,
            cleared_input_tokens: edit.cleared_input_tokens,
          });
          if (edit.cleared_input_tokens) {
            totalTokensSavedByEdits += edit.cleared_input_tokens;
          }
        }
      }
    } else {
      response = await client.messages.create({
        model: config.model,
        max_tokens: 4096,
        system: config.systemPrompt,
        tools: allTools as Anthropic.Tool[],
        messages,
      });
    }

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

  const result: LoopResult = {
    finalResponse,
    iterations,
    toolCallCount,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
  if (allContextEdits.length > 0) {
    result.contextEditsApplied = allContextEdits;
  }
  if (totalTokensSavedByEdits > 0) {
    result.tokensSavedByEdits = totalTokensSavedByEdits;
  }
  return result;
}
