import { Component, ElementRef, afterRenderEffect, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LinkStatus } from '../../services/room/peer-link';
import { SpeechDetectorService } from '../../services/speech-detector.service';

/** One person in the call: their video, their audio and what they have switched off. */
@Component({
  selector: 'video-tile',
  templateUrl: './video-tile.component.html',
  styleUrl: './video-tile.component.css',
  host: {
    '[class.is-self]': 'isSelf()',
    '[class.is-speaking]': 'isSpeaking()'
  }
})
export class VideoTileComponent {
  name = input.required<string>();
  video = input<MediaStream>();
  /** Omitted for the self-view, which must never play back its own microphone. */
  audio = input<MediaStream>();
  isSelf = input(false);
  isVideoOn = input(false);
  isMicOn = input(false);
  isScreen = input(false);
  status = input<LinkStatus>('connected');
  /** False keeps the streams attached but silent, while the stage is collapsed. */
  audible = input(true);
  volume = input(1);
  speakerId = input('');
  /** The audio to measure for the speaking highlight; for the self-view, the microphone while it is on. */
  levelStream = input<MediaStream>();

  protected readonly isSpeaking = signal(false);
  private readonly speech = inject(SpeechDetectorService);

  protected readonly placeholder = computed(() => {
    if (this.status() === 'failed') {
      return `Could not connect to ${this.name()}`;
    }
    if (this.status() === 'connecting') {
      return 'Connecting…';
    }
    if (this.isScreen()) {
      return null;
    }
    if (!this.isVideoOn()) {
      return 'Camera off';
    }
    return this.video() ? null : 'Waiting for video…';
  });

  private readonly videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('videoEl');
  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audioEl');

  constructor() {
    effect((onCleanup) => {
      const stream = this.levelStream();
      if (!stream) {
        return;
      }
      const stop = this.speech.watch(stream, (isSpeaking) => this.isSpeaking.set(isSpeaking));
      onCleanup(() => {
        stop();
        this.isSpeaking.set(false);
      });
    });
    afterRenderEffect(() => {
      this.videoRef().nativeElement.srcObject = this.video() ?? null;
    });
    afterRenderEffect(() => {
      const element = this.audioRef()?.nativeElement;
      if (element) {
        element.srcObject = this.audio() ?? null;
      }
    });
    afterRenderEffect(() => {
      const element = this.audioRef()?.nativeElement;
      if (element) {
        element.volume = Math.min(1, Math.max(0, this.volume()));
      }
    });
    afterRenderEffect(() => {
      const element = this.audioRef()?.nativeElement;
      const speakerId = this.speakerId();
      if (element && speakerId && 'setSinkId' in element) {
        element.setSinkId(speakerId).catch((error: unknown) => console.warn('Could not set speaker', error));
      }
    });
  }
}
