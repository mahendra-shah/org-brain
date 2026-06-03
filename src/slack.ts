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

// In-memory event de-duplication cache to protect against double Slack deliveries
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

  // Listen for Bot mentions
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

    // Add typing reaction indicator
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
        // Drop own bot tag from initial prompt to avoid confusing the LLM
        const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
        history = [{ role: 'user', content: cleanText }];
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
        const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
        const combinedContent = `The following Notion pages were successfully fetched:\n${JSON.stringify(toolResults)}\n\nFormulate your final grounded response to: "${cleanText}"`;
        history.push({ role: 'user', content: combinedContent });
        result = await llmClient.generateResponse(SYSTEM_PROMPT, history as any, []);
      }

      // 5. Send replies back safely, splitting if response exceeds Slack's character limit
      const chunks = splitMessage(result.text, 3800);
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

  await app.start();
  console.log("⚡️ Slack Socket Mode app is running securely!");
}

export async function stopSlackBot() {
  await mcpClient.close();
  await app.stop();
  console.log("Slack Bot cleanly stopped.");
}
