import { Component, ElementRef, afterRenderEffect, input, output, viewChild } from '@angular/core';

@Component({
  selector: 'neo-select',
  template: `
    <label class="select-holder">
      <span class="select-label">{{ label() }}</span>
      <select #selectEl [disabled]="disabled()" (change)="onChange($event)">
        @for (device of devices(); track device.deviceId; let index = $index) {
          <option [value]="device.deviceId">{{ device.label || label() + ' ' + (index + 1) }}</option>
        }
      </select>
    </label>
  `,
  styles: `
    .select-holder {
      display: grid;
      gap: 0.35rem;
    }

    .select-label {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
  `
})
export class SelectComponent {
  label = input.required<string>();
  devices = input.required<MediaDeviceInfo[]>();
  value = input('');
  disabled = input(false);
  changed = output<string>();

  private readonly selectRef = viewChild.required<ElementRef<HTMLSelectElement>>('selectEl');

  constructor() {
    // Also runs when `disabled` drops: after a failed switch `value` is unchanged,
    // but the element still shows the device the user picked.
    afterRenderEffect(() => {
      this.devices();
      this.disabled();
      const value = this.value();
      if (value) {
        this.selectRef().nativeElement.value = value;
      }
    });
  }

  protected onChange(event: Event): void {
    this.changed.emit((event.target as HTMLSelectElement).value);
  }
}
