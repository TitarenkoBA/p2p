import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg height="128px" width="128px" viewBox="0 0 128 128" class="pl1" role="img" aria-label="Loading">
      <defs>
        <linearGradient y2="1" x2="1" y1="0" x1="0" id="pl-grad">
          <stop stop-color="#000" offset="0%"></stop>
          <stop stop-color="#fff" offset="100%"></stop>
        </linearGradient>
        <mask id="pl-mask">
          <rect fill="url(#pl-grad)" height="128" width="128" y="0" x="0"></rect>
        </mask>
      </defs>
      <g fill="rgb(226, 57, 241)">
        <g class="pl1__g">
          <g transform="translate(20,20) rotate(0,44,44)">
            <g class="pl1__rect-g">
              <rect height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
              <rect transform="translate(0,48)" height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
            </g>
            <g transform="rotate(180,44,44)" class="pl1__rect-g">
              <rect height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
              <rect transform="translate(0,48)" height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
            </g>
          </g>
        </g>
      </g>
      <g mask="url(#pl-mask)" fill="rgb(89, 92, 252)">
        <g class="pl1__g">
          <g transform="translate(20,20) rotate(0,44,44)">
            <g class="pl1__rect-g">
              <rect height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
              <rect transform="translate(0,48)" height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
            </g>
            <g transform="rotate(180,44,44)" class="pl1__rect-g">
              <rect height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
              <rect transform="translate(0,48)" height="40" width="40" ry="8" rx="8" class="pl1__rect"></rect>
            </g>
          </g>
        </g>
      </g>
    </svg>
  `,
  styleUrl: './loader.component.css',
  host: {
    class: 'fixed top-[50%] left-[50%] -translate-1/2 z-[999] pointer-events-none'
  }
})
export class LoaderComponent {}
