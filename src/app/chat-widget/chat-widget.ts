import { Component, signal, ViewChild, ElementRef, OnInit, AfterViewInit, OnDestroy, Inject, effect } from '@angular/core';
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
export class ChatWidget implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('messagesContainer') messagesContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('inputField') inputField?: ElementRef<HTMLTextAreaElement>;

  isOpen = signal(false);
  messages = signal<ChatMessage[]>([]);
  inputText = signal('');
  isTyping = signal(false);

  agentName = signal('Aria');
  avatarUrl = signal('');
  apiUrl = signal('http://127.0.0.1:5000');

  private readonly STORAGE_KEY    = 'myagent-messages';
  private readonly UI_STATE_KEY   = 'myagent-ui-state';
  private readonly THREAD_ID_KEY  = 'myagent-thread-id';
  private threadId!: string;
  private cancelStream$ = new Subject<void>();
  private scrollTopSignal = signal(0);

  constructor(@Inject(DOCUMENT) private doc: Document) {
    effect(() => {
      const msgs = this.messages();
      if (msgs.length === 0) {
        localStorage.removeItem(this.STORAGE_KEY);
        return;
      }
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(msgs));
      } catch { /* quota exceeded */ }
    });

    effect(() => {
      try {
        localStorage.setItem(this.UI_STATE_KEY, JSON.stringify({
          isOpen:    this.isOpen(),
          inputText: this.inputText(),
          scrollTop: this.scrollTopSignal(),
        }));
      } catch { /* quota exceeded */ }
    });
  }

  ngOnInit(): void {
    const params = new URLSearchParams(this.doc.defaultView?.location.search ?? '');

    const name   = params.get('name');
    const avatar = params.get('avatar');
    const api    = params.get('api');
    if (name)   this.agentName.set(name);
    if (avatar) this.avatarUrl.set(avatar);
    if (api)    this.apiUrl.set(api);

    this.loadMessages();
    this.loadUiState();
    this.initThreadId();
    if (this.messages().length === 0) this.addWelcomeMessage();

    window.addEventListener('message', (event) => {
      if (event.data?.source === 'myagent-fe-host' && event.data?.type === 'CLOSE_CHAT') {
        if (this.isOpen()) {
          this.isOpen.set(false);
          this.notifyParent('CHAT_CLOSED');
        }
      }
    });
  }

  ngAfterViewInit(): void {
    if (this.inputText()) setTimeout(() => this.autoResize(), 0);
    if (this.isOpen() && this.scrollTopSignal() > 0) {
      setTimeout(() => {
        const el = this.messagesContainer?.nativeElement;
        if (el) el.scrollTop = this.scrollTopSignal();
      }, 50);
    }
  }

  ngOnDestroy(): void {
    this.cancelStream$.next();
    this.cancelStream$.complete();
  }

  toggleChat(): void {
    this.isOpen.update((v) => !v);
    this.notifyParent(this.isOpen() ? 'CHAT_OPENED' : 'CHAT_CLOSED');
    if (this.isOpen()) {
      setTimeout(() => {
        this.inputField?.nativeElement.focus();
        const el = this.messagesContainer?.nativeElement;
        if (el) el.scrollTop = this.scrollTopSignal();
      }, 150);
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
    setTimeout(() => this.autoResize(), 0);
    this.isTyping.set(true);
    this.scrollToBottom();

    const assistantMsg: ChatMessage = { role: 'assistant', text: '', timestamp: new Date(), steps: [] };
    this.messages.update((msgs) => [...msgs, assistantMsg]);

    const feUrl = this.doc.referrer || this.doc.defaultView?.location.href || '';

    this.cancelStream$.next(); // cancella eventuale stream precedente

    this.sseStream(`${this.apiUrl()}/ask`, { question: text, fe_url: feUrl, thread_id: this.threadId, agent_name: this.agentName() })
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

  private initThreadId(): void {
    const stored = localStorage.getItem(this.THREAD_ID_KEY);
    if (stored) {
      this.threadId = stored;
    } else {
      this.threadId = crypto.randomUUID();
      localStorage.setItem(this.THREAD_ID_KEY, this.threadId);
    }
  }

  resetConversation(): void {
    this.cancelStream$.next();
    this.isTyping.set(false);
    this.messages.set([]);
    this.threadId = crypto.randomUUID();
    localStorage.setItem(this.THREAD_ID_KEY, this.threadId);
    localStorage.removeItem(this.STORAGE_KEY);
    this.addWelcomeMessage();
  }

  private addWelcomeMessage(): void {
    this.messages.set([{
      role: 'assistant',
      text: `Ciao, sono ${this.agentName()}, sono un agente di supporto e sono qui per aiutarti per qualsiasi dubbio!`,
      timestamp: new Date(),
    }]);
  }

  private loadUiState(): void {
    try {
      const raw = localStorage.getItem(this.UI_STATE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      if (state.isOpen)    this.isOpen.set(true);
      if (state.inputText) this.inputText.set(state.inputText);
      if (state.scrollTop) this.scrollTopSignal.set(state.scrollTop);
      if (state.isOpen)    this.notifyParent('CHAT_OPENED');
    } catch { /* ignore */ }
  }

  private loadMessages(): void {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return;
      const parsed: ChatMessage[] = JSON.parse(raw);
      const messages = parsed
        .map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
          steps: msg.steps?.map(s => ({ ...s, status: 'done' as StepStatus })),
        }))
        .filter(msg => msg.role !== 'assistant' || msg.text.trim() !== '');
      this.messages.set(messages);
    } catch {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }

  private updateLast(fn: (msg: ChatMessage) => ChatMessage): void {
    this.messages.update((msgs) => {
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return msgs;
      return [...msgs.slice(0, -1), fn(last)];
    });
  }

  autoResize(): void {
    const el = this.inputField?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 118; // ~5 lines
    if (el.scrollHeight > maxHeight) {
      el.style.height = maxHeight + 'px';
      el.style.overflowY = 'auto';
    } else {
      el.style.height = el.scrollHeight + 'px';
      el.style.overflowY = 'hidden';
    }
  }

  onMessagesScroll(event: Event): void {
    this.scrollTopSignal.set((event.target as HTMLDivElement).scrollTop);
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
