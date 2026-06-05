# OrgBrain: Slack & Web Notion AI Oracle (Multi-LLM & Highly Resilient)

Welcome to **OrgBrain**, a self-hosted, highly cost-effective, and production-hardened organization brain. OrgBrain connects Slack and a local glassmorphic Web QA dashboard to your Notion workspace using the official **Notion Model Context Protocol (MCP) Server**. It orchestrates advanced LLM routing (supporting **DeepSeek V3/R1** and **Claude 3.5 Sonnet** interchangeably) to answer organizational questions in real-time.

This project is engineered to be **100% resilient**, implementing subprocess supervisor watchdogs, automatic dual-LLM fallback (DeepSeek ➡️ Claude), input content safety filters, Slack event de-duplication, and message splitting safeguards.

---

## 🚀 Architecture Blueprint

OrgBrain runs as a self-contained service (Node.js + TypeScript). On startup, it queries the Notion workspace to pre-fetch database metadata for zero-search RAG routing, boots up an Express API server with a static frontend, spawns the official `@notionhq/notion-mcp-server` as a supervised subprocess over `stdio`, and connects securely to Slack in Socket Mode.

```
                                      +--------------------+
                                      |    Slack Channel   |
                                      +--------------------+
                                                |
                                                | 1. @mention Bot
                                                v
                                      +--------------------+
                                      |     Slack App      |
                                      |   (Socket Mode)    |
                                      +--------------------+
                                                |
                                                | 2. Raw query
                                                v
    +------------------+  3. Parse Tool  +--------------------+
    |    LLM Router    | <=============> |    OrgBrain App    | <===[HTTP POST]===> [ Web QA Dashboard ]
    | (DeepSeek/Claude)|  Definitions    | (Node.js Service)  |                     (Port 3000 Front-End)
    +------------------+                 +--------------------+
             ^                                  |
             | 5. Process grounded              | 4. Spawn Notion
             |    responses                     |    MCP Server
             v                                  v
    +------------------+                 +--------------------+
    |   Slack Thread   |                 | Notion MCP Server  |
    | (Formated Reply) |                 | (Local Subprocess) |
    +------------------+                 +--------------------+
```

---

## ⚙️ Configuration Setup (`.env`)

Create a `.env` file in the root of your project directory. This file is gitignored to protect sensitive credentials.

```env
# ==============================================================================
# OrgBrain Environment Configurations
# ==============================================================================

# LLM Selection
# Supported: "deepseek" or "claude"
LLM_PROVIDER=deepseek

# DeepSeek Configuration (Primary)
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_API_URL=https://api.deepseek.com/v1   # Standard DeepSeek endpoint
DEEPSEEK_MODEL=deepseek-chat                  # Use "deepseek-reasoner" for R1

# Claude Configuration (Also serves as auto-failover if DeepSeek has an outage!)
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-3-5-sonnet-latest

# Slack Configuration (Socket Mode)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Notion Integration
NOTION_API_TOKEN=secret_yournotionintegrationtoken

# Diagnostic Metadata Settings
SHOW_DEV_METADATA=true
```

---

## 📂 Project Directory Structure

Click any file to inspect the source code directly:

*   [src/config.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/config.ts) — Validates and ingests environmental variables.
*   [src/mcp.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/mcp.ts) — Launches and supervises the Notion MCP subprocess client.
*   [src/llm.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/llm.ts) — LLM provider API interface with automatic Claude failover.
*   [src/server.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/server.ts) — Boots the Express web API server and serves the Web QA Dashboard.
*   [src/index.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/index.ts) — Main entry point: establishes the Slack Bolt client and coordinates parallel boots.
*   `src/utils/` — Core business logic utilities:
    *   [src/utils/notion.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/notion.ts) — Compiles database schema maps and builds prompts with pre-mapped user IDs.
    *   [src/utils/filters.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/filters.ts) — Security content checks that intercept and block sensitive inputs.
    *   [src/utils/helpers.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/helpers.ts) — Truncation, Slack mrkdwn formatting, and long message splitting.
