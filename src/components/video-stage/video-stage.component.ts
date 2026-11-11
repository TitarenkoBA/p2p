import { Component, ElementRef, computed, effect, input, signal, viewChild } from '@angular/core';
import { PeerLink } from '../../services/room/peer-link';
import { VideoTileComponent } from '../video-tile/video-tile.component';

/** iPhones can only make a video element fullscreen, through this WebKit method. */
type WebkitVideoElement = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const SELF_KEY = '__self';
/** The grid has 12 columns, so two, three or four tiles in a row all divide it evenly. */
const GRID_COLUMNS = 12;

interface Tile {
  key: string;
  link: PeerLink | null;
}

/**
 * With one other person the call looks like a regular video call with a small self-view.
 * From two on everyone gets an equal tile, and a shared screen (or a tile you click) takes the top row.
 */
@Component({
  selector: 'video-stage',
  imports: [VideoTileComponent],
  templateUrl: './video-stage.component.html',
  styleUrl: './video-stage.component.css',
  host: {
    '(document:fullscreenchange)': 'syncFullscreen()'
  }
})
export class VideoStageComponent {
  /** Hidden stage keeps the streams attached but stays collapsed and silent. */
  active = input.required<boolean>();
  participants = input<PeerLink[]>([]);
  localStream = input<MediaStream>();
  /** Measured for this side's speaking highlight; the preview may be a screen without audio. */
  microphoneStream = input<MediaStream>();
  myName = input('You');
  isCamEnabled = input(false);
  isMicEnabled = input(false);
  isSharingScreen = input(false);
  /** Per participant, multiplied by `masterVolume`. */
  volumes = input<Record<string, number>>({});
  masterVolume = input(1);
  speakerId = input('');

  protected readonly selfKey = SELF_KEY;
  protected readonly isFullscreen = signal(false);
  protected readonly canFullscreen =
    document.fullscreenEnabled === true || 'webkitEnterFullscreen' in HTMLVideoElement.prototype;
  protected readonly isGrid = computed(() => this.participants().length > 1);
  /** Self last: the DOM order never changes, so no video element is moved and paused. */
  protected readonly tiles = computed<Tile[]>(() => [
    ...this.participants().map((link) => ({ key: link.id, link })),
    { key: SELF_KEY, link: null }
  ]);

  /** undefined follows the screen share; null means the user unpinned everything. */
  private readonly userPin = signal<string | null | undefined>(undefined);
  private readonly sharerKey = computed(() => this.participants().find((link) => link.media().screen)?.id ?? null);
  protected readonly pinnedKey = computed(() => {
    if (!this.isGrid()) {
      return null;
    }
    const pin = this.userPin();
    if (pin === undefined) {
      return this.sharerKey();
    }
    return pin && this.tiles().some((tile) => tile.key === pin) ? pin : null;
  });

  private readonly stageRef = viewChild.required<ElementRef<HTMLElement>>('stageEl');

  constructor() {
    // A new screen share takes the spotlight again, whatever was pinned before.
    effect(() => {
      this.sharerKey();
      this.userPin.set(undefined);
    });
  }

  protected volumeOf(link: PeerLink): number {
    return this.masterVolume() * (this.volumes()[link.id] ?? 1);
  }

  /** Grid placement: the pinned tile spans the top row, the rest share the rows below evenly. */
  protected gridColumn(key: string): string | null {
    if (!this.isGrid()) {
      return null;
    }
    const pinned = this.pinnedKey();
    if (key === pinned) {
      return '1 / -1';
    }
    const keys = this.tiles().map((tile) => tile.key).filter((item) => item !== pinned);
    const perRow = pinned ? keys.length : 2;
    const span = GRID_COLUMNS / perRow;
    // An odd tile out in the last row is centered.
    if (!pinned && keys.length % 2 === 1 && keys.at(-1) === key) {
      return `${span / 2 + 1} / span ${span}`;
    }
    return `span ${span}`;
  }

  protected togglePin(key: string): void {
    if (this.isGrid()) {
      this.userPin.set(this.pinnedKey() === key ? null : key);
    }
  }

  protected async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    const stage = this.stageRef().nativeElement;
    try {
      if (document.fullscreenEnabled) {
        await stage.requestFullscreen();
      } else {
        (stage.querySelector('video-tile:not(.is-self) video') as WebkitVideoElement | null)?.webkitEnterFullscreen?.();
      }
    } catch (error) {
      console.warn('Could not enter fullscreen', error);
    }
  }

  protected syncFullscreen(): void {
    this.isFullscreen.set(document.fullscreenElement === this.stageRef().nativeElement);
  }
}
