import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { timer, Subscription } from 'rxjs';

@Component({
  selector: 'clock',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="clock-wrap">
      <div class="clock-display">
        <span>{{ currentTime() | date:'HH' }}</span>
        <span class="dots">:</span>
        <span>{{ currentTime() | date:'mm' }}</span>
        <span class="dots">:</span>
        <span>{{ currentTime() | date:'ss' }}</span>
      </div>
    </div>
  `,
  styles: [`
    .clock-wrap {
        min-width: 135px;
        display: flex;
        justify-content: center;
    }
    .clock-display {
        color: #243041;
        width: 100%;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        font-size: 1.5rem;
        font-weight: 600;
        padding: 0.5rem 1rem;
        border-radius: 10px;
        box-shadow:
            6px 6px 12px #c5c5c5,
            -6px -6px 12px #ffffff;
    }
    .dots {
        animation: blink 2s step-start infinite;
        padding: 0 5px;
    }
    @keyframes blink {
        50% { opacity: 0;  }
    }
  `]
})
export class ClockComponent implements OnInit, OnDestroy {
  currentTime = signal(new Date());
  private timerSub?: Subscription;

  ngOnInit(): void {
    this.timerSub = timer(0, 1000).subscribe(() => {
      this.currentTime.set(new Date());
    });
  }

  ngOnDestroy(): void {
    this.timerSub?.unsubscribe();
  }
}
