import { Component, ElementRef, OnDestroy, OnInit, ViewChild, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ChatMessage {
  author: 'me' | 'peer';
  text: string;
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  @ViewChild('localVideo')
  private localVideoRef?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideoRef?: ElementRef<HTMLVideoElement>;

  protected localSignalText = '';
  protected remoteSignalText = '';
  protected outboundMessage = '';
  protected readonly chatMessages = signal<ChatMessage[]>([]);
  protected readonly status = signal('Not connected');
  protected readonly isMicEnabled = signal(true);
  protected readonly isCamEnabled = signal(true);
  protected readonly canInstallApp = signal(false);

  private localStream?: MediaStream;
  private remoteStream?: MediaStream;
  private peerConnection?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
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
    this.canInstallApp.set(false);
  };

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
  }

  protected async installApp(): Promise<void> {
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
    this.isCamEnabled.set(hasVideo);
    this.isMicEnabled.set(hasAudio);

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

  protected async createOffer(): Promise<void> {
    try {
      if (!window.RTCPeerConnection) {
        this.status.set('WebRTC is not supported in this browser');
        return;
      }
      await this.startCameraAndMic();
      this.disconnect(false, false);
      this.status.set('Creating offer...');

      const pc = this.buildPeerConnection();
      this.attachLocalTracks(pc);
      this.dataChannel = this.buildDataChannel(pc.createDataChannel('chat'));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIceGathering(pc, 4000);
      this.localSignalText = JSON.stringify(pc.localDescription);
      this.status.set('Offer created. Share it with your peer.');
    } catch (error) {
      this.status.set(`Failed to create offer: ${this.getErrorMessage(error)}`);
    }
  }

  protected async createAnswerFromOffer(): Promise<void> {
    try {
      await this.startCameraAndMic();
      this.disconnect(false, false);
      this.status.set('Creating answer...');

      const remoteOffer = this.parseSignalText('offer');
      const pc = this.buildPeerConnection();
      this.attachLocalTracks(pc);
      await pc.setRemoteDescription(remoteOffer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIceGathering(pc, 4000);
      this.localSignalText = JSON.stringify(pc.localDescription);
      this.status.set('Answer created. Send it back to caller.');
    } catch (error) {
      this.status.set(`Failed to create answer: ${this.getErrorMessage(error)}`);
    }
  }

  protected async applyRemoteAnswer(): Promise<void> {
    try {
      if (!this.peerConnection || !this.peerConnection.localDescription) {
        this.status.set('Create offer first');
        return;
      }

      const remoteAnswer = this.parseSignalText('answer');
      await this.peerConnection.setRemoteDescription(remoteAnswer);
      this.status.set('Remote answer applied');
    } catch (error) {
      this.status.set(`Failed to apply answer: ${this.getErrorMessage(error)}`);
    }
  }

  protected sendMessage(): void {
    const message = this.outboundMessage.trim();
    if (!message || this.dataChannel?.readyState !== 'open') {
      return;
    }

    this.dataChannel.send(message);
    this.chatMessages.update((items) => [...items, { author: 'me', text: message }]);
    this.outboundMessage = '';
  }

  protected toggleMicrophone(): void {
    if (!this.localStream) {
      return;
    }

    const enabled = !this.isMicEnabled();
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = enabled;
    }
    this.isMicEnabled.set(enabled);
  }

  protected toggleCamera(): void {
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

  protected async copySignal(): Promise<void> {
    if (!this.localSignalText) {
      return;
    }

    await navigator.clipboard.writeText(this.localSignalText);
    this.status.set('Signal copied');
  }

  protected disconnect(resetSignal = true, updateStatus = true): void {
    this.peerConnection?.close();
    this.peerConnection = undefined;
    this.dataChannel = undefined;
    this.remoteStream = undefined;
    this.renderRemoteStream();
    if (resetSignal) {
      this.remoteSignalText = '';
      this.localSignalText = '';
    }
    if (updateStatus) {
      this.status.set('Not connected');
    }
  }

  private buildPeerConnection(): RTCPeerConnection {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
    });

    this.peerConnection.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      for (const track of event.streams[0].getTracks()) {
        this.remoteStream.addTrack(track);
      }
      this.renderRemoteStream();
    };

    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = this.buildDataChannel(event.channel);
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState ?? 'unknown';
      this.status.set(`Connection: ${state}`);
    };

    return this.peerConnection;
  }

  private buildDataChannel(channel: RTCDataChannel): RTCDataChannel {
    channel.onopen = () => this.status.set('Connected');
    channel.onmessage = (event) => {
      this.chatMessages.update((items) => [
        ...items,
        { author: 'peer', text: String(event.data) }
      ]);
    };
    return channel;
  }

  private parseSignalText(expectedType: 'offer' | 'answer'): RTCSessionDescriptionInit {
    const parsed = JSON.parse(this.remoteSignalText) as RTCSessionDescriptionInit;
    if (parsed.type !== expectedType || !parsed.sdp) {
      throw new Error(`Invalid ${expectedType}`);
    }
    return parsed;
  }

  private attachLocalTracks(pc: RTCPeerConnection): void {
    if (!this.localStream) {
      return;
    }

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }
  }

  private async waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', watcher);
        resolve();
      }, timeoutMs);

      const watcher = () => {
        if (pc.iceGatheringState === 'complete') {
          window.clearTimeout(timeoutId);
          pc.removeEventListener('icegatheringstatechange', watcher);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', watcher);
    });
  }

  private renderLocalStream(): void {
    if (!this.localVideoRef) {
      return;
    }
    this.localVideoRef.nativeElement.srcObject = this.localStream ?? null;
  }

  private renderRemoteStream(): void {
    if (!this.remoteVideoRef) {
      return;
    }
    this.remoteVideoRef.nativeElement.srcObject = this.remoteStream ?? null;
  }

  private async requestLocalStreamWithFallback(): Promise<MediaStream> {
    const attempts: MediaStreamConstraints[] = [
      {
        audio: true,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      },
      {
        audio: true,
        video: true
      },
      {
        audio: true,
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