*   [tests/](file:///Users/mahendra/work-dir/personal-p/notion-brain/tests) — Gitignored local test folder for sandbox scripts.
*   [public/](file:///Users/mahendra/work-dir/personal-p/notion-brain/public) — Static visual dashboard front-end (index.html, style.css, app.js).

---

## 📜 Complete Code Blueprint

Below is the production-ready codebase structure:

### 1. Configuration Client ([src/config.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/config.ts))
```typescript
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  llmProvider: (process.env.LLM_PROVIDER || 'deepseek').toLowerCase() as 'deepseek' | 'claude',
  
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
  },
  
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
  },
  
  notion: {
    apiToken: process.env.NOTION_TOKEN || process.env.NOTION_API_TOKEN || '',
  },
  
  showDevMetadata: process.env.SHOW_DEV_METADATA === 'true'
};

// Validate variables on initialization
if (!config.slack.botToken || !config.slack.appToken) {
  throw new Error("Missing critical Slack tokens in .env. Both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be specified.");
}
if (config.llmProvider === 'deepseek' && !config.deepseek.apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY in .env for deepseek provider selection.");
}
if (config.llmProvider === 'claude' && !config.claude.apiKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in .env for claude provider selection.");
}
if (!config.notion.apiToken) {
  throw new Error("Missing NOTION_API_TOKEN in .env. Notion integration token is required.");
}
```

### 2. Supervised MCP Subprocess Manager ([src/mcp.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/mcp.ts))
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config.js';

export class NotionMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isShuttingDown = false;

  async start() {
    this.isShuttingDown = false;
    console.log("Spawning Notion MCP Server subprocess...");
    
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        ...process.env,
        NOTION_TOKEN: config.notion.apiToken,
        NOTION_API_TOKEN: config.notion.apiToken
      }
    });

    this.client = new Client(
      { name: 'orgbrain-mcp-client', version: '1.0.0' },
      { capabilities: {} }
    );

    this.transport.stderr?.on('data', (chunk) => {
      console.warn(`[MCP Server stderr]: ${chunk.toString().trim()}`);
    });

    await this.client.connect(this.transport);
    console.log("Notion MCP Server successfully connected via stdio!");

    this.transport.onclose = () => {
      if (!this.isShuttingDown) {
        console.error("⚠️ Notion MCP subprocess connection closed unexpectedly! Triggering supervisor auto-restart in 3 seconds...");
        setTimeout(() => {
          this.start().catch((err) => console.error("Supervisor failed to restart MCP server:", err));
        }, 3000);
      }
    };
  }

  async getTools() {
    if (!this.client) throw new Error("MCP client not initialized");
    const response = await this.client.listTools();
    return response.tools;
  }

  async callTool(name: string, args: any) {
    if (!this.client) throw new Error("MCP client not initialized");
    console.log(`Executing Notion tool: ${name} with arguments:`, args);
    
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Notion MCP query timed out for tool ${name}`)), 10000)
    );

    const callPromise = this.client.callTool({ name, arguments: args });
    return await Promise.race([callPromise, timeout]);
  }

  async close() {
    this.isShuttingDown = true;
    if (this.transport) {
      await this.transport.close();
      console.log("Notion MCP Server connection closed cleanly.");
    }
  }
}
```

### 3. Multi-LLM API Abstraction ([src/llm.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/llm.ts))
```typescript
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
    if (config.deepseek.apiKey) {
      this.openaiClient = new OpenAI({
        apiKey: config.deepseek.apiKey,
        baseURL: config.deepseek.apiUrl
      });
    }
    if (config.claude.apiKey) {
      this.anthropicClient = new Anthropic({
        apiKey: config.claude.apiKey
      });
    }
  }

  formatToolsForLLM(mcpTools: any[], targetProvider: 'deepseek' | 'claude') {
    if (targetProvider === 'deepseek') {
      return mcpTools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }));
    } else {
      return mcpTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));
    }
  }

  async generateResponse(systemPrompt: string, history: any[], tools: any[]) {
    const provider = config.llmProvider;
    try {
      if (provider === 'deepseek') {
        return await this.queryDeepSeek(systemPrompt, history, tools);
      } else {
        return await this.queryClaude(systemPrompt, history, tools);
      }
    } catch (error) {
      console.error(`🚨 Primary LLM provider (${provider}) failed. Triggering resilience failover...`, error);
      
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
      if (msg.role === 'system') continue;
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
```

### 4. Express Server QA Web API ([src/server.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/server.ts))
```typescript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { NotionMCPClient } from './mcp.js';
import { LLMClient } from './llm.js';
import { isQuerySensitive, getSensitiveBlockMessage } from './utils/filters.js';
import { compressMCPToolResult, cleanHistoryMessage } from './utils/helpers.js';
import { getSystemPrompt } from './utils/notion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startWebServer(mcpClient: NotionMCPClient, llmClient: LLMClient, databasesMap: string) {
  const app = express();
  const port = process.env.PORT || 3000;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/api/config', (req, res) => {
    res.json({
      llmProvider: config.llmProvider,
      model: config.llmProvider === 'deepseek' ? config.deepseek.model : config.claude.model,
      slackConfigured: !!(config.slack.botToken && config.slack.appToken),
      showDevMetadata: config.showDevMetadata,
      notionToken: config.showDevMetadata ? config.notion.apiToken : undefined
    });
  });

  app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    if (isQuerySensitive(message)) {
      return res.json({
        text: getSensitiveBlockMessage(),
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      });
    }

    try {
      const mcpTools = await mcpClient.getTools();
      const filteredTools = mcpTools.filter(tool => {
        const name = tool.name.toLowerCase();
        return name.startsWith('api-get-') || 
               name.startsWith('api-retrieve-') || 
               name.includes('search') || 
               name.includes('query');
      });

      const formattedHistory: any[] = history ? history.map((h: any) => ({
        role: h.role,
        content: cleanHistoryMessage(h.content || '')
      })) : [];

      const persistentHistoryCount = formattedHistory.length;
      const systemPrompt = getSystemPrompt(databasesMap);

      formattedHistory.push({ role: 'user', content: message });

      let result = await llmClient.generateResponse(systemPrompt, formattedHistory, filteredTools);

      let turns = 0;
      const maxTurns = 10;

      while (result.toolCalls && result.toolCalls.length > 0 && turns < maxTurns) {
        turns++;
        const toolResults = [];
        
        for (const tc of result.toolCalls) {
          try {
            const rawResult = await mcpClient.callTool(tc.name, tc.args);
            toolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              role: 'tool' as const,
              content: compressMCPToolResult(rawResult)
            });
          } catch (toolError) {
            console.error(`Notion tool execution failed for ${tc.name} in Web UI:`, toolError);
            toolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              role: 'tool' as const,
              content: `Error querying page context: ${(toolError as Error).message}`
            });
          }
        }

        formattedHistory.push({
          role: 'assistant',
          content: result.text || null,
          toolCalls: result.toolCalls
        });

        formattedHistory.push({
          role: 'tool_responses',
          responses: toolResults
        });

        result = await llmClient.generateResponse(systemPrompt, formattedHistory, filteredTools);
      }

      const citations: { title: string, url: string }[] = [];
      const notionUrlRegex = /\[([^\]]+)\]\((https:\/\/www\.notion\.so\/[a-zA-Z0-9-_\/]+)\)/g;
      let match;
      while ((match = notionUrlRegex.exec(result.text)) !== null) {
        citations.push({
          title: match[1],
          url: match[2]
        });
      }

      res.json({
        text: result.text,
        citations: citations,
        usage: result.usage,
        showDevMetadata: config.showDevMetadata,
        historyCount: persistentHistoryCount + 1,
        notionToken: config.showDevMetadata ? config.notion.apiToken : undefined
      });

    } catch (error) {
      console.error("Web chat controller processing error:", error);
      res.status(500).json({ error: "Failed to answer. Check backend server console logs." });
    }
  });

  app.listen(port, () => {
    console.log(`✨ Local QA Web UI is online and running on http://localhost:${port}`);
  });
}
```

### 5. Application Bootstrap Gateway ([src/index.ts](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/index.ts))
```typescript
import { NotionMCPClient } from './mcp.js';
import { LLMClient } from './llm.js';
import { startWebServer } from './server.js';
import pkg from '@slack/bolt';
const { App } = pkg;
import { config } from './config.js';
import { splitMessage, compressMCPToolResult, formatSlackMessage, cleanHistoryMessage } from './utils/helpers.js';
import { isQuerySensitive, getSensitiveBlockMessage } from './utils/filters.js';
import { fetchWorkspaceDatabases, getSystemPrompt } from './utils/notion.js';

