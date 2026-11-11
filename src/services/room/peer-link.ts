import { signal } from '@angular/core';
import { DataConnection, MediaConnection } from 'peerjs';
import { MEDIA_OFF, PeerMediaState } from './protocol';

const CONNECT_TIMEOUT_MS = 20000;

export type LinkStatus = 'connecting' | 'connected' | 'failed';

export interface LinkHandlers {
  open(link: PeerLink): void;
  data(link: PeerLink, data: unknown): void;
  /** The data channel closed: the participant is gone. Fires once. */
  closed(link: PeerLink): void;
  /** The data channel did not open in time. */
  failed(link: PeerLink): void;
  stream(link: PeerLink): void;
  error(link: PeerLink, message: string): void;
}

/** Everything about one other participant: their data channel, their call and what they send. */
export class PeerLink {
  readonly name = signal('');
  readonly status = signal<LinkStatus>('connecting');
  readonly media = signal<PeerMediaState>(MEDIA_OFF);
  readonly video = signal<MediaStream | undefined>(undefined);
  readonly audio = signal<MediaStream | undefined>(undefined);

  /** Whether the host vouched for this participant. Until then their messages are held back. */
  admitted = false;
  readonly held: unknown[] = [];

  private data?: DataConnection;
  private call?: MediaConnection;
  private isClosed = false;
  private readonly timer: number;

  constructor(
    readonly id: string,
    readonly isHost: boolean,
    private readonly handlers: LinkHandlers
  ) {
    this.timer = window.setTimeout(() => {
      if (!this.isClosed && this.status() === 'connecting') {
        this.status.set('failed');
        this.handlers.failed(this);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  get isOpen(): boolean {
    return !this.isClosed && !!this.data?.open;
  }

  get hasCall(): boolean {
    return !!this.call;
  }

  get peerConnection(): RTCPeerConnection | undefined {
    return this.call?.peerConnection;
  }

  /** False if this participant already has a data channel; the duplicate is closed. */
  attachData(conn: DataConnection): boolean {
    if (this.data || this.isClosed) {
      conn.close();
      return false;
    }
    this.data = conn;

    const onOpen = (): void => {
      if (this.data !== conn || this.isClosed) {
        return;
      }
      window.clearTimeout(this.timer);
      this.status.set('connected');
      this.handlers.open(this);
    };
    conn.on('open', onOpen);
    conn.on('data', (data) => {
      if (this.data === conn && !this.isClosed) {
        this.handlers.data(this, data);
      }
    });
    conn.on('close', () => {
      if (this.data === conn) {
        this.close();
      }
    });
    conn.on('error', (err) => {
      if (this.data === conn && !this.isClosed) {
        this.handlers.error(this, `Data channel error: ${err.message}`);
      }
    });
    // An incoming channel may have opened before anyone listened.
    if (conn.open) {
      queueMicrotask(onOpen);
    }
    return true;
  }

  /** An incoming call stays unanswered until `answer()`, an outgoing one is live already. */
  attachCall(call: MediaConnection): boolean {
    if (this.call || this.isClosed) {
      call.close();
      return false;
    }
    this.call = call;

    call.on('stream', (stream) => {
      if (this.call === call && stream) {
        this.applyRemoteStream(stream);
        this.handlers.stream(this);
      }
    });
    call.on('close', () => {
      if (this.call === call) {
        this.call = undefined;
        this.video.set(undefined);
        this.audio.set(undefined);
      }
    });
    call.on('error', (err) => {
      if (this.call === call && !this.isClosed) {
        this.handlers.error(this, `Media error: ${err.message}`);
      }
    });
    return true;
  }

  answer(stream: MediaStream): void {
    if (this.call && !this.call.open) {
      this.call.answer(stream);
    }
  }

  send(message: unknown): boolean {
    if (!this.isOpen) {
      return false;
    }
    this.data?.send(message);
    return true;
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    window.clearTimeout(this.timer);
    const { data, call } = this;
    this.data = undefined;
    this.call = undefined;
    data?.close();
    call?.close();
    this.video.set(undefined);
    this.audio.set(undefined);
    this.media.set(MEDIA_OFF);
    this.handlers.closed(this);
  }

  private applyRemoteStream(stream: MediaStream): void {
    // PeerJS may report the same stream once per track, so keep whatever has arrived so far.
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    if (videoTracks.length > 0) {
      this.video.set(new MediaStream(videoTracks));
    }
    if (audioTracks.length > 0) {
      this.audio.set(new MediaStream(audioTracks));
    }
  }
}
