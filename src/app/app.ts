import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ChatWidget } from './chat-widget/chat-widget';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ChatWidget],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('myagent-fe');
}
