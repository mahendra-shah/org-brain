import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

export class LLMClient {
  private openaiClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;

  constructor() {
    this.initializeClients();
  }

  private initializeClients() {
    // DeepSeek API is OpenAI-compatible
    if (config.deepseek.apiKey) {
      this.openaiClient = new OpenAI({
        apiKey: config.deepseek.apiKey,
        baseURL: config.deepseek.apiUrl
      });
    }
    // Claude API
    if (config.claude.apiKey) {
      this.anthropicClient = new Anthropic({
        apiKey: config.claude.apiKey
      });
    }
  }

  /**
   * Translates standardized MCP tool definitions to standard OpenAI / Anthropic format.
   */
  formatToolsForLLM(mcpTools: any[], targetProvider: 'deepseek' | 'claude') {
    if (targetProvider === 'deepseek') {
      // OpenAI/DeepSeek schema
      return mcpTools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }));
    } else {
      // Anthropic schema
      return mcpTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));
    }
  }

  /**
   * Generates a grounded response. Automatically fails over to Claude if DeepSeek experiences an outage or timeout.
   */
  async generateResponse(
    systemPrompt: string,
    history: any[],
    tools: any[]
  ) {
    const provider = config.llmProvider;
    try {
      if (provider === 'deepseek') {
        return await this.queryDeepSeek(systemPrompt, history, tools);
      } else {
        return await this.queryClaude(systemPrompt, history, tools);
      }
    } catch (error) {
      console.error(`🚨 Primary LLM provider (${provider}) failed. Triggering resilience failover...`, error);
      
      // If DeepSeek was primary and Claude credentials exist, fall back to Claude
      if (provider === 'deepseek' && this.anthropicClient) {
        console.warn("🔄 Failover: Querying Claude 3.5 Sonnet to answer the user query...");
        try {
          return await this.queryClaude(systemPrompt, history, tools);
        } catch (fallbackError) {
          console.error("Critical: Fallback provider (Claude) also failed!", fallbackError);
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  private mapMessagesForOpenAI(messages: any[]): any[] {
    const result: any[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool_responses') {
        for (const resp of msg.responses) {
          result.push({
            role: 'tool',
            tool_call_id: resp.toolCallId,
            name: resp.toolName,
            content: resp.content
          });
        }
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
            }
          }))
        });
      } else {
        result.push({
          role: msg.role,
          content: msg.content
        });
      }
    }
    return result;
  }

  private mapMessagesForClaude(messages: any[]): any[] {
    const result: any[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }
      if (msg.role === 'tool_responses') {
        result.push({
          role: 'user',
          content: msg.responses.map((resp: any) => ({
            type: 'tool_result',
            tool_use_id: resp.toolCallId,
            content: resp.content
          }))
        });
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: any[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        msg.toolCalls.forEach((tc: any) => {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args
          });
        });
        result.push({
          role: 'assistant',
          content: blocks
        });
      } else {
        result.push({
          role: msg.role,
          content: msg.content
        });
      }
    }
    return result;
  }

  private async queryDeepSeek(systemPrompt: string, history: any[], tools: any[]) {
    if (!this.openaiClient) throw new Error("DeepSeek OpenAI client is not configured");
    const formattedTools = this.formatToolsForLLM(tools, 'deepseek');
    
    // In OpenAI, the system prompt is injected as the first system message
    const nativeMessages = this.mapMessagesForOpenAI(history);
    const messages = [{ role: 'system', content: systemPrompt }, ...nativeMessages];

    const response = await this.openaiClient.chat.completions.create({
      model: config.deepseek.model,
      messages: messages as any,
      tools: formattedTools.length > 0 ? (formattedTools as any) : undefined,
      tool_choice: formattedTools.length > 0 ? 'auto' : undefined
    });

    const choice = response.choices[0].message;
    return {
      text: choice.content || '',
      toolCalls: choice.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments)
      })) || [],
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens
      } : undefined
    };
  }

  private async queryClaude(systemPrompt: string, history: any[], tools: any[]) {
    if (!this.anthropicClient) throw new Error("Anthropic Claude client is not configured");
    const formattedTools = this.formatToolsForLLM(tools, 'claude');
    const nativeMessages = this.mapMessagesForClaude(history);

    // Anthropic API uses a system parameter and an array of user/assistant messages
    const response = await this.anthropicClient.messages.create({
      model: config.claude.model,
      system: systemPrompt,
      messages: nativeMessages,
      max_tokens: 1500,
      tools: formattedTools.length > 0 ? (formattedTools as any) : undefined
    } as any);

    const textContent = response.content.find(c => c.type === 'text');
    const toolCalls = response.content.filter(c => (c as any).type === 'tool_use');

    return {
      text: textContent ? (textContent as any).text : '',
      toolCalls: toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        args: tc.input
      })),
      usage: (response as any).usage ? {
        inputTokens: (response as any).usage.input_tokens,
        outputTokens: (response as any).usage.output_tokens
      } : undefined
    };
  }
}
