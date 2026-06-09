import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { RAGService } from './rag.js';
import { isQuerySensitive, getSensitiveBlockMessage } from './utils/filters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startWebServer(ragService: RAGService) {
  const app = express();
  const port = process.env.PORT || 3000;

  app.use(express.json());
  
  // Serve static UI assets
  app.use(express.static(path.join(__dirname, '../public')));

  // Config status route
  app.get('/api/config', (req, res) => {
    res.json({
      llmProvider: config.llmProvider,
      model: config.llmProvider === 'deepseek' ? config.deepseek.model : (config.llmProvider === 'gemini' ? config.gemini.model : config.claude.model),
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
        usage: { inputTokens: 0, outputTokens: 0 },
        cached: false,
        turns: 0
      });
    }

    try {
      // Execute query through unified RAG service
      const result = await ragService.execute(message, history || []);

      res.json({
        text: result.text,
        citations: result.citations,
        usage: result.usage,
        showDevMetadata: config.showDevMetadata,
        historyCount: (history ? history.length : 0) + 1, // Count current user message
        notionToken: config.showDevMetadata ? config.notion.apiToken : undefined,
        cached: result.cached,
        turns: result.turns
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
