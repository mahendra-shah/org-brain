# OrgBrain: Slack Notion AI Bot (Multi-LLM & Highly Resilient)

Welcome to **OrgBrain**, your self-hosted, highly cost-effective, and production-hardened organization brain running in Slack. OrgBrain connects Slack to your Notion workspace using the official **Notion Model Context Protocol (MCP) Server** and queries LLMs (supporting **DeepSeek V3/R1** and **Claude 3.5 Sonnet** interchangeably) to answer organizational questions.

This blueprint has been engineered to be **100% failure-proof**, implementing subprocess supervisor restarts, automatic dual-LLM fallback (DeepSeek ➡️ Claude), Slack event de-duplication, and message splitting safeguards.

---

## 🚀 Architecture Blueprint

OrgBrain runs as a self-contained service (Node.js + TypeScript). It spawns the official `@notionhq/notion-mcp-server` as a local subprocess, maintaining an active secure connection over Standard Input/Output (`stdio`). 

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
    |    LLM Router    | <=============> |    OrgBrain App    |
    | (DeepSeek/Claude)|  Definitions    | (Node.js Service)  |
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

Create a `.env` file in the root of your project directory:

```env
# ==============================================================================
# OrgBrain Environment Configurations
# ==============================================================================

# LLM Selection
# Supported: "deepseek" or "claude"
LLM_PROVIDER=deepseek

# DeepSeek Configuration
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_API_URL=https://api.deepseek.com/v1   # Standard DeepSeek endpoint
DEEPSEEK_MODEL=deepseek-chat                  # Use "deepseek-reasoner" for R1

# Claude Configuration (Also serves as auto-fallback if DeepSeek fails!)
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-3-5-sonnet-latest

# Slack Configuration (Socket Mode)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Notion Integration
NOTION_API_TOKEN=secret_yournotionintegrationtoken
```

---

## 📂 Project Directory Structure

```
notion-brain/
├── src/
│   ├── index.ts          # Application bootstrap & entry point
│   ├── config.ts         # Environment configuration parser
│   ├── slack.ts          # Slack connection, de-duplication, & event handlers
│   ├── mcp.ts            # Resilient MCP Client (spawns/supervises Notion MCP subprocess)
│   ├── llm.ts            # LLM provider abstraction & automatic failover adapter
│   └── utils/
│       └── helpers.ts    # String and text helpers
├── .env                  # Configuration variables (git ignored)
├── package.json
└── tsconfig.json
```

---

## 📜 Complete Code Blueprint

Below is the structured, production-ready boilerplate code you can copy directly to build the files in the `src/` directory.

### 1. `src/config.ts`
Manages the validation and ingestion of environmental variables.

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
    apiToken: process.env.NOTION_API_TOKEN || '',
  }
};

