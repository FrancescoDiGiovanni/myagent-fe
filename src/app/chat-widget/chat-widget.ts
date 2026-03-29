import { Component, signal, ViewChild, ElementRef, OnInit, Inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DOCUMENT } from '@angular/common';

export type StepStatus = 'active' | 'done';

export interface AgentStep {
  name: string;
  status: StepStatus;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  steps?: AgentStep[];
}

const STEP_LABELS: Record<string, string> = {
  init: 'Avvio',
  input_guard: 'Sicurezza',
  reasoner: 'Analisi',
  output_guard: 'Controllo',
};

@Component({
  selector: 'app-chat-widget',
  imports: [FormsModule, DatePipe],
  templateUrl: './chat-widget.html',
  styleUrl: './chat-widget.scss',
})
export class ChatWidget implements OnInit {
  @ViewChild('messagesContainer') messagesContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('inputField') inputField?: ElementRef<HTMLInputElement>;

  isOpen = signal(false);
  messages = signal<ChatMessage[]>([]);
  inputText = signal('');
  isTyping = signal(false);

  agentName = signal('MyAgent');
  avatarUrl = signal('');
  apiUrl = signal('http://127.0.0.1:5000');

  constructor(@Inject(DOCUMENT) private doc: Document) {}

  ngOnInit(): void {
    const params = new URLSearchParams(this.doc.defaultView?.location.search ?? '');

    const name   = params.get('name');
    const avatar = params.get('avatar');
    const api    = params.get('api');
    if (name)   this.agentName.set(name);
    if (avatar) this.avatarUrl.set(avatar);
    if (api)    this.apiUrl.set(api);

    window.addEventListener('message', (event) => {
      if (event.data?.source === 'myagent-fe-host' && event.data?.type === 'CLOSE_CHAT') {
        if (this.isOpen()) {
          this.isOpen.set(false);
          this.notifyParent('CHAT_CLOSED');
        }
      }
    });
  }

  toggleChat(): void {
    this.isOpen.update((v) => !v);
    this.notifyParent(this.isOpen() ? 'CHAT_OPENED' : 'CHAT_CLOSED');
    if (this.isOpen()) {
      setTimeout(() => this.inputField?.nativeElement.focus(), 150);
    }
  }

  private notifyParent(type: string): void {
    if (window.parent !== window) {
      window.parent.postMessage({ type, source: 'myagent-fe-widget' }, '*');
    }
  }

  sendMessage(): void {
    const text = this.inputText().trim();
    if (!text || this.isTyping()) return;

    this.messages.update((msgs) => [
      ...msgs,
      { role: 'user', text, timestamp: new Date() },
    ]);
    this.inputText.set('');
    this.scrollToBottom();

    this.isTyping.set(true);
    this.streamAsk(text).catch(() => {
      this.messages.update((msgs) => [
        ...msgs,
        { role: 'assistant', text: 'Errore di connessione. Riprova più tardi.', timestamp: new Date() },
      ]);
    }).finally(() => {
      this.isTyping.set(false);
    });
  }

  private async streamAsk(question: string): Promise<void> {
    const feUrl = this.doc.referrer || this.doc.defaultView?.location.href || '';

    const assistantMsg: ChatMessage = { role: 'assistant', text: '', timestamp: new Date(), steps: [] };
    this.messages.update((msgs) => [...msgs, assistantMsg]);
    this.isTyping.set(false);
    this.scrollToBottom();

    const response = await fetch(`${this.apiUrl()}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, fe_url: feUrl }),
    });

    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let readingAnswer = false;

    const updateLast = (fn: (msg: ChatMessage) => ChatMessage) => {
      this.messages.update((msgs) => {
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return msgs;
        return [...msgs.slice(0, -1), fn(last)];
      });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();

        if (data.startsWith('next_step=')) {
          const stepName = data.slice('next_step='.length);
          readingAnswer = false;
          updateLast((msg) => {
            const steps = (msg.steps ?? []).map((s) =>
              s.status === 'active' ? { ...s, status: 'done' as StepStatus } : s
            );
            if (stepName !== '__end__') steps.push({ name: stepName, status: 'active' });
            return { ...msg, steps };
          });
        } else if (data.startsWith('answer=')) {
          readingAnswer = true;
          const inline = data.slice('answer='.length);
          if (inline) updateLast((msg) => ({ ...msg, text: msg.text + inline }));
        } else if (data.startsWith('log=')) {
          readingAnswer = false;
        } else if (readingAnswer && data) {
          updateLast((msg) => ({ ...msg, text: msg.text + data }));
        }

        this.scrollToBottom();
      }
    }

    updateLast((msg) => ({
      ...msg,
      steps: (msg.steps ?? []).map((s) => ({ ...s, status: 'done' as StepStatus })),
    }));
  }

  getStepLabel(name: string): string {
    return STEP_LABELS[name] ?? name;
  }

  parseMarkdown(text: string): string {
    // Normalize literal "\n" escape sequences sent as text by the backend
    let normalized = text.replace(/\\n/g, '\n');
    // Insert newline before inline list markers not already at line start
    normalized = normalized.replace(/([^\n])(- |\d+\. )/g, '$1\n$2');

    const lines = normalized.split('\n');
    let html = '';
    let inList = false;
    let listType: 'ul' | 'ol' = 'ul';

    for (const line of lines) {
      const bulletMatch = line.match(/^- (.+)/);
      const orderedMatch = line.match(/^\d+\. (.+)/);

      if (bulletMatch || orderedMatch) {
        const currentType = bulletMatch ? 'ul' : 'ol';
        if (!inList || listType !== currentType) {
          if (inList) html += `</${listType}>`;
          html += `<${currentType}>`;
          inList = true;
          listType = currentType;
        }
        const content = bulletMatch ? bulletMatch[1] : orderedMatch![1];
        html += `<li>${this.inlineMarkdown(content)}</li>`;
      } else if (line.trim() === '') {
        if (!inList) html += '<br>';
        // blank lines inside a list are skipped to avoid closing and reopening it
      } else {
        if (inList) { html += `</${listType}>`; inList = false; }
        html += `<p>${this.inlineMarkdown(line)}</p>`;
      }
    }
    if (inList) html += `</${listType}>`;
    return html;
  }

  private inlineMarkdown(text: string): string {
    return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }
}
