import { DatePipe } from '@angular/common';
import { Component, ElementRef, afterRenderEffect, input, output, signal, viewChild } from '@angular/core';
import { ChatMessage } from '../../services/session.service';

const STICK_TO_BOTTOM_THRESHOLD_PX = 40;

@Component({
  selector: 'chat',
  imports: [DatePipe],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent {
  messages = input.required<ChatMessage[]>();
  canSend = input.required<boolean>();
  send = output<string>();

  protected readonly draft = signal('');

  private stickToBottom = true;
  private readonly scrollContainer = viewChild.required<ElementRef<HTMLElement>>('scrollContainer');
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  constructor() {
    afterRenderEffect(() => {
      const messages = this.messages();
      const element = this.scrollContainer().nativeElement;
      if (this.stickToBottom || messages.at(-1)?.author === 'me') {
        element.scrollTop = element.scrollHeight;
      }
    });

    afterRenderEffect(() => {
      this.draft();
      const element = this.field().nativeElement;
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    });
  }

  protected onScroll(element: HTMLElement): void {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    this.stickToBottom = distance < STICK_TO_BOTTOM_THRESHOLD_PX;
  }

  protected onInput(value: string): void {
    this.draft.set(value);
  }

  protected onKeyDown(event: KeyboardEvent): void {
    // On touch keyboards Enter inserts a line break: there is a Send button right next to the field.
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || (isTouch && !event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    this.submit();
  }

  protected submit(): void {
    if (this.canSend() && this.draft().trim()) {
      this.send.emit(this.draft());
      this.draft.set('');
    }
  }
}