const mcpClient = new NotionMCPClient();
const llmClient = new LLMClient();
const processedEvents = new Set<string>();
let slackApp: any = null;

if (config.slack.botToken && config.slack.appToken) {
  slackApp = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true
  });

  slackApp.error(async (error: any) => {
    console.warn("⚠️ Slack Bolt App background error encountered:", error.message || error);
  });
}

async function startSlackBot(mcpTools: any[], databasesMap: string) {
  if (!slackApp) {
    console.warn("⚠️ Slack tokens not fully configured in .env. Skipping Slack bot start (Web-Only Mode active).");
    return;
  }

  slackApp.event('app_mention', async ({ event, client, say }: any) => {
    const eventId = event.client_msg_id || event.ts;
    if (processedEvents.has(eventId)) return;
    processedEvents.add(eventId);
    setTimeout(() => processedEvents.delete(eventId), 60000);

    const threadTs = event.thread_ts || event.ts;
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (isQuerySensitive(cleanText)) {
      await say({
        channel: event.channel,
        thread_ts: threadTs,
        text: getSensitiveBlockMessage()
      });
      return;
    }

    await client.reactions.add({
      name: 'eyes',
      channel: event.channel,
      timestamp: event.ts
    });

    const filteredTools = mcpTools.filter(tool => {
      const name = tool.name.toLowerCase();
      return name.startsWith('api-get-') || 
             name.startsWith('api-retrieve-') || 
             name.includes('search') || 
             name.includes('query');
    });

    try {
      let history: any[] = [];
      
      if (event.thread_ts) {
        const threadReplies = await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 10
        });
 
        if (threadReplies.messages) {
          history = threadReplies.messages
            .filter((msg: any) => msg.text)
            .map((msg: any) => ({
              role: msg.bot_id ? 'assistant' : 'user',
              content: cleanHistoryMessage(msg.text || '')
            }));
        }
      } else {
        const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
        history = [{ role: 'user', content: cleanText }];
      }

      const persistentHistoryCount = history.length;
      const systemPrompt = getSystemPrompt(databasesMap);

      let result = await llmClient.generateResponse(systemPrompt, history as any, filteredTools);
      
      let turns = 0;
      const maxTurns = 10;

      while (result.toolCalls && result.toolCalls.length > 0 && turns < maxTurns) {
        turns++;
        const toolResults = [];
        
        for (const tc of result.toolCalls) {
          try {
            const rawResult = await mcpClient.callTool(tc.name, tc.args);
            toolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              role: 'tool' as const,
              content: compressMCPToolResult(rawResult)
            });
          } catch (toolError) {
            console.error(`Notion tool execution failed for ${tc.name}:`, toolError);
            toolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              role: 'tool' as const,
              content: `Error querying page context: ${(toolError as Error).message}`
            });
          }
        }

        history.push({
          role: 'assistant',
          content: result.text || null,
          toolCalls: result.toolCalls
        });

        history.push({
          role: 'tool_responses',
          responses: toolResults
        });

        result = await llmClient.generateResponse(systemPrompt, history as any, filteredTools);
      }

      const formattedSlackText = formatSlackMessage(result.text, result.usage, persistentHistoryCount);
      const chunks = splitMessage(formattedSlackText, 3800);
      for (const chunk of chunks) {
        await say({
          channel: event.channel,
          thread_ts: threadTs,
          text: chunk
        });
      }

      await client.reactions.remove({
        name: 'eyes',
        channel: event.channel,
        timestamp: event.ts
      });
      
    } catch (error) {
      console.error("Error processing Slack message event:", error);
      await say({
        channel: event.channel,
        thread_ts: threadTs,
        text: "🚨 Sorry! I ran into an error accessing our Notion Brain. Please notify my administrator."
      });
    }
  });

  slackApp.event('reaction_added', async ({ event }: any) => {
    if (event.reaction === 'thumbsup' || event.reaction === 'thumbsdown') {
      console.log(`👍👎 Slack Feedback received: reacted with :${event.reaction}:`);
    }
  });

  try {
    await slackApp.start();
    console.log("⚡️ Slack Socket Mode app is running securely!");
  } catch (error) {
    console.warn("⚠️ Slack Connection Failed. Continuing in Web-Only Mode!");
  }
}

