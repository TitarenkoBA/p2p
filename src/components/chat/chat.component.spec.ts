import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatComponent } from './chat.component';

describe('ChatComponent', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let sent: string[];

  const field = () => fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
  const button = () => fixture.nativeElement.querySelector('button') as HTMLButtonElement;

  async function type(text: string): Promise<void> {
    field().value = text;
    field().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init });
    field().dispatchEvent(event);
    return event;
  }

  beforeEach(async () => {
    sent = [];
    fixture = TestBed.createComponent(ChatComponent);
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('canSend', true);
    fixture.componentInstance.send.subscribe((text) => sent.push(text));
    await fixture.whenStable();
  });

  it('sends on Enter and clears the draft', async () => {
    await type('hello');
    press({});
    await fixture.whenStable();
    expect(sent).toEqual(['hello']);
    expect(field().value).toBe('');
  });

  it('keeps Shift+Enter for a new line', async () => {
    await type('hello');
    const event = press({ shiftKey: true });
    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not send blank drafts', async () => {
    await type('   ');
    press({});
    expect(sent).toEqual([]);
    expect(button().disabled).toBe(true);
  });

  it('does not send while disconnected', async () => {
    fixture.componentRef.setInput('canSend', false);
    await type('hello');
    press({});
    expect(sent).toEqual([]);
    expect(button().disabled).toBe(true);
  });
});
