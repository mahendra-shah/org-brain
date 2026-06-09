# OrgBrain: Slack & Web Notion AI Oracle (Multi-LLM & Highly Resilient)

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Notion MCP](https://img.shields.io/badge/Notion%20MCP-black?style=for-the-badge&logo=notion&logoColor=white)](https://github.com/modelcontextprotocol/servers)
[![Slack Bolt](https://img.shields.io/badge/Slack%20Bolt-4A154B?style=for-the-badge&logo=slack&logoColor=white)](https://slack.dev/bolt-js/)

Welcome to **OrgBrain**, a self-hosted, highly cost-effective, and production-hardened organization knowledge base assistant (RAG). OrgBrain connects Slack and a local glassmorphic Web QA dashboard to your Notion workspace using the official **Notion Model Context Protocol (MCP) Server**. It orchestrates advanced LLM routing (supporting **DeepSeek V3/R1** and **Claude 3.5 Sonnet**) to answer organizational questions in real-time.

OrgBrain is engineered to be **100% resilient**, implementing subprocess supervisor watchdogs, automatic multi-LLM fallback (DeepSeek ➡️ Gemini), input content safety filters, Slack event de-duplication, and message-splitting safeguards.

---

## ✨ Key Features

- **Router-Generator Split (Single-Turn RAG)**: Slashes input token costs by 80%+ and reduces RAG turns to a predictable, single-round tool call flow.
- **Local Server-Side Caching**: Fast 15-minute in-memory TTL caching with thread-aware history hashing (serves repeated thread queries in 0ms).
- **Subprocess MCP Supervisor**: Spawns and monitors the official `@notionhq/notion-mcp-server` over `stdio` with auto-restart on unexpected crashes.
- **Multi-LLM API Client with Failover**: Seamless integration with DeepSeek (V3/R1) and Claude 3.5 Sonnet, including automatic provider-level failover.
- **Dynamic User Identity Resolution**: Resolves Slack users' names/emails against workspace users to answer self-referential queries (*"what are my tasks?"*) without hardcoded names or IDs.
- **Interactive Cost Dashboard**: Glassmorphic dashboard to track token usage, region costs (ap-south-1 Mumbai), and comparative savings.
- **Robust Schema & Query Safeguards**: Automatically detects property types and avoids invalid filters (e.g. status/select options) that trigger 400 Bad Request errors.

---

## 🚀 Architecture Blueprint

```mermaid
sequenceDiagram
    participant User as Slack / Web User
    participant App as OrgBrain Service
    participant Cache as Memory Cache
    participant Router as LLM Router
    participant Notion as Notion MCP (Subprocess)
    participant Gen as LLM Generator

    User->>App: Submits Query
    App->>Cache: Check Cached Response
    alt Cache Hit
        Cache-->>User: Return Cached Result (0ms)
    else Cache Miss
        App->>Router: Turn 1: Router Prompt + Query
        Router-->>App: Return Tool Calls JSON
        App->>Notion: Execute Tool Calls (Parallel)
        Notion-->>App: Return Markdown/JSON Context
        App->>App: Programmatic Context Enhancement
        App->>Gen: Turn 2: Inject Context + Generate Answer
        Gen-->>App: Synthesize Grounded Response
        App->>Cache: Cache Response (TTL 15m)
        App-->>User: Serve Final Answer (citations & token usage)
    end
```

---

## ⚙️ Configuration Setup (`.env`)

Create a `.env` file in the root of your project directory using the template provided in [`.env.example`](file:///Users/mahendra/work-dir/personal-p/notion-brain/.env.example):

```env
# Primary LLM Selection ("deepseek", "claude", or "gemini")
LLM_PROVIDER=deepseek

# Toggle Developer Diagnostic Metadata Block in Chat Responses
SHOW_DEV_METADATA=true

# DeepSeek API Configuration
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_API_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat

# Claude API Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=claude-3-5-sonnet-latest

# Gemini API Configuration (OpenAI-compatible endpoint, also used for active automatic RAG fallbacks!)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-2.5-flash

# Slack Socket Mode Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Notion Workspace Integration Token
NOTION_API_TOKEN=secret_your-notion-token
```

---

## 📂 Project Directory Structure

- [`src/config.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/config.ts) — Validates and ingests environment configurations.
- [`src/mcp.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/mcp.ts) — Spawns and supervises the Notion MCP subprocess client.
- [`src/llm.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/llm.ts) — Multi-LLM provider client with automatic failover fallback.
- [`src/rag.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/rag.ts) — Unified RAG orchestator (Router-Generator split, caching, and context enhancers).
- [`src/server.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/server.ts) — Express server hosting the API routes and Web QA Dashboard.
- [`src/index.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/index.ts) — Main bootstrap entry point coordinating Slack Bolt and Express.
- `src/utils/` — Utility files:
  - [`src/utils/notion.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/notion.ts) — Notion metadata and workspace database listing helper.
  - [`src/utils/filters.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/filters.ts) — Input moderation and sensitivity check filters.
  - [`src/utils/helpers.ts`](file:///Users/mahendra/work-dir/personal-p/notion-brain/src/utils/helpers.ts) — Response formatter, message splitter, and Slack mrkdwn translator.
- `public/` — Static frontend assets for the QA Dashboard and Cost Dashboard.
- `tests/` — Standalone test sandboxes.

---

## 🚀 Step-by-Step Installation Guide

### Step 1: Create a Notion Integration
1. Go to the [Notion Developers Portal](https://www.notion.so/my-integrations).
2. Click **+ New Integration**. Select your workspace and add a name.
3. Grant **Read content** and **Search content** permissions.
4. Copy the **Internal Integration Token** (`secret_...`).
5. Open your Notion workspace in a browser, navigate to the databases/pages you want the bot to access (e.g. Onboarding Wiki, Tasks, Projects), click `...` in the top right ➡️ **Connect to** ➡️ Choose your integration.

### Step 2: Create a Slack App (Socket Mode)
1. Go to the [Slack API Portal](https://api.slack.com/apps) and click **Create New App** ➡️ **From scratch**.
2. Under **Settings** ➡️ **Basic Information**:
   - Scroll to **App-Level Tokens** and create a token with the `connections:write` scope. Copy the `xapp-...` token.
3. Under **Settings** ➡️ **Socket Mode**:
   - Toggle **Enable Socket Mode** to **ON**.
4. Under **Features** ➡️ **OAuth & Permissions**:
   - Under **Scopes** ➡️ **Bot Token Scopes**, add the following permissions:
     - `app_mention:read` (to listen for bot mentions)
     - `chat:write` (to reply in channels/threads)
     - `reactions:write` (to add emojis like status indicators)
     - `users:read` & `users:read.email` (to resolve Slack context to Notion users)
     - `channels:history`, `groups:history`, `im:history` (to fetch thread message history)
   - Scroll up and click **Install to Workspace**. Copy the generated **Bot User OAuth Token** (`xoxb-...`).
5. Under **Features** ➡️ **Event Subscriptions**:
   - Toggle **Enable Events** to **ON**.
   - Under **Subscribe to bot events**, click **Add Bot User Event** and select `app_mention`.

---

## 🛠️ Running the Application

### Local Setup
Ensure dependencies are installed, compile the TypeScript source files, and start the application:

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Start the application
npm start
```

On boot, the console logs will display the Notion MCP subprocess connection, database schema mapping discovery, and Slack Bolt client connections.

### Verification & Testing
To run the automated batch test suite (running sandbox scenarios for developers):

```bash
npx tsx tests/run-batch-tests.ts
```

---

## 📊 Local QA Web Dashboard
When the application is running, visit `http://localhost:3000` in your web browser:
1. **QA Chat Web UI**: Submit queries to test the RAG engine interactively.
2. **Cost Report Dashboard (`/cost_report.html`)**: View estimated API costs, region-specific details (AWS Mumbai), toggle between Multi-Turn RAG and the optimized Router-Split architecture, and view comparative savings in USD or INR (₹).

---

## 🛡️ Resiliency & Safeguards

- **Multi-LLM Failover**: If the primary LLM provider (e.g. DeepSeek) experiences an outage, OrgBrain catches the error and automatically routes the query to Google Gemini (and secondary fallback to Claude) to prevent service downtime.
- **Subprocess Supervision**: If the Notion MCP subprocess fails or disconnects, the supervisor watchdog automatically schedules a clean reboot within 3 seconds.
- **Notion Schema Safety**: Detects property types and blocks invalid select/status filter queries, preventing `400 Bad Request` API validation crashes.
- **Slack mrkdwn Formatting**: Formats bold headings, task list checkboxes (`[ ]` ➡️ ⬜, `[x]` ➡️ ✅), and links natively into Slack-supported markdown syntax.
