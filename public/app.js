/**
 * ==============================================================================
 * OmniBrain Web UI Client Logic
 * ==============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {
  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const userInput = document.getElementById('user-input');
  const typingIndicator = document.getElementById('typing-indicator');
  const clearBtn = document.getElementById('clear-btn');
  const sendButton = document.getElementById('send-button');
  
  // Config Badge Elements
  const providerBadge = document.getElementById('provider-badge');
  const modelBadge = document.getElementById('model-badge');
  const slackCheck = document.getElementById('slack-check');

  let conversationHistory = [];

  // 1. Fetch Config Status on startup
  async function fetchConfig() {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      
      providerBadge.textContent = data.llmProvider;
      modelBadge.textContent = data.model;
      
      if (data.slackConfigured) {
        slackCheck.textContent = '✓ Active';
        slackCheck.className = 'check-icon success';
      } else {
        slackCheck.textContent = '✗ Offline';
        slackCheck.className = 'check-icon warn';
      }
    } catch (error) {
      console.error('Failed to retrieve server configurations:', error);
      providerBadge.textContent = 'ERROR';
      modelBadge.textContent = 'N/A';
      slackCheck.textContent = '✗ Offline';
      slackCheck.className = 'check-icon warn';
    }
  }

  // 2. Format LLM output text converting markdown to HTML
  function formatMarkdown(text) {
    let html = '';
    let parsedWithMarked = false;

    if (typeof marked !== 'undefined') {
      try {
        // Set marked options for line breaks and standard Github Flavor Markdown
        marked.setOptions({
          breaks: true,
          gfm: true
        });
        
        // Parse markdown to HTML
        const rawHTML = marked.parse(text);
        
        // Sanitize generated HTML safely
        if (typeof DOMPurify !== 'undefined') {
          html = DOMPurify.sanitize(rawHTML);
        } else {
          html = rawHTML;
        }
        parsedWithMarked = true;
      } catch (err) {
        console.warn('Failed to parse with marked, falling back to basic formatter:', err);
      }
    }

    if (!parsedWithMarked) {
      // Basic regex-based parser fallback if CDN libraries are unavailable
      html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Code blocks: ```js ... ```
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="language-${lang || 'txt'}">${code.trim()}</code></pre>`;
      });

      // Inline code: `code`
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

      // Bold text: **text**
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      // Paragraphs split by newline doublets
      html = html.split('\n\n').map(p => {
        const trimmed = p.trim();
        if (trimmed.startsWith('<pre>') || trimmed.startsWith('<ul>') || trimmed.startsWith('<ol>')) {
          return trimmed;
        }
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
      }).join('');

      // Bullet lists: - item or * item
      html = html.replace(/(?:^|\n)[-*]\s+(.+)/g, '<li>$1</li>');
      html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
      html = html.replace(/<\/ul>\n*<ul>/g, '');

      // Clickable Markdown Links: [text](url)
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" class="chat-link">$1</a>');
    }

    // Post-process checkboxes: replace [ ] with checkbox input, and [x] or [X] with checked checkbox input
    html = html
      .replace(/\[ \]/g, '<input type="checkbox" disabled />')
      .replace(/\[[xX]\]/g, '<input type="checkbox" checked disabled />');

    return html;
  }

  function maskToken(token) {
    if (!token) return 'N/A';
    if (token.length <= 12) return '***';
    return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
  }

  // 3. Render message to bubbles
  function renderMessage(role, text, citations = [], usage = null, showDevMetadata = false, historyCount = 1, notionToken = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role === 'user' ? 'user-msg' : 'system-msg'}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = '👤';
    } else {
      avatar.className += ' img-avatar';
      const img = document.createElement('img');
      img.src = 'mascot.png';
      img.alt = 'OmniBrain Mascot';
      avatar.appendChild(img);
    }
    
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    
    // Set text HTML
    const cleanHTML = formatMarkdown(text);
    bubble.innerHTML = cleanHTML;
    
    // Add citation footer if sources exist
    if (citations && citations.length > 0) {
      const citationsBox = document.createElement('div');
      citationsBox.className = 'citations-box';
      citationsBox.innerHTML = `<span>Sources Citations</span>`;
      
      const sourcesList = document.createElement('div');
      sourcesList.className = 'sources-list';
      
      citations.forEach(src => {
        const link = document.createElement('a');
        link.href = src.url;
        link.target = '_blank';
        link.className = 'source-link';
        link.innerHTML = `📄 ${src.title || 'Page Reference'}`;
        sourcesList.appendChild(link);
      });
      
      citationsBox.appendChild(sourcesList);
      bubble.appendChild(citationsBox);
    }
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(bubble);
    chatMessages.appendChild(messageDiv);

    // Render token usage underneath if present and dev mode is toggled (Pro Tip check!)
    if (role === 'assistant' && showDevMetadata && usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      const devBlock = document.createElement('pre');
      devBlock.className = 'msg-dev-block';
      const total = usage.inputTokens + usage.outputTokens;
      
      devBlock.innerHTML = `[OmniBrain Dev Metadata]<br>• Tokens: Input: ${usage.inputTokens} | Output: ${usage.outputTokens} | Total: ${total}<br>• Thread Context: ${historyCount} messages`;
      chatMessages.appendChild(devBlock);
    }
    
    // Scroll bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 4. Handle forms submission
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = userInput.value.trim();
    if (!query) return;
    
    // Render user message bubble
    renderMessage('user', query);
    userInput.value = '';
    userInput.style.height = 'auto'; // Reset text area size
    
    // Display typing state
    typingIndicator.classList.remove('hide');
    userInput.disabled = true;
    sendButton.disabled = true;
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
      // POST message query
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: query,
          history: conversationHistory
        })
      });
      
      const data = await response.json();
      
      // Hide typing state
      typingIndicator.classList.add('hide');
      userInput.disabled = false;
      sendButton.disabled = false;
      
      if (response.ok) {
        // Render system answer
        renderMessage('assistant', data.text, data.citations, data.usage, data.showDevMetadata, data.historyCount, data.notionToken);
        
        // Append history
        conversationHistory.push({ role: 'user', content: query });
        conversationHistory.push({ role: 'assistant', content: data.text });
      } else {
        renderMessage('assistant', `⚠️ Server Error: ${data.error || 'Failed to generate answer.'}`);
      }
    } catch (err) {
      typingIndicator.classList.add('hide');
      userInput.disabled = false;
      sendButton.disabled = false;
      renderMessage('assistant', '🚨 Network connection issue. Is the OmniBrain local backend server running?');
      console.error(err);
    }
  });

  // 5. Expand text area input block dynamically
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = `${userInput.scrollHeight}px`;
  });

  // 6. Support enter-key submitting, shift-enter wraps line
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // 7. Clear button hook
  clearBtn.addEventListener('click', () => {
    chatMessages.innerHTML = '';
    conversationHistory = [];
    renderMessage('assistant', 'Conversation cleared. What can I help you find from your Notion workspace?');
  });

  // Run startup config fetch
  fetchConfig();
});
