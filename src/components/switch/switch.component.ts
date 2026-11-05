import { Component, input, output } from '@angular/core';

@Component({
  selector: 'neo-switch',
  template: `
    <label class="switch-holder" [class.is-disabled]="disabled()" [title]="disabled() ? disabledHint() : ''">
      <span class="switch-label">{{ label() }}</span>
      <input
        type="checkbox"
        role="switch"
        [checked]="checked()"
        [disabled]="disabled()"
        (change)="toggled.emit()"
      />
      <span class="switch-track" aria-hidden="true"></span>
    </label>
  `,
  styleUrl: './switch.component.css',
  host: {
    class: 'block col-span-2 md:col-span-1'
  }
})
export class SwitchComponent {
  label = input.required<string>();
  checked = input.required<boolean>();
  disabled = input(false);
  disabledHint = input('');
  toggled = output<void>();
}
