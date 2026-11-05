import { Component, output, input, computed, linkedSignal } from '@angular/core';

@Component({
    selector: 'range',
    templateUrl: './range.component.html',
    styleUrls: ['./range.component.scss'],
    host: {
        class: 'block w-full'
    }
})
export class RangeComponent {
    value = input.required<number>(); // Обязательный вход
    min = input<number>(0);
    max = input<number>(1);
    step = input<number>(0.01);
    label = input<string>('');
    valueChange = output<number>();
    finalChange = output<number>();

    // Заполнение дорожки следует за бегунком и во время перетаскивания
    protected current = linkedSignal(() => this.value());
    protected percentage = computed(() =>
        Math.round(((this.current() - this.min()) / (this.max() - this.min())) * 100)
    );
    protected backgroundSize = computed(() => `${this.percentage()}% 100%`);

    onInput(event: Event) {
        const val = parseFloat((event.target as HTMLInputElement).value);
        this.current.set(val);
        this.valueChange.emit(val);
    }

    onChange(event: Event) {
        const val = parseFloat((event.target as HTMLInputElement).value);
        this.finalChange.emit(val);
    }
}
