import { NotionMCPClient } from './mcp.js';
import { LLMClient } from './llm.js';
import { startWebServer } from './server.js';
import { RAGService } from './rag.js';
import pkg from '@slack/bolt';
const { App } = pkg;
import { config } from './config.js';
import { splitMessage, formatSlackMessage, cleanHistoryMessage } from './utils/helpers.js';
import { isQuerySensitive, getSensitiveBlockMessage } from './utils/filters.js';
import { fetchWorkspaceDatabases } from './utils/notion.js';

// Global clients
const mcpClient = new NotionMCPClient();
const llmClient = new LLMClient();

// In-memory event de-duplication cache to protect against double Slack deliveries
const processedEvents = new Set<string>();

// Create Slack App instance if tokens exist
let slackApp: any = null;

if (config.slack.botToken && config.slack.appToken) {
  slackApp = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true
  });

  // Prevent background connection or authentication errors (such as invalid_auth) from crashing the process
  slackApp.error(async (error: any) => {
    console.warn("⚠️ Slack Bolt App background error encountered (such as invalid_auth):", error.message || error);
  });
}

async function startSlackBot(ragService: RAGService) {
  if (!slackApp) {
    console.warn("⚠️ Slack tokens not fully configured in .env. Skipping Slack bot start (Web-Only Mode active).");
    return;
  }

  // Listen for Bot mentions
  slackApp.event('app_mention', async ({ event, client, say }: any) => {
    // Event De-duplication check
    const eventId = event.client_msg_id || event.ts;
    if (processedEvents.has(eventId)) {
      return;
    }
    processedEvents.add(eventId);
    setTimeout(() => processedEvents.delete(eventId), 60000);

    const threadTs = event.thread_ts || event.ts;

    // Input Content Safety Filtering (Pro Tip check!)
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (isQuerySensitive(cleanText)) {
      await say({
        channel: event.channel,
        thread_ts: threadTs,
        text: getSensitiveBlockMessage()
      });
      return;
    }

    // Add typing reaction indicator
    await client.reactions.add({
      name: 'eyes',
      channel: event.channel,
      timestamp: event.ts
    });

    try {
      // Fetch stateless conversational history in thread (Context recovery!)
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
      }

      // If we have history replies, slice off the last one (which is the current message itself)
      const pastHistory = history.length > 0 ? history.slice(0, -1) : [];
      const persistentHistoryCount = pastHistory.length;

      // Fetch user profile from Slack info to resolve "me/my" context
      let userContext: { name?: string; email?: string } = {};
      try {
        const userInfo = await client.users.info({ user: event.user });
        if (userInfo.ok && userInfo.user) {
          userContext.name = userInfo.user.profile.real_name || userInfo.user.name;
          userContext.email = userInfo.user.profile.email;
          console.log(`👤 Slack query from: "${userContext.name}" (${userContext.email || 'No email'})`);
        }
      } catch (err) {
        console.warn("⚠️ Could not fetch user profile info from Slack API:", (err as Error).message);
      }

      // Execute query through unified RAG service
      const result = await ragService.execute(cleanText, pastHistory, userContext);

      // Format response text natively for Slack mrkdwn (links, headings, and discrete token usage)
      const formattedSlackText = formatSlackMessage(
        result.text, 
        result.usage, 
        persistentHistoryCount + 1, 
        result.cached, 
        result.turns
      );

      // Send replies back safely, splitting if response exceeds Slack's character limit
      const chunks = splitMessage(formattedSlackText, 3800);
      for (const chunk of chunks) {
        await say({
          channel: event.channel,
          thread_ts: threadTs,
          text: chunk
        });
      }

      // Remove typing emoji reaction
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

  // Slack Feedback reaction listener (Pro Tip!)
  slackApp.event('reaction_added', async ({ event }: any) => {
    if (event.reaction === 'thumbsup' || event.reaction === 'thumbsdown') {
      console.log(`👍👎 Slack Feedback received: User reacted with :${event.reaction}: on message ts: ${event.item.ts} in channel: ${event.item.channel}`);
    }
  });

  try {
    await slackApp.start();
    console.log("⚡️ Slack Socket Mode app is running securely!");
  } catch (error) {
    console.warn("⚠️ Slack Connection Failed (invalid_auth or connection timeout). Continuing in Web-Only Mode!");
  }
}

(async () => {
  try {
    console.log(`🔧 OrgBrain Boot Configurations — Provider: ${config.llmProvider.toUpperCase()}, Show Dev Metadata: ${config.showDevMetadata}`);
    // 1. Start shared Notion MCP subprocess
    await mcpClient.start();

    // 2. Pre-fetch workspace databases
    const databasesMap = await fetchWorkspaceDatabases(mcpClient);

    // 3. Initialize RAG Orchestrator
    const ragService = new RAGService(mcpClient, llmClient, databasesMap);
    await ragService.initialize();

    // 4. Boot Express API and static server
    startWebServer(ragService);

    // 5. Gracefully boot Slack (in parallel background, catching start failures)
    startSlackBot(ragService).catch((err) => {
      console.warn("⚠️ Slack bot failed to boot in background. Continuing in Web-Only Mode!", err);
    });

  } catch (error) {
    console.error("Fatal initialization error:", error);
    process.exit(1);
  }
})();



// Graceful shutdown listeners
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

// Catch unhandled socket-mode state machine crashes or promise rejections to keep the RAG API server online
process.on('uncaughtException', (err) => {
  console.error("🚨 Uncaught Exception encountered:", err);
  if (err.message?.includes("Unhandled event") || err.stack?.includes("socket-mode")) {
    console.warn("⚠️ Slack Socket Mode websocket state machine error caught gracefully. Server remains active.");
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("🚨 Unhandled Rejection at:", promise, "reason:", reason);
});
