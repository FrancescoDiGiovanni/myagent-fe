import { Component, signal, ViewChild, ElementRef, OnInit, Inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DOCUMENT } from '@angular/common';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}

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

  constructor(@Inject(DOCUMENT) private doc: Document) {}

  ngOnInit(): void {
    const params = new URLSearchParams(this.doc.defaultView?.location.search ?? '');

    const name   = params.get('name');
    const avatar = params.get('avatar');
    if (name)   this.agentName.set(name);
    if (avatar) this.avatarUrl.set(avatar);

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
    if (!text) return;

    this.messages.update((msgs) => [
      ...msgs,
      { role: 'user', text, timestamp: new Date() },
    ]);
    this.inputText.set('');
    this.scrollToBottom();

    this.isTyping.set(true);
    // TODO: replace with real API call
    setTimeout(() => {
      this.isTyping.set(false);
      this.messages.update((msgs) => [
        ...msgs,
        {
          role: 'assistant',
          text: 'Ciao! Sono il tuo assistente AI. Come posso aiutarti?',
          timestamp: new Date(),
        },
      ]);
      this.scrollToBottom();
    }, 1000);
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