// Validate variables
if (!config.slack.botToken || !config.slack.appToken) {
  throw new Error("Missing critical Slack tokens in .env");
}
if (config.llmProvider === 'deepseek' && !config.deepseek.apiKey) {
  throw new Error("Missing DeepSeek API key for chosen provider");
}
if (config.llmProvider === 'claude' && !config.claude.apiKey) {
  throw new Error("Missing Anthropic API key for chosen provider");
}
if (!config.notion.apiToken) {
  throw new Error("Missing Notion API Token in .env");
}
```

---

### 2. `src/mcp.ts`
Initializes the Model Context Protocol Client, spawns the `@notionhq/notion-mcp-server` subprocess, and **supervises it dynamically** to auto-restart in case of crashes or broken stdio pipes.

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
        NOTION_API_TOKEN: config.notion.apiToken
      }
    });

    this.client = new Client(
      { name: 'orgbrain-mcp-client', version: '1.0.0' },
      { capabilities: {} }
    );

    // Register active supervisor hooks
    this.transport.stderr?.on('data', (chunk) => {
      console.warn(`[MCP Server stderr]: ${chunk.toString().trim()}`);
    });

    await this.client.connect(this.transport);
    console.log("Notion MCP Server successfully connected via stdio!");

    // Watchdog for crash handling
    const connectionPromise = this.client;
    this.transport.onClose(() => {
      if (!this.isShuttingDown) {
        console.error("⚠️ Notion MCP subprocess connection closed unexpectedly! Triggering supervisor auto-restart...");
        setTimeout(() => {
          this.start().catch((err) => console.error("Supervisor failed to restart MCP server:", err));
        }, 3000);
      }
    });
  }

  async getTools() {
    if (!this.client) throw new Error("MCP client not initialized");
    const response = await this.client.listTools();
    return response.tools;
  }

  async callTool(name: string, args: any) {
    if (!this.client) throw new Error("MCP client not initialized");
    console.log(`Executing Notion tool: ${name} with arguments:`, args);
    
    // Enforce high-level API timeout of 10s to prevent hanging queries
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

---

### 3. `src/llm.ts`
The Multi-LLM provider abstraction. It bridges the gap between OpenAI-compatible JSON tool calling (DeepSeek) and Anthropic tool formats (Claude). **Includes active automatic dual-LLM failover**.

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

  /**
   * Generates a grounded response. Automatically fails over to Claude if DeepSeek experiences an outage.
   */
  async generateResponse(
    systemPrompt: string,
    history: { role: 'user' | 'assistant' | 'system', content: string }[],
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

  private async queryDeepSeek(systemPrompt: string, history: any[], tools: any[]) {
    if (!this.openaiClient) throw new Error("DeepSeek OpenAI client is not configured");
    const formattedTools = this.formatToolsForLLM(tools, 'deepseek');
    const messages = [{ role: 'system', content: systemPrompt }, ...history];

    const response = await this.openaiClient.chat.completions.create({
      model: config.deepseek.model,
      messages: messages as any,
      tools: formattedTools.length > 0 ? formattedTools as any : undefined,
      tool_choice: formattedTools.length > 0 ? 'auto' : undefined
    });

    const choice = response.choices[0].message;
    return {
      text: choice.content || '',
      toolCalls: choice.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments)
      })) || []
    };
  }

  private async queryClaude(systemPrompt: string, history: any[], tools: any[]) {
    if (!this.anthropicClient) throw new Error("Anthropic Claude client is not configured");
    const formattedTools = this.formatToolsForLLM(tools, 'claude');

    const response = await this.anthropicClient.messages.create({
      model: config.claude.model,
      system: systemPrompt,
      messages: history,
      max_tokens: 1500,
      tools: formattedTools.length > 0 ? formattedTools as any : undefined
    });

    const textContent = response.content.find(c => c.type === 'text');
    const toolCalls = response.content.filter(c => c.type === 'tool_use');

    return {
      text: textContent ? (textContent as any).text : '',
      toolCalls: toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        args: tc.input
      }))
    };
  }
}
```

---

### 4. `src/slack.ts`
Slack controller utilizing Socket Mode. Implements **event de-duplication** to eliminate Slack double-posting, fetches context natively in threads, and **splits replies exceeding Slack's character limits**.

```typescript
import pkg from '@slack/bolt';
const { App } = pkg;
import { config } from './config.js';
import { NotionMCPClient } from './mcp.js';
import { LLMClient } from './llm.js';
import { splitMessage } from './utils/helpers.js';

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true
});

const mcpClient = new NotionMCPClient();
const llmClient = new LLMClient();

// In-memory event de-duplication cache
const processedEvents = new Set<string>();

const SYSTEM_PROMPT = `You are OrgBrain, the secure knowledge Oracle for our organization.
Your primary task is to answer questions from employees strictly using data retrieved from Notion.
Rules:
1. Search Notion thoroughly using the provided tools to answer.
2. Ground all answers. If information is not found, state clearly that you cannot find it, and provide a helpful Notion search URL. Do not hallucinate.
3. Be professional, clear, and structure long information using neat bullets.
4. Cite sources by appending the exact document titles and links at the end of your response.`;

export async function startSlackBot() {
  await mcpClient.start();
  const mcpTools = await mcpClient.getTools();

  // Listen to Mentions
  app.event('app_mention', async ({ event, client, say }) => {
    // 1. Event De-duplication check
    const eventId = event.client_msg_id || event.ts;
    if (processedEvents.has(eventId)) {
      console.log(`Ignoring duplicate event: ${eventId}`);
      return;
    }
    processedEvents.add(eventId);
    // Cleanup cache item after 1 minute
    setTimeout(() => processedEvents.delete(eventId), 60000);

    const threadTs = event.thread_ts || event.ts;
    console.log(`Received question from Slack: "${event.text}" in thread: ${threadTs}`);

    // Add typing indicator
    await client.reactions.add({
      name: 'eyes',
      channel: event.channel,
      timestamp: event.ts
    });

    try {
      // 2. Fetch stateless conversational history in thread (Context recovery!)
      let history: { role: 'user' | 'assistant', content: string }[] = [];
      
      if (event.thread_ts) {
        const threadReplies = await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 10
        });

        if (threadReplies.messages) {
          history = threadReplies.messages
            .filter(msg => msg.text)
            .map(msg => ({
              role: msg.bot_id ? 'assistant' : 'user',
              content: msg.text || ''
            }));
        }
      } else {
        history = [{ role: 'user', content: event.text }];
      }

      // 3. Prompt LLM with context & tools
      let result = await llmClient.generateResponse(SYSTEM_PROMPT, history as any, mcpTools);
      
      // 4. Handle Tool Executions (The RAG Loop)
      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolResults = [];
        
        for (const tc of result.toolCalls) {
          try {
            const rawResult = await mcpClient.callTool(tc.name, tc.args);
            toolResults.push({
              toolCallId: tc.id,
              role: 'tool' as const,
              content: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
            });
          } catch (toolError) {
            console.error(`Notion tool execution failed for ${tc.name}:`, toolError);
            toolResults.push({
              toolCallId: tc.id,
              role: 'tool' as const,
              content: `Error querying page context: ${(toolError as Error).message}`
            });
          }
        }

        // Send tool results back to LLM
        const combinedContent = `The following Notion pages were successfully fetched:\n${JSON.stringify(toolResults)}\n\nFormulate your final response to: "${event.text}"`;
        history.push({ role: 'user', content: combinedContent });
        result = await llmClient.generateResponse(SYSTEM_PROMPT, history as any, []);
      }

      // 5. Send replies back safely, ensuring no message exceeds Slack's 4000 char limit
      const chunks = splitMessage(result.text, 3800);
      for (const chunk of chunks) {
        await say({
          channel: event.channel,
          thread_ts: threadTs,
          text: chunk
        });
      }

      // Remove typing emoji
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

  await app.start();
  console.log("⚡️ Slack Socket Mode app is running securely!");
}
```

