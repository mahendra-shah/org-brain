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
