import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AudioService } from './audio.service';
import { LocalMediaService, MediaKind } from './local-media.service';
import { ConnectionState, PeerEvent, PeerJsService } from './peerjs.service';

export type StatusTone = 'neutral' | 'busy' | 'ok' | 'error';

export interface ChatMessage {
  id: number;
  author: 'me' | 'peer' | 'system';
  text: string;
  at: Date;
}

interface StatusNotice {
  text: string;
  tone: StatusTone;
}

const STATE_STATUS: Record<ConnectionState, StatusNotice> = {
  idle: { text: 'Not connected', tone: 'neutral' },
  opening: { text: 'Connecting to the signaling server…', tone: 'busy' },
  waiting: { text: 'Room is open. Share the invite link and wait for your peer.', tone: 'busy' },
  connecting: { text: 'Connecting to peer…', tone: 'busy' },
  connected: { text: 'Connected', tone: 'ok' }
};

/** Ties the peer connection, local media, chat and sounds into one call session for the UI. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly peer = inject(PeerJsService);
  private readonly media = inject(LocalMediaService);
  private readonly audio = inject(AudioService);

  private operationId = 0;
  private nextMessageId = 0;
  private readonly notice = signal<StatusNotice | null>(null);

  readonly messages = signal<ChatMessage[]>([]);
  readonly isBusy = signal(false);
  readonly isConnected = computed(() => this.peer.state() === 'connected');
  readonly isIdle = computed(() => this.peer.state() === 'idle' && !this.isBusy());
  readonly isHost = computed(() => this.peer.role() === 'host');
  readonly roomId = computed(() => (this.isHost() ? this.peer.myPeerId() : this.peer.remotePeerId()));

  private readonly currentStatus = computed<StatusNotice>(() => {
    // An open call does not need signaling, so only a waiting host has to know it is gone.
    if (this.peer.signalingLost() && this.peer.state() === 'waiting') {
      return { text: 'Lost the signaling server. Reconnecting…', tone: 'busy' };
    }
    return this.notice() ?? STATE_STATUS[this.peer.state()];
  });
  readonly status = computed(() => this.currentStatus().text);
  readonly tone = computed(() => this.currentStatus().tone);

  readonly leaveLabel = computed(() => {
    if (this.isConnected()) {
      return 'Disconnect';
    }
    return this.peer.state() === 'waiting' ? 'Close room' : 'Cancel';
  });

  constructor() {
    this.peer.events$.subscribe((event) => this.handlePeerEvent(event));
    effect(() => {
      if (this.isConnected()) {
        this.peer.sendMediaState({
          mic: this.media.isMicEnabled(),
          cam: this.media.isCamEnabled(),
          screen: this.media.isSharingScreen()
        });
      }
    });
  }

  createRoom(roomId: string): Promise<void> {
    return this.start(async (stream) => {
      await this.peer.createRoom(stream, roomId);
      this.audio.play('notification');
    });
  }

  joinRoom(remotePeerId: string): Promise<void> {
    return this.start((stream) => this.peer.joinRoom(remotePeerId, stream));
  }

  leave(): void {
    this.audio.play('click');
    const wasActive = this.peer.state() !== 'idle';
    this.operationId += 1;
    this.isBusy.set(false);
    this.peer.disconnect();
    this.media.release();
    this.notice.set(null);
    this.messages.set([]);
    if (wasActive) {
      this.audio.play('disconnected');
    }
  }

  sendMessage(text: string): boolean {
    const message = text.trim();
    if (!message || !this.peer.sendMessage(message)) {
      return false;
    }
    this.audio.play('send-message');
    this.addMessage('me', message);
    return true;
  }

  /** Sharing needs a connected peer: nobody should land on a screen that is already being shown. */
  async toggleScreenShare(): Promise<void> {
    this.audio.play('click');
    if (this.media.isSharingScreen()) {
      this.stopScreenShare();
      return;
    }
    if (!this.isConnected()) {
      return;
    }

    const track = await this.media.startScreenShare(() => this.sendCamera());
    if (track) {
      this.peer.setOutgoingTrack('video', track);
    }
  }

  async switchDevice(kind: MediaKind, deviceId: string): Promise<void> {
    const result = await this.media.switchDevice(kind, deviceId);
    if (!result) {
      return;
    }
    // While sharing, the new camera just waits for the share to end.
    if (kind === 'audio' || !this.media.isSharingScreen()) {
      this.peer.setOutgoingTrack(kind, result.track);
    }
    if (!result.ok) {
      this.notify('Could not switch to that device.', 'error');
    }
  }

  /** Shows a one-off message in the status area, e.g. a failed clipboard write. */
  notify(text: string, tone: StatusTone = 'neutral'): void {
    this.notice.set({ text, tone });
  }

  private async start(connect: (stream: MediaStream) => Promise<void>): Promise<void> {
    this.audio.play('click');
    const operation = ++this.operationId;
    this.isBusy.set(true);
    this.messages.set([]);
    this.notify('Waiting for camera and microphone access…', 'busy');

    try {
      const stream = await this.media.acquire();
      if (operation !== this.operationId) {
        return;
      }
      this.notice.set(null);
      await connect(stream);
    } catch (error) {
      if (operation === this.operationId) {
        this.media.release();
        this.notify(error instanceof Error && error.message ? error.message : 'Unknown error', 'error');
        this.audio.play('disconnected');
      }
    } finally {
      if (operation === this.operationId) {
        this.isBusy.set(false);
      }
    }
  }

  private handlePeerEvent(event: PeerEvent): void {
    switch (event.type) {
      case 'joined':
        this.media.muteAll();
        this.notice.set(null);
        this.addMessage('system', 'Peer connected');
        this.audio.play('connected');
        break;
      case 'left':
        this.addMessage('system', 'Peer left');
        this.audio.play('disconnected');
        if (event.role === 'host') {
          this.stopScreenShare();
          this.media.muteAll();
          this.notify('Your peer left. The room stays open for the next one.', 'busy');
        } else {
          this.media.release();
          this.notify('The host left the room.');
        }
        break;
      case 'room-full':
        this.media.release();
        this.messages.set([]);
        this.notify('This room already has a participant.', 'error');
        this.audio.play('disconnected');
        break;
      case 'message':
        this.addMessage('peer', event.text);
        this.audio.playNotification('notification');
        break;
      case 'error':
        this.notify(event.message, 'error');
        break;
    }
  }

  private stopScreenShare(): void {
    this.media.stopScreenShare();
    this.sendCamera();
  }

  private sendCamera(): void {
    this.peer.setOutgoingTrack('video', this.media.cameraTrack() ?? null);
  }

  private addMessage(author: ChatMessage['author'], text: string): void {
    const message: ChatMessage = { id: this.nextMessageId++, author, text, at: new Date() };
    this.messages.update((items) => [...items, message]);
  }
}
