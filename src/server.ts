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
  
  // Serve static UI assets
  app.use(express.static(path.join(__dirname, '../public')));

  // Config status route
  app.get('/api/config', (req, res) => {
    res.json({
      llmProvider: config.llmProvider,
      model: config.llmProvider === 'deepseek' ? config.deepseek.model : config.claude.model,
      slackConfigured: !!(config.slack.botToken && config.slack.appToken),
      showDevMetadata: config.showDevMetadata,
      notionToken: config.showDevMetadata ? config.notion.apiToken : undefined
    });
  });

  // Chat RAG routing execution
  app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    // Input Content Safety Filtering (Pro Tip check!)
    if (isQuerySensitive(message)) {
      return res.json({
        text: getSensitiveBlockMessage(),
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      });
    }

    try {
      const mcpTools = await mcpClient.getTools();
      
      // 1. Filter out heavy writing/modifying tools to shrink system prompt size from ~20k to <1k tokens (95% savings!)
      const filteredTools = mcpTools.filter(tool => {
        const name = tool.name.toLowerCase();
        return name.startsWith('api-get-') || 
               name.startsWith('api-retrieve-') || 
               name.includes('search') || 
               name.includes('query');
      });

      // format conversational history
      const formattedHistory: any[] = history ? history.map((h: any) => ({
        role: h.role,
        content: cleanHistoryMessage(h.content || '')
      })) : [];

      const persistentHistoryCount = formattedHistory.length;
      const systemPrompt = getSystemPrompt(databasesMap);

      // Append clean user query to history
      formattedHistory.push({ role: 'user', content: message });

      // Call LLM
      let result = await llmClient.generateResponse(systemPrompt, formattedHistory, filteredTools);

      // Multi-Turn RAG Tool Execution Loop (Supervisor active!)
      let turns = 0;
      const maxTurns = 10; // Predictable upper cap

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

        // Push assistant message with toolCalls
        formattedHistory.push({
          role: 'assistant',
          content: result.text || null,
          toolCalls: result.toolCalls
        });

        // Push tool responses back to history
        formattedHistory.push({
          role: 'tool_responses',
          responses: toolResults
        });

        // Call LLM again, keeping tools active!
        result = await llmClient.generateResponse(systemPrompt, formattedHistory, filteredTools);
      }

      // Automatically extract notion.so links from the response text to render citations in UI
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
        historyCount: persistentHistoryCount + 1, // Count current user message
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