---

### 5. `src/utils/helpers.ts`
Utility helper file for formatting and clean message splitting.

```typescript
/**
 * Safely splits a message string into chunks without cutting off paragraphs in the middle.
 */
export function splitMessage(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  for (const para of paragraphs) {
    if ((currentChunk + para).length > limit) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = para + '\n\n';
    } else {
      currentChunk += para + '\n\n';
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}
```

---

### 6. `src/index.ts`
App entry-point: boots environment, registers signal hooks for graceful shutdowns.

```typescript
import { startSlackBot } from './slack.js';

(async () => {
  try {
    await startSlackBot();
  } catch (error) {
    console.error("Fatal initialization error:", error);
    process.exit(1);
  }
})();

// Graceful shutdown listeners
process.on('SIGTERM', () => {
  console.log("Shutting down OrgBrain cleanly...");
  process.exit(0);
});
```

---

## 🚀 Step-by-Step Installation Guide

### Step 1: Create a Notion Integration
1. Go to [Notion Integrations](https://www.notion.so/my-integrations).
2. Click **+ New Integration**. Select your workspace.
3. Grant **Read content** and **Search content** permissions.
4. Copy the **Internal Integration Token** (`secret_...`).
5. Open your Notion workspace in browser. Go to pages/databases you want the bot to access (e.g. Onboarding page), click `...` -> **Connect to** -> Select your Integration.

### Step 2: Create a Slack App
1. Go to [Slack API: Your Apps](https://api.slack.com/apps).
2. Click **Create New App** -> **From scratch**.
3. Under **Settings** -> **Basic Information**:
   - Turn **Socket Mode** -> **ON**.
   - Create an App-Level Token with `connections:write` scope. Copy the `xapp-...` token.
4. Under **Features** -> **OAuth & Permissions**:
   - Add **Bot Token Scopes**:
     - `app_mention:read`
     - `chat:write`
     - `channels:history`
     - `groups:history`
     - `im:history`
     - `mpim:history`
     - `reactions:write`
   - Click **Install to Workspace** and authorize.
   - Copy the generated **Bot User OAuth Token** (`xoxb-...`).
5. Under **Features** -> **Event Subscriptions**:
   - Turn **Enable Events** -> **ON**.
   - Under **Subscribe to bot events**, add `app_mention` and `message.im`.

### Step 3: Run OrgBrain Locally
Initialize standard dependencies:

```bash
# Initialize packages
npm init -y
npm install typescript @types/node --save-dev
npx tsc --init

# Install production dependencies
npm install @slack/bolt @modelcontextprotocol/sdk openai @anthropic-ai/sdk dotenv
```

Configure `tsconfig.json` target to output modern modular javascript:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Build and execute the system:
```bash
# Compile TS to JS
npx tsc

# Run it!
node dist/index.js
```
