import { Component, ElementRef, OnDestroy, OnInit, ViewChild, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClockComponent } from '../components/clock.component';
import { AudioService } from '../services/audio.service';
import { RangeComponent } from '../components/range/range.component';
import { PeerJsService } from '../services/peerjs.service';
import { environment } from '../environments/environment';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ChatMessage {
  author: 'me' | 'peer';
  text: string;
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

@Component({
  selector: 'app-root',
  imports: [FormsModule, ClockComponent, RangeComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  @ViewChild('localVideo')
  private localVideoRef?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideoRef?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteAudio')
  private remoteAudioRef?: ElementRef<HTMLAudioElement>;

  @ViewChild('scrollContainer')
  private myScrollContainer!: ElementRef;

  protected readonly peerJs = inject(PeerJsService);
  public readonly audioService = inject(AudioService);
  protected readonly isProduction = environment.production;

  protected remotePeerId = '';
  protected customRoomId = '';
  protected outboundMessage = '';
  protected readonly chatMessages = signal<ChatMessage[]>([]);
  protected readonly status = signal('Not connected');
  protected readonly isTimerStarted = signal(false);
  protected readonly isLoading = signal(false);
  protected readonly isMicEnabled = signal(false);
  protected readonly isCamEnabled = signal(false);
  protected readonly isMediaStarted = signal(false);
  protected readonly canInstallApp = signal(false);

  readonly myPeerId = this.peerJs.myPeerId;

  private localStream?: MediaStream;
  private remoteVideoStream?: MediaStream;
  private remoteAudioStream?: MediaStream;
  private installPromptEvent?: BeforeInstallPromptEvent;

  private readonly onBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault();
    this.installPromptEvent = event as BeforeInstallPromptEvent;
    this.canInstallApp.set(true);
  };

  private readonly onAppInstalled = (): void => {
    this.installPromptEvent = undefined;
    this.canInstallApp.set(false);
    this.status.set('App installed');
  };

  protected readonly closeInstallBanner = (): void => {
    this.audioService.play('click');
    this.canInstallApp.set(false);
  };

  constructor() {
    this.peerJs.setCallbacks({
      onStatusChange: (s) => this.status.set(s),
      onDataOpen: () => {
        this.switchOffMicrophone();
        this.switchOffCamera();
        this.isTimerStarted.set(true);
        this.audioService.play('connected');
      },
      onDataMessage: (text) => {
        this.chatMessages.update((items) => [...items, { author: 'peer', text }]);
        this.audioService.play('notification');
        setTimeout(() => this.scrollToBottom());
      },
      onRemoteStreamsChange: (video, audio) => {
        this.remoteVideoStream = video;
        this.remoteAudioStream = audio;
        this.renderRemoteMedia();
      },
      onDisconnected: () => {
        this.isTimerStarted.set(false);
        this.remoteVideoStream = undefined;
        this.remoteAudioStream = undefined;
        this.renderRemoteMedia();
      }
    });

    effect(() => {
      const status = this.status();
      if (status?.includes('disconnected') || status?.includes('Not connected') || status?.includes('failed')) {
        this.isTimerStarted.set(false);
        this.audioService.play('disconnected');
      }
    });
  }

  scrollToBottom(): void {
    try {
      this.myScrollContainer.nativeElement.scrollTop =
        this.myScrollContainer.nativeElement.scrollHeight;
    } catch {
      /* scroll container not ready */
    }
  }

  ngOnInit(): void {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    if (!isStandalone) {
      window.addEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
    }
    window.addEventListener('appinstalled', this.onAppInstalled);
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', this.onAppInstalled);
    this.peerJs.disconnect(false);
  }

  protected async installApp(): Promise<void> {
    this.audioService.play('click');
    if (!this.installPromptEvent) {
      return;
    }

    await this.installPromptEvent.prompt();
    const choice = await this.installPromptEvent.userChoice;
    if (choice.outcome === 'accepted') {
      this.status.set('Install accepted');
    } else {
      this.status.set('Install dismissed');
    }
    this.installPromptEvent = undefined;
    this.canInstallApp.set(false);
  }

  protected async startCameraAndMic(): Promise<void> {
    if (this.localStream) {
      return;
    }

    if (!window.isSecureContext) {
      this.status.set('Camera requires HTTPS or localhost');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      this.status.set('getUserMedia is not supported in this browser');
      return;
    }

    this.localStream = await this.requestLocalStreamWithFallback();
    this.renderLocalStream();

    const hasVideo = this.localStream.getVideoTracks().length > 0;
    const hasAudio = this.localStream.getAudioTracks().length > 0;

    if (hasVideo && hasAudio) {
      this.status.set('Local media is ready');
      return;
    }

    if (hasAudio) {
      this.status.set('Audio only mode is active');
      return;
    }

    this.status.set('Chat only mode is active');
  }

  protected async createRoom(): Promise<void> {
    this.audioService.play('click');
    this.isLoading.set(true);
    try {
      await this.startCameraAndMic();
      await this.peerJs.createRoom(this.localStream, this.customRoomId || undefined);
      this.audioService.play('notification');
    } catch (error) {
      this.status.set(`Failed to create room: ${this.getErrorMessage(error)}`);
      this.audioService.play('disconnected');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async joinRoom(): Promise<void> {
    this.audioService.play('click');
    this.isLoading.set(true);
    try {
      await this.startCameraAndMic();
      await this.peerJs.joinRoom(this.remotePeerId, this.localStream);
      this.audioService.play('notification');
    } catch (error) {
      this.status.set(`Failed to join: ${this.getErrorMessage(error)}`);
      this.audioService.play('disconnected');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey) {
      this.sendMessage();
    }
  }

  protected sendMessage(): void {
    this.audioService.play('send-message');
    const message = this.outboundMessage.trim();
    if (!message || !this.peerJs.sendMessage(message)) {
      return;
    }

    this.chatMessages.update((items) => [...items, { author: 'me', text: message }]);
    setTimeout(() => this.scrollToBottom());
    this.outboundMessage = '';
  }

  protected toggleMicrophone(): void {
    this.audioService.play('click');
    if (!this.localStream) {
      return;
    }

    const enabled = !this.isMicEnabled();
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = enabled;
    }
    this.isMicEnabled.set(enabled);
  }

  protected switchOffMicrophone(): void {
    if (!this.localStream) {
      return;
    }

    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = false;
    }
    this.isMicEnabled.set(false);
  }

  protected toggleCamera(): void {
    this.audioService.play('click');
    if (!this.localStream) {
      return;
    }
    if (this.localStream.getVideoTracks().length === 0) {
      this.status.set('Camera is unavailable on this device');
      return;
    }

    const enabled = !this.isCamEnabled();
    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = enabled;
    }
    this.isCamEnabled.set(enabled);
  }

  protected switchOffCamera(): void {
    if (!this.localStream) {
      return;
    }
    if (this.localStream.getVideoTracks().length === 0) {
      return;
    }

    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = false;
    }
    this.isCamEnabled.set(false);
  }

  protected async copyPeerId(): Promise<void> {
    this.audioService.play('click');
    const id = this.myPeerId();
    if (!id) {
      return;
    }

    await navigator.clipboard.writeText(id);
    this.status.set('Peer ID copied');
  }

  protected disconnect(): void {
    this.peerJs.disconnect();
    this.remotePeerId = '';
    this.chatMessages.set([]);
    this.remoteVideoStream = undefined;
    this.remoteAudioStream = undefined;
    this.renderRemoteMedia();
    this.isTimerStarted.set(false);
  }

  private renderLocalStream(): void {
    if (!this.localVideoRef) {
      return;
    }
    this.localVideoRef.nativeElement.srcObject = this.localStream ?? null;
    this.localVideoRef.nativeElement.muted = true;
    this.localVideoRef.nativeElement.volume = 0;
  }

  private renderRemoteMedia(): void {
    if (!this.remoteVideoRef) {
      return;
    }
    this.remoteVideoRef.nativeElement.srcObject = this.remoteVideoStream ?? null;
    this.remoteVideoRef.nativeElement.muted = true;

    if (!this.remoteAudioRef) {
      return;
    }
    this.remoteAudioRef.nativeElement.srcObject = this.remoteAudioStream ?? null;
  }

  private async requestLocalStreamWithFallback(): Promise<MediaStream> {
    const attempts: MediaStreamConstraints[] = [
      {
        audio: MIC_CONSTRAINTS,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      },
      {
        audio: MIC_CONSTRAINTS,
        video: true
      },
      {
        audio: MIC_CONSTRAINTS,
        video: false
      }
    ];

    let lastError: unknown = new Error('Could not start local media');
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
      }
    }

    this.status.set(`Media fallback: ${this.getErrorMessage(lastError)}. Switching to chat only.`);
    return new MediaStream();
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'Unknown error';
  }
}
