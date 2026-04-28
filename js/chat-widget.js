// IAM Chat Widget - Self-contained AI support chatbot
// Uses OpenRouter API with streaming responses
(function() {
  'use strict';

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = `
    #iam-chat-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #feba04; border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #iam-chat-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(0,0,0,0.3); }
    #iam-chat-bubble svg { width: 28px; height: 28px; fill: #1d1e22; }
    #iam-chat-container {
      position: fixed; bottom: 96px; right: 24px; z-index: 99999;
      width: 400px; height: 550px; max-height: calc(100vh - 120px);
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      display: flex; flex-direction: column; overflow: hidden;
      opacity: 0; transform: translateY(20px) scale(0.95);
      pointer-events: none;
      transition: opacity 0.25s, transform 0.25s;
    }
    #iam-chat-container.open {
      opacity: 1; transform: translateY(0) scale(1); pointer-events: auto;
    }
    #iam-chat-header {
      background: #1d1e22; color: #fff; padding: 16px 20px;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    #iam-chat-header-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    #iam-chat-header-title span.dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; }
    #iam-chat-close {
      background: none; border: none; color: #fff; cursor: pointer;
      font-size: 22px; line-height: 1; padding: 0 4px; opacity: 0.7;
    }
    #iam-chat-close:hover { opacity: 1; }
    #iam-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }
    .iam-msg { max-width: 85%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
    .iam-msg-bot { align-self: flex-start; background: #f1f1f1; color: #1d1e22; border-bottom-left-radius: 4px; }
    .iam-msg-user { align-self: flex-end; background: #feba04; color: #1d1e22; border-bottom-right-radius: 4px; }
    .iam-msg a { color: #1d1e22; text-decoration: underline; }
    .iam-typing { align-self: flex-start; padding: 12px 18px; background: #f1f1f1; border-radius: 14px; border-bottom-left-radius: 4px; display: flex; gap: 5px; }
    .iam-typing span {
      width: 7px; height: 7px; background: #999; border-radius: 50%;
      animation: iam-bounce 1.2s infinite;
    }
    .iam-typing span:nth-child(2) { animation-delay: 0.2s; }
    .iam-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes iam-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }
    #iam-chat-input-area {
      display: flex; padding: 12px; border-top: 1px solid #eee; flex-shrink: 0; gap: 8px;
    }
    #iam-chat-input {
      flex: 1; border: 1px solid #ddd; border-radius: 24px; padding: 10px 16px;
      font-size: 14px; outline: none; font-family: inherit;
    }
    #iam-chat-input:focus { border-color: #feba04; }
    #iam-chat-send {
      width: 40px; height: 40px; border-radius: 50%; border: none;
      background: #feba04; cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    #iam-chat-send:hover { background: #e5a800; }
    #iam-chat-send svg { width: 18px; height: 18px; fill: #1d1e22; }
    @media (max-width: 480px) {
      #iam-chat-container {
        width: 100vw; height: 100vh; max-height: 100vh;
        bottom: 0; right: 0; border-radius: 0;
      }
      #iam-chat-bubble { bottom: 16px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  // Create DOM
  const bubble = document.createElement('button');
  bubble.id = 'iam-chat-bubble';
  bubble.title = 'Chat met IAM Assistant';
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';

  const container = document.createElement('div');
  container.id = 'iam-chat-container';
  container.innerHTML = `
    <div id="iam-chat-header">
      <div id="iam-chat-header-title"><span class="dot"></span> IAM Assistant</div>
      <button id="iam-chat-close">&times;</button>
    </div>
    <div id="iam-chat-messages"></div>
    <div id="iam-chat-input-area">
      <input id="iam-chat-input" type="text" placeholder="Stel een vraag... / Ask a question..." autocomplete="off">
      <button id="iam-chat-send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
    </div>
  `;

  document.body.appendChild(container);
  document.body.appendChild(bubble);

  const messages = document.getElementById('iam-chat-messages');
  const input = document.getElementById('iam-chat-input');
  const sendBtn = document.getElementById('iam-chat-send');
  const closeBtn = document.getElementById('iam-chat-close');
  let isOpen = false;
  let conversationHistory = [];

  function addMessage(text, type) {
    const div = document.createElement('div');
    div.className = 'iam-msg iam-msg-' + type;
    div.innerHTML = text.replace(/\n/g, '<br>');
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'iam-typing';
    div.id = 'iam-typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('iam-typing-indicator');
    if (el) el.remove();
  }

  function toggle() {
    isOpen = !isOpen;
    container.classList.toggle('open', isOpen);
    if (isOpen && messages.children.length === 0) {
      addMessage('Hoi! 👋 Ik ben de IAM Assistant. Hoe kan ik je helpen?\n\nHi! I\'m the IAM Assistant. How can I help you?', 'bot');
    }
    if (isOpen) input.focus();
  }

  bubble.addEventListener('click', toggle);
  closeBtn.addEventListener('click', toggle);

  // System prompt and knowledge base live server-side in api/system-prompt.js and
  // api/knowledge-base.js per M2-01 D-09. The proxy prepends them on every request.
  // Client payload contains only user-authored turns.

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage(text, 'user');
    conversationHistory.push({ role: 'user', content: text });
    showTyping();

    const apiUrl = (window.IAM_CHAT_CONFIG && window.IAM_CHAT_CONFIG.apiUrl) || '/api/chat';

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory.slice(-10)
        })
      });

      hideTyping();
      const botDiv = addMessage('', 'bot');
      let fullText = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              // Strip any <think>...</think> blocks from display
              let display = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
              // Also strip incomplete <think> blocks at the end
              display = display.replace(/<think>[\s\S]*$/g, '').trim();
              botDiv.innerHTML = display.replace(/\n/g, '<br>');
              messages.scrollTop = messages.scrollHeight;
            }
          } catch(e) {}
        }
      }

      // Final cleanup of think tags
      let finalText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      finalText = finalText.replace(/<think>[\s\S]*$/g, '').trim();
      botDiv.innerHTML = finalText.replace(/\n/g, '<br>');
      conversationHistory.push({ role: 'assistant', content: finalText });
    } catch(err) {
      hideTyping();
      addMessage('Er ging iets mis. Probeer het opnieuw of mail info@interactivemove.nl', 'bot');
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
})();
