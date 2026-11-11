import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from './audio.service';
import { LocalMediaService, MediaKind } from './local-media.service';
import { MAX_NAME_LENGTH } from './room/protocol';
import { ConnectionState, RoomEvent, RoomService } from './room/room.service';

export type StatusTone = 'neutral' | 'busy' | 'ok' | 'error';

export interface ChatMessage {
  id: number;
  author: 'me' | 'peer' | 'system';
  /** Who wrote a peer message. */
  name?: string;
  text: string;
  at: Date;
}

interface StatusNotice {
  text: string;
  tone: StatusTone;
}

const NAME_STORAGE_KEY = 'p2p.name';

const STATE_STATUS: Record<ConnectionState, StatusNotice> = {
  idle: { text: 'Not connected', tone: 'neutral' },
  opening: { text: 'Connecting to the signaling server…', tone: 'busy' },
  waiting: { text: 'Room is open. Share the invite link and wait for others to join.', tone: 'busy' },
  connecting: { text: 'Connecting…', tone: 'busy' },
  connected: { text: 'Connected', tone: 'ok' }
};

function readStoredName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Ties the room, local media, chat and sounds into one call session for the UI. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly room = inject(RoomService);
  private readonly media = inject(LocalMediaService);
  private readonly audio = inject(AudioService);

  private operationId = 0;
  private nextMessageId = 0;
  private readonly notice = signal<StatusNotice | null>(null);

  readonly messages = signal<ChatMessage[]>([]);
  /** The name this side asks for. Empty lets the host pick a default. */
  readonly name = signal(readStoredName());
  readonly isBusy = signal(false);
  readonly isConnected = computed(() => this.room.state() === 'connected');
  readonly isIdle = computed(() => this.room.state() === 'idle' && !this.isBusy());
  readonly isHost = computed(() => this.room.role() === 'host');
  readonly roomId = this.room.roomId;
  readonly participants = this.room.participants;
  /** Including this side. */
  readonly headcount = computed(() => this.participants().length + 1);
  /** Who else is showing their screen right now; only one person can at a time. */
  readonly screenSharer = computed(() => this.participants().find((link) => link.media().screen) ?? null);

  private readonly currentStatus = computed<StatusNotice>(() => {
    const state = this.room.state();
    // An open call does not need signaling, so only a waiting host has to know it is gone.
    if (this.room.signalingLost() && state === 'waiting') {
      return { text: 'Lost the signaling server. Reconnecting…', tone: 'busy' };
    }
    const notice = this.notice();
    if (notice) {
      return notice;
    }
    if (state === 'connected') {
      return { text: `Connected · ${this.headcount()} of ${this.room.capacity} in the room`, tone: 'ok' };
    }
    return STATE_STATUS[state];
  });
  readonly status = computed(() => this.currentStatus().text);
  readonly tone = computed(() => this.currentStatus().tone);

  readonly leaveLabel = computed(() => {
    const state = this.room.state();
    if (this.isHost() && state !== 'opening' && state !== 'idle') {
      return 'Close room';
    }
    return state === 'connected' ? 'Leave room' : 'Cancel';
  });

  constructor() {
    this.room.events$.subscribe((event) => this.handleRoomEvent(event));
    effect(() => {
      this.room.sendMediaState({
        mic: this.media.isMicEnabled(),
        cam: this.media.isCamEnabled(),
        screen: this.media.isSharingScreen()
      });
    });
    // Two people may press "Share screen" at the same moment. Both see the clash and
    // the one with the greater ID backs off, so exactly one share survives.
    effect(() => {
      const other = this.screenSharer();
      const myId = this.room.myPeerId();
      if (other && myId && other.id < myId && this.media.isSharingScreen()) {
        untracked(() => {
          this.stopScreenShare();
          this.notify(`${other.name()} started sharing their screen first.`);
        });
      }
    });
    // Sharing needs someone to watch it.
    effect(() => {
      if (this.participants().length === 0 && this.media.isSharingScreen()) {
        untracked(() => this.stopScreenShare());
      }
    });
  }

  setName(name: string): void {
    const value = name.slice(0, MAX_NAME_LENGTH);
    this.name.set(value);
    try {
      localStorage.setItem(NAME_STORAGE_KEY, value.trim());
    } catch {
      // The name just won't survive a reload.
    }
  }

  createRoom(roomId: string): Promise<void> {
    return this.start(async (stream) => {
      await this.room.createRoom(stream, this.name(), roomId);
      this.audio.play('notification');
    });
  }

  joinRoom(roomId: string): Promise<void> {
    return this.start((stream) => this.room.joinRoom(roomId, stream, this.name()));
  }

  leave(): void {
    this.audio.play('click');
    const wasActive = this.room.state() !== 'idle';
    this.operationId += 1;
    this.isBusy.set(false);
    this.room.disconnect();
    this.media.release();
    this.notice.set(null);
    this.messages.set([]);
    if (wasActive) {
      this.audio.play('disconnected');
    }
  }

  sendMessage(text: string): boolean {
    const message = text.trim();
    if (!message || !this.room.sendMessage(message)) {
      return false;
    }
    this.audio.play('send-message');
    this.addMessage('me', message);
    return true;
  }

  /** Sharing needs someone in the room, and only one person can share at a time. */
  async toggleScreenShare(): Promise<void> {
    this.audio.play('click');
    if (this.media.isSharingScreen()) {
      this.stopScreenShare();
      return;
    }
    if (!this.isConnected() || this.screenSharer()) {
      return;
    }

    const track = await this.media.startScreenShare(() => this.sendCamera());
    if (track) {
      this.room.setOutgoingTrack('video', track);
    }
  }

  async switchDevice(kind: MediaKind, deviceId: string): Promise<void> {
    const result = await this.media.switchDevice(kind, deviceId);
    if (!result) {
      return;
    }
    // While sharing, the new camera just waits for the share to end.
    if (kind === 'audio' || !this.media.isSharingScreen()) {
      this.room.setOutgoingTrack(kind, result.track);
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

  private handleRoomEvent(event: RoomEvent): void {
    switch (event.type) {
      case 'entered':
        this.notice.set(null);
        this.addMessage('system', `You joined. In the room: ${event.names.join(', ')}`);
        this.audio.play('connected');
        break;
      case 'joined':
        this.notice.set(null);
        this.addMessage('system', `${event.name} joined`);
        this.audio.play('connected');
        break;
      case 'left':
        this.addMessage('system', `${event.name} left`);
        this.audio.play('disconnected');
        break;
      case 'room-closed':
        this.media.release();
        this.addMessage('system', 'The host closed the room');
        this.notify('The host closed the room.');
        this.audio.play('disconnected');
        break;
      case 'message':
        this.addMessage('peer', event.text, event.from);
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
    this.room.setOutgoingTrack('video', this.media.cameraTrack() ?? null);
  }

  private addMessage(author: ChatMessage['author'], text: string, name?: string): void {
    const message: ChatMessage = { id: this.nextMessageId++, author, name, text, at: new Date() };
    this.messages.update((items) => [...items, message]);
  }
}