(async () => {
  try {
    console.log(`🔧 OrgBrain Boot Configurations — Provider: ${config.llmProvider.toUpperCase()}, Show Dev Metadata: ${config.showDevMetadata}`);
    await mcpClient.start();
    const mcpTools = await mcpClient.getTools();
    const databasesMap = await fetchWorkspaceDatabases(mcpClient);
    startWebServer(mcpClient, llmClient, databasesMap);
    startSlackBot(mcpTools, databasesMap).catch((err) => {
      console.warn("⚠️ Slack bot failed to boot in background. Continuing in Web-Only Mode!", err);
    });
  } catch (error) {
    console.error("Fatal initialization error:", error);
    process.exit(1);
  }
})();

const handleShutdown = async (signal: string) => {
  console.log(`${signal} received. Shutting down OrgBrain cleanly...`);
  await mcpClient.close();
  if (slackApp) {
    try {
      await slackApp.stop();
    } catch (err) {}
  }
  process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
```

---

## 🧪 Testing and Offline Sandbox

The codebase contains a dedicated, gitignored folder [tests/](file:///Users/mahendra/work-dir/personal-p/notion-brain/tests) for developers to run standalone test simulations of the RAG pipeline without needing to deploy the Slack gateway.

### Available Standalone Test Scripts
*   `tests/test-chat-rag.ts` — Tests the multi-turn conversational loop, token compression, and database retrieval.
*   `tests/get_users.ts` — Standalone tool to discover, paginate, and list all Notion User IDs mapped to emails.

To run the offline chat-RAG test simulation:
```bash
# Run the stand-alone test runner directly using modern TSX execution
npx tsx tests/test-chat-rag.ts
```

---

## 🚀 Step-by-Step Installation Guide

### Step 1: Create a Notion Integration
1. Go to [Notion Integrations](https://www.notion.so/my-integrations).
2. Click **+ New Integration**. Select your workspace.
3. Grant **Read content** and **Search content** permissions.
4. Copy the **Internal Integration Token** (`secret_...`).
5. Open your Notion workspace in a browser. Go to pages/databases you want the bot to access (e.g. Onboarding page), click `...` ➡️ **Connect to** ➡️ Select your Integration.

### Step 2: Create a Slack App
1. Go to [Slack API: Your Apps](https://api.slack.com/apps).
2. Click **Create New App** ➡️ **From scratch**.
3. Under **Settings** ➡️ **Basic Information**:
   - Turn **Socket Mode** ➡️ **ON**.
   - Create an App-Level Token with `connections:write` scope. Copy the `xapp-...` token.
4. Under **Features** ➡️ **OAuth & Permissions**:
   - Add **Bot Token Scopes**:
     - `app_mention:read`
     - `chat:write`
     - `channels:history`
     - `groups:history`
     - `im:history`
     - `reactions:write`
   - Click **Install to Workspace** and authorize.
   - Copy the generated **Bot User OAuth Token** (`xoxb-...`).
5. Under **Features** ➡️ **Event Subscriptions**:
   - Turn **Enable Events** ➡️ **ON**.
   - Under **Subscribe to bot events**, add `app_mention`.

### Step 3: Run OrgBrain Locally
Initialize standard dependencies:

```bash
# Install package dependencies
npm install

# Compile TS to JS
npm run build

# Run it!
npm start
```
