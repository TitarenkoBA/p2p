import { Component, ElementRef, afterRenderEffect, computed, input, signal, viewChild } from '@angular/core';
import { PeerMediaState } from '../../services/peerjs.service';

/** iPhones can only make a video element fullscreen, through this WebKit method. */
type WebkitVideoElement = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

@Component({
  selector: 'video-stage',
  templateUrl: './video-stage.component.html',
  styleUrl: './video-stage.component.css',
  host: {
    '(document:fullscreenchange)': 'syncFullscreen()'
  }
})
export class VideoStageComponent {
  /** Hidden stage keeps the streams attached but stays collapsed and silent. */
  active = input.required<boolean>();
  localStream = input<MediaStream>();
  remoteVideo = input<MediaStream>();
  remoteAudio = input<MediaStream>();
  isCamEnabled = input(false);
  remoteVolume = input(1);
  speakerId = input('');
  remoteMedia = input<PeerMediaState>({ mic: false, cam: false, screen: false });
  isSharingScreen = input(false);

  protected readonly isFullscreen = signal(false);
  protected readonly canFullscreen =
    document.fullscreenEnabled === true || 'webkitEnterFullscreen' in HTMLVideoElement.prototype;
  protected readonly isRemoteVideoOn = computed(() => this.remoteMedia().cam || this.remoteMedia().screen);

  private readonly stageRef = viewChild.required<ElementRef<HTMLElement>>('stageEl');

  private readonly localVideoRef = viewChild.required<ElementRef<HTMLVideoElement>>('localVideoEl');
  private readonly remoteVideoRef = viewChild.required<ElementRef<HTMLVideoElement>>('remoteVideoEl');
  private readonly remoteAudioRef = viewChild.required<ElementRef<HTMLAudioElement>>('remoteAudioEl');

  constructor() {
    afterRenderEffect(() => {
      this.localVideoRef().nativeElement.srcObject = this.localStream() ?? null;
    });
    afterRenderEffect(() => {
      this.remoteVideoRef().nativeElement.srcObject = this.remoteVideo() ?? null;
    });
    afterRenderEffect(() => {
      this.remoteAudioRef().nativeElement.srcObject = this.remoteAudio() ?? null;
    });
    afterRenderEffect(() => {
      this.remoteAudioRef().nativeElement.volume = this.remoteVolume();
    });
    afterRenderEffect(() => {
      const element = this.remoteAudioRef().nativeElement;
      const speakerId = this.speakerId();
      if (speakerId && 'setSinkId' in element) {
        element.setSinkId(speakerId).catch((error: unknown) => console.warn('Could not set speaker', error));
      }
    });
  }

  protected async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    const stage = this.stageRef().nativeElement;
    const video = this.remoteVideoRef().nativeElement as WebkitVideoElement;
    try {
      if (document.fullscreenEnabled) {
        await stage.requestFullscreen();
      } else {
        video.webkitEnterFullscreen?.();
      }
    } catch (error) {
      console.warn('Could not enter fullscreen', error);
    }
  }

  protected syncFullscreen(): void {
    this.isFullscreen.set(document.fullscreenElement === this.stageRef().nativeElement);
  }
}
