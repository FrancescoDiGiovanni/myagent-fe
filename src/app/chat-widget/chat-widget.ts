import { Component, signal, ViewChild, ElementRef, OnInit, OnDestroy, Inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DOCUMENT } from '@angular/common';
import { Observable, Subject, takeUntil } from 'rxjs';
import { observeOn, animationFrameScheduler } from 'rxjs';

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

type SseEvent =
  | { kind: 'step'; name: string }
  | { kind: 'token'; text: string }
  | { kind: 'end' };

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
export class ChatWidget implements OnInit, OnDestroy {
  @ViewChild('messagesContainer') messagesContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('inputField') inputField?: ElementRef<HTMLInputElement>;

  isOpen = signal(false);
  messages = signal<ChatMessage[]>([]);
  inputText = signal('');
  isTyping = signal(false);

  agentName = signal('MyAgent');
  avatarUrl = signal('');
  apiUrl = signal('http://127.0.0.1:5000');

  private cancelStream$ = new Subject<void>();

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

  ngOnDestroy(): void {
    this.cancelStream$.next();
    this.cancelStream$.complete();
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
    this.isTyping.set(true);
    this.scrollToBottom();

    const assistantMsg: ChatMessage = { role: 'assistant', text: '', timestamp: new Date(), steps: [] };
    this.messages.update((msgs) => [...msgs, assistantMsg]);

    const feUrl = this.doc.referrer || this.doc.defaultView?.location.href || '';

    this.cancelStream$.next(); // cancella eventuale stream precedente

    this.sseStream(`${this.apiUrl()}/ask`, { question: text, fe_url: feUrl })
      .pipe(
        observeOn(animationFrameScheduler), // un token per animation frame → render continuo
        takeUntil(this.cancelStream$),
      )
      .subscribe({
        next: (event) => {
          if (event.kind === 'step') {
            this.updateLast((msg) => {
              const steps = (msg.steps ?? []).map((s) =>
                s.status === 'active' ? { ...s, status: 'done' as StepStatus } : s
              );
              if (event.name !== '__end__') steps.push({ name: event.name, status: 'active' });
              return { ...msg, steps };
            });
          } else if (event.kind === 'token') {
            this.updateLast((msg) => ({ ...msg, text: msg.text + event.text }));
            this.scrollToBottom();
          } else if (event.kind === 'end') {
            this.updateLast((msg) => ({
              ...msg,
              steps: (msg.steps ?? []).map((s) => ({ ...s, status: 'done' as StepStatus })),
            }));
          }
        },
        error: () => {
          this.updateLast((msg) => ({
            ...msg,
            text: msg.text || 'Errore di connessione. Riprova più tardi.',
          }));
          this.isTyping.set(false);
        },
        complete: () => {
          this.isTyping.set(false);
        },
      });
  }

  private sseStream(url: string, body: object): Observable<SseEvent> {
    return new Observable((observer) => {
      const controller = new AbortController();
      let readingAnswer = false;

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            observer.error(new Error(`HTTP ${response.status}`));
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { observer.complete(); break; }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).replace(/\r$/, '');

                if (data.startsWith('next_step=')) {
                  readingAnswer = false;
                  observer.next({ kind: 'step', name: data.slice('next_step='.length) });
                } else if (data.startsWith('answer=')) {
                  readingAnswer = true;
                  const inline = data.slice('answer='.length);
                  if (inline) observer.next({ kind: 'token', text: inline });
                } else if (data.startsWith('log=')) {
                  readingAnswer = false;
                  observer.next({ kind: 'end' });
                } else if (readingAnswer && data) {
                  observer.next({ kind: 'token', text: data });
                }
              }
            }
          } catch (err: any) {
            if (err?.name !== 'AbortError') observer.error(err);
            else observer.complete();
          }
        })
        .catch((err) => {
          if (err?.name !== 'AbortError') observer.error(err);
        });

      // teardown: abortare la fetch se il subscriber si unssubscribe
      return () => controller.abort();
    });
  }

  private updateLast(fn: (msg: ChatMessage) => ChatMessage): void {
    this.messages.update((msgs) => {
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return msgs;
      return [...msgs.slice(0, -1), fn(last)];
    });
  }

  getStepLabel(name: string): string {
    return STEP_LABELS[name] ?? name;
  }

  parseMarkdown(text: string): string {
    let normalized = text.replace(/\\n/g, '\n');
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
