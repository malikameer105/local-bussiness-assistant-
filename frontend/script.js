// =========================================================
//  Brew & Bean Cafe — Barista Bot  |  script.js
// =========================================================

const API_URL = 'http://127.0.0.1:8000/chat/stream';

// ── DOM refs ──────────────────────────────────────────────
const chatWindow   = document.getElementById('chat-window');
const userInput    = document.getElementById('user-input');
const sendBtn      = document.getElementById('send-btn');
const themeToggle  = document.getElementById('theme-toggle');
const themeIcon    = document.getElementById('theme-icon');
const welcomeEl    = document.getElementById('welcome');

// =========================================================
// 1.  DARK-MODE TOGGLE  (persists via localStorage)
// =========================================================
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeIcon.textContent = dark ? '☀️' : '🌙';
  localStorage.setItem('bb-theme', dark ? 'dark' : 'light');
}

(function initTheme() {
  const saved = localStorage.getItem('bb-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ? saved === 'dark' : prefersDark);
})();

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  applyTheme(!isDark);
});

// =========================================================
// 2.  SAFE MARKDOWN RENDERER  (XSS-safe)
// =========================================================
/**
 * Step 1 — Escape all HTML special characters to prevent XSS.
 * Step 2 — Convert safe Markdown subsets to HTML.
 *   - **text**  → <strong>text</strong>
 *   - *text*    → <em>text</em>
 *   - Lines starting with "- " or "* " → <ul><li>…</li></ul>
 *   - \n        → <br> (outside list context)
 */
function renderMarkdown(raw) {
  // --- Step 1: Escape HTML ---
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // --- Step 2: Convert Markdown ---
  const lines = escaped.split('\n');
  const outputLines = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const listMatch = line.match(/^(\s*[-*])\s+(.+)/);

    if (listMatch) {
      if (!inList) { outputLines.push('<ul>'); inList = true; }
      const content = applyInlineMarkdown(listMatch[2]);
      outputLines.push(`<li>${content}</li>`);
    } else {
      if (inList) { outputLines.push('</ul>'); inList = false; }
      const content = applyInlineMarkdown(line);
      outputLines.push(content || '<br>');
    }
  }
  if (inList) outputLines.push('</ul>');

  // Join, collapse multiple consecutive <br> into one
  return outputLines.join('\n')
    .replace(/(<br>\n*){3,}/g, '<br><br>')
    .replace(/^\n+|\n+$/g, '');
}

function applyInlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')  // **bold**
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')           // *italic*
    .replace(/`(.+?)`/g,       '<code>$1</code>');      // `code`
}

// =========================================================
// 3.  HELPERS — Time, Scroll, Disable
// =========================================================
function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
  chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: 'smooth' });
}

function setInputLock(locked) {
  userInput.disabled = locked;
  sendBtn.disabled   = locked;
}

function hideWelcome() {
  if (welcomeEl) welcomeEl.style.display = 'none';
}

// =========================================================
// 4.  CREATE MESSAGE BUBBLES
// =========================================================
function createUserBubble(text) {
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'msg-row user';
  row.innerHTML = `
    <div class="avatar">🧑</div>
    <div>
      <div class="bubble">${escapeHtml(text)}</div>
      <div class="msg-time">${getTime()}</div>
    </div>`;
  chatWindow.appendChild(row);
  scrollToBottom();
}

function escapeHtml(str) {
  return str
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function createBotBubble() {
  const row = document.createElement('div');
  row.className = 'msg-row bot';
  row.innerHTML = `
    <div class="avatar">☕</div>
    <div>
      <div class="bubble" id="bot-bubble-live"></div>
      <div class="msg-time" id="bot-time-live"></div>
    </div>`;
  chatWindow.appendChild(row);
  scrollToBottom();
  return {
    bubble:  row.querySelector('#bot-bubble-live'),
    timeEl:  row.querySelector('#bot-time-live'),
  };
}

// =========================================================
// 5.  TYPING INDICATOR
// =========================================================
let typingRow = null;

function showTyping() {
  hideWelcome();
  typingRow = document.createElement('div');
  typingRow.className = 'msg-row bot typing-indicator';
  typingRow.innerHTML = `
    <div class="avatar">☕</div>
    <div class="typing-dots">
      <span></span><span></span><span></span>
    </div>`;
  chatWindow.appendChild(typingRow);
  scrollToBottom();
}

function hideTyping() {
  if (typingRow) { typingRow.remove(); typingRow = null; }
}

// =========================================================
// 6.  STREAM FROM BACKEND  (SSE via ReadableStream reader)
// =========================================================
async function streamBotReply(userMessage) {
  setInputLock(true);
  showTyping();

  let rawText = '';  // accumulates the final plain text

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMessage }),
    });

    if (!response.ok) {
      throw new Error(`Server error ${response.status}`);
    }

    // ── Switch from typing indicator → live bubble ──
    hideTyping();
    const { bubble, timeEl } = createBotBubble();

    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from the buffer
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const chunk = line.slice(6); // strip exactly "data: " (6 chars) — preserve word-boundary spaces

        if (chunk === '[DONE]') break;
        if (chunk.startsWith('[ERROR]')) {
          rawText += '\n⚠️ ' + chunk.slice(7);
          break;
        }

        rawText += chunk;

        // Re-render markdown on every chunk (live)
        bubble.innerHTML = renderMarkdown(rawText);
        scrollToBottom();
      }
    }

    // Final render pass + timestamp
    bubble.innerHTML = renderMarkdown(rawText);
    timeEl.textContent = getTime();
    scrollToBottom();

  } catch (err) {
    hideTyping();
    const { bubble, timeEl } = createBotBubble();
    bubble.innerHTML = `⚠️ <em>Could not reach the server. Is it running on port 8000?</em><br><small style="opacity:.6">${err.message}</small>`;
    timeEl.textContent = getTime();
    scrollToBottom();
  } finally {
    setInputLock(false);
    userInput.focus();
  }
}

// =========================================================
// 7.  SEND MESSAGE HANDLER
// =========================================================
function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;
  userInput.value = '';
  autoResizeTextarea();
  createUserBubble(text);
  streamBotReply(text);
}

// =========================================================
// 8.  QUICK-REPLY CHIPS
// =========================================================
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const msg = btn.dataset.msg;
    if (!msg || userInput.disabled) return;
    userInput.value = '';
    createUserBubble(msg);
    streamBotReply(msg);
  });
});

// =========================================================
// 9.  INPUT EVENTS  (send on Enter, Shift+Enter = newline)
// =========================================================
function autoResizeTextarea() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

userInput.addEventListener('input', autoResizeTextarea);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

// =========================================================
// 10.  INIT — focus input on load
// =========================================================
window.addEventListener('load', () => {
  userInput.focus();
});
