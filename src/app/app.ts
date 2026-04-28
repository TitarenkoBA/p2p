import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal  } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import { ShortenerService } from './dataSharing.service';

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
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy  {
  @ViewChild('localVideo')
  private localVideoRef?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideoRef?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteAudio')
  private remoteAudioRef?: ElementRef<HTMLAudioElement>;

  @ViewChild('scrollContainer') 
  private myScrollContainer!: ElementRef;
  private readonly dataSharingService = inject(ShortenerService);
  protected localSignalBase64 = '';
  protected localSignalText = '';
  protected remoteSignalText = '';
  protected outboundMessage = '';
  protected readonly chatMessages = signal<ChatMessage[]>([]);
  protected readonly status = signal('Not connected');
  protected readonly isTimerStarted = signal(false);
  protected readonly isLoading = signal(false);
  protected readonly isMicEnabled = signal(false);
  protected readonly isCamEnabled = signal(false);
  protected readonly isMediaStarted = signal(false);
  protected readonly canInstallApp = signal(false);

  private localStream?: MediaStream;
  private remoteVideoStream?: MediaStream;
  private remoteAudioStream?: MediaStream;
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


  scrollToBottom(): void {
    try {
      this.myScrollContainer.nativeElement.scrollTop = 
        this.myScrollContainer.nativeElement.scrollHeight;
    } catch(err) { }
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
    // this.isCamEnabled.set(hasVideo);
    // this.isMicEnabled.set(hasAudio);

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
    this.isLoading.set(true);
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
      const packed = this.pack(JSON.stringify(pc.localDescription));

      this.localSignalBase64 = packed;
      try {
        const url = await this.dataSharingService.createLink(packed);
        this.localSignalText = url;
      } catch(err) {
        this.localSignalText = packed;
      }
      this.status.set('Offer created. Share it with your peer.');
      this.isLoading.set(false);
    } catch (error) {
      this.status.set(`Failed to create offer: ${this.getErrorMessage(error)}`);
      this.isLoading.set(false);
    }
  }

  protected async createAnswerFromOffer(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.startCameraAndMic();
      this.disconnect(false, false);
      this.status.set('Creating answer...');

      const remoteOffer = await this.processRemoteSignal(this.remoteSignalText, 'offer');
      const pc = this.buildPeerConnection();
      this.attachLocalTracks(pc);
      await pc.setRemoteDescription(remoteOffer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIceGathering(pc, 4000);
      const packed = this.pack(JSON.stringify(pc.localDescription));
      this.localSignalBase64 = packed;
      try {
        const url = await this.dataSharingService.createLink(packed);
        this.localSignalText = url;
      } catch(err) {
        this.localSignalText = packed;
      }
      this.status.set('Answer created. Send it back to caller.');
      this.isLoading.set(false);
    } catch (error) {
      this.status.set(`Failed to create answer: ${this.getErrorMessage(error)}`);
      this.isLoading.set(false);
    }
  }

  protected async applyRemoteAnswer(): Promise<void> {
    this.isLoading.set(true);
    try {
      if (!this.peerConnection || !this.peerConnection.localDescription) {
        this.status.set('Create offer first');
        this.isLoading.set(false);
        return;
      }

      const remoteAnswer = await this.processRemoteSignal(this.remoteSignalText, 'answer');
      await this.peerConnection.setRemoteDescription(remoteAnswer);
      this.status.set('Remote answer applied');
      this.isLoading.set(false);
    } catch (error) {
      this.status.set(`Failed to apply answer: ${this.getErrorMessage(error)}`);
      this.isLoading.set(false);
    }
  }

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey) {
      this.sendMessage();
    }
  }
  protected sendMessage(): void {
    const message = this.outboundMessage.trim();
    if (!message || this.dataChannel?.readyState !== 'open') {
      return;
    }

    this.dataChannel.send(message);
    this.chatMessages.update((items) => [...items, { author: 'me', text: message }]);
    setTimeout(() => this.scrollToBottom());
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
  protected switchOffMicrophone(): void {
    if (!this.localStream) {
      return;
    }

    this.isMicEnabled.set(false);
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = false;
    }
    this.isMicEnabled.set(false);
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

  protected switchOffCamera(): void {
    if (!this.localStream) {
      return;
    }
    if (this.localStream.getVideoTracks().length === 0) {
      return;
    }

    this.isCamEnabled.set(false)
    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = false;
    }
    this.isCamEnabled.set(false);
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
    this.remoteVideoStream = undefined;
    this.remoteAudioStream = undefined;
    this.renderRemoteMedia();
    if (resetSignal) {
      this.remoteSignalText = '';
      this.localSignalText = '';
      this.localSignalBase64 = '';
    }
    if (updateStatus) {
      this.status.set('Not connected');
    }
    this.isTimerStarted.set(false)
  }

  private buildPeerConnection(): RTCPeerConnection {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
    });

    this.peerConnection.ontrack = (event) => {
      if (event.track.kind === 'video') {
        if (!this.remoteVideoStream) {
          this.remoteVideoStream = new MediaStream();
        }
        const existingTrackIds = new Set(this.remoteVideoStream.getTracks().map((track) => track.id));
        if (!existingTrackIds.has(event.track.id)) {
          this.remoteVideoStream.addTrack(event.track);
        }
      } else if (event.track.kind === 'audio') {
        if (!this.remoteAudioStream) {
          this.remoteAudioStream = new MediaStream();
        }
        const existingTrackIds = new Set(this.remoteAudioStream.getTracks().map((track) => track.id));
        if (!existingTrackIds.has(event.track.id)) {
          this.remoteAudioStream.addTrack(event.track);
        }
      }
      this.renderRemoteMedia();
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
    channel.onopen = () => {
      this.switchOffMicrophone();
      this.switchOffCamera();
      this.isTimerStarted.set(true);
      this.status.set('Connected');
    };
    channel.onmessage = (event) => {
      this.chatMessages.update((items) => [
        ...items,
        { author: 'peer', text: String(event.data) }
      ]);
      setTimeout(() => this.scrollToBottom());
    };
    return channel;
  }

  private async processRemoteSignal(receivedUrl: string, expectedType: 'offer' | 'answer') {
    try {
      let localSignalText = this.localSignalText;
      if (receivedUrl.startsWith('https')) {
        try {
          const dataFromLink = await this.dataSharingService.getData(receivedUrl);
          localSignalText = dataFromLink;
        } catch(err) {
          localSignalText = this.localSignalBase64;
        }
      } else {
        localSignalText = receivedUrl;
      }

      const parsed = this.parseSignalText(localSignalText, expectedType);

      return parsed;

    } catch (err: any) {
      if (err.name === 'TimeoutError') {
        console.error('Ошибка: Сервис не ответил вовремя (таймаут)');
      } else {
        console.error('Ошибка при получении или парсинге данных:', err);
      }
      throw err; 
    }
  }

  private parseSignalText(rawString: string, expectedType: 'offer' | 'answer'): RTCSessionDescriptionInit {
    const parsed = JSON.parse(this.unpack(rawString)) as RTCSessionDescriptionInit;
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

  private pack(sdp: string): string {
    if (!sdp) return "";
    
    const rawSdp = (typeof sdp === 'object') ? sdp['sdp'] : sdp;
  
    const lines = rawSdp.split(/\r?\n/);
    const minified = lines
      .map(line => line.trim())
      .filter(line => {
        if (line.length === 0) return false;
  
        const criticalPrefixes = [
          'v=', 'o=', 's=', 't=', 'c=', 'm=', 
          'a=setup', 'a=mid', 'a=ice-ufrag', 
          'a=ice-pwd', 'a=fingerprint', 'a=sctp-port'
        ];
        
        const isCritical = criticalPrefixes.some(p => line.startsWith(p));
        
        const isOpus = line.includes('a=rtpmap:') && line.toLowerCase().includes('opus');
        const isCandidate = line.includes('a=candidate:') && line.toLowerCase().includes('udp');
  
        return isCritical || isOpus || isCandidate;
      })
      .join('\n');
  
    const compressed = deflateSync(strToU8(minified), { level: 9 });
    let binary = '';
    for (let i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed[i]);
    }
    return btoa(binary);
  }

  private unpack(packed: string): string {
    const binary = atob(packed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decompressed = inflateSync(bytes);
    return strFromU8(decompressed); 
  }
}
