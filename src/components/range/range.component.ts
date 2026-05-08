import { Component, output, input, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'range',
    templateUrl: './range.component.html',
    styleUrls: ['./range.component.scss'],
    imports: [FormsModule],
    host: {
        class: 'w-full md:w-1/2'
    }
})
export class RangeComponent {
    value = input.required<number>(); // Обязательный вход
    min = input<number>(0);
    max = input<number>(1);
    step = input<number>(0.01);
    valueChange = output<number>();
    finalChange = output<number>();
    backgroundSize = computed(() => {
        const percentage = ((this.value() - this.min()) / (this.max() - this.min())) * 100;
        return `${percentage}% 100%`;
    });

    onInput(event: Event) {
        const val = parseFloat((event.target as HTMLInputElement).value);
        this.valueChange.emit(val);
    }

    onChange(event: Event) {
        const val = parseFloat((event.target as HTMLInputElement).value);
        this.finalChange.emit(val);
    }
}
