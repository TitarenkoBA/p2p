import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type MediaKind = 'audio' | 'video';

/** Result of a device switch. `track` is what should be sent now, `ok` is false if the requested device failed. */
export interface DeviceSwitchResult {
  track: MediaStreamTrack | null;
  ok: boolean;
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

const CAM_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'user' },
  width: { ideal: 1280 },
  height: { ideal: 720 }
};

const DEVICE_STORAGE_KEYS: Record<MediaDeviceKind, string> = {
  audioinput: 'p2p.device.mic',
  videoinput: 'p2p.device.camera',
  audiooutput: 'p2p.device.speaker'
};

function readStoredDevice(kind: MediaDeviceKind): string {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEYS[kind]) ?? '';
  } catch {
    return '';
  }
}

function storeDevice(kind: MediaDeviceKind, deviceId: string): void {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEYS[kind], deviceId);
  } catch {
    // The choice just won't survive a reload.
  }
}

function trackOf(stream: MediaStream | undefined, kind: MediaKind): MediaStreamTrack | undefined {
  return (kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks())?.[0];
}

/** Owns the local camera, microphone and screen capture: tracks stay disabled until the user turns them on. */
@Injectable({ providedIn: 'root' })
export class LocalMediaService {
  private acquireId = 0;
  private screenShareId = 0;
  private readonly refreshOnDeviceChange = (): Promise<void> => this.refreshDevices();
  private readonly devices = signal<MediaDeviceInfo[]>([]);

  readonly stream = signal<MediaStream | undefined>(undefined);
  readonly screenStream = signal<MediaStream | undefined>(undefined);
  readonly isMicEnabled = signal(false);
  readonly isCamEnabled = signal(false);
  readonly isSwitchingDevice = signal(false);
  readonly speakerId = signal(readStoredDevice('audiooutput'));
  readonly canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  readonly canChooseSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  readonly hasMic = computed(() => !!trackOf(this.stream(), 'audio'));
  readonly hasCam = computed(() => !!trackOf(this.stream(), 'video'));
  readonly isSharingScreen = computed(() => !!this.screenStream());
  /** What the self-view shows, which is also what the peer receives. */
  readonly previewStream = computed(() => this.screenStream() ?? this.stream());
  readonly microphones = computed(() => this.devices().filter((device) => device.kind === 'audioinput'));
  readonly cameras = computed(() => this.devices().filter((device) => device.kind === 'videoinput'));
  readonly speakers = computed(() => this.devices().filter((device) => device.kind === 'audiooutput'));
  readonly microphoneId = computed(() => trackOf(this.stream(), 'audio')?.getSettings().deviceId ?? '');
  readonly cameraId = computed(() => trackOf(this.stream(), 'video')?.getSettings().deviceId ?? '');
  readonly notice = computed(() => {
    if (!this.stream() || (this.hasMic() && this.hasCam())) {
      return null;
    }
    if (this.hasMic()) {
      return 'Audio only: no access to the camera.';
    }
    if (this.hasCam()) {
      return 'Video only: no access to the microphone.';
    }
    return window.isSecureContext
      ? 'Chat only: no access to the camera or microphone. You can still see and hear your peer.'
      : 'Chat only: camera and microphone require HTTPS or localhost.';
  });

  constructor() {
    navigator.mediaDevices?.addEventListener?.('devicechange', this.refreshOnDeviceChange);
    inject(DestroyRef).onDestroy(() => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', this.refreshOnDeviceChange);
    });
  }

  async acquire(): Promise<MediaStream> {
    const current = this.stream();
    if (current) {
      return current;
    }

    const id = ++this.acquireId;
    const stream = await this.requestStream();
    if (id !== this.acquireId) {
      // Released while the permission prompt was open.
      stream.getTracks().forEach((track) => track.stop());
      return new MediaStream();
    }

    stream.getTracks().forEach((track) => (track.enabled = false));
    this.stream.set(stream);
    // Device names are only exposed once permission has been granted.
    void this.refreshDevices();
    return stream;
  }

  cameraTrack(): MediaStreamTrack | undefined {
    return trackOf(this.stream(), 'video');
  }

  setMicEnabled(enabled: boolean): void {
    this.stream()?.getAudioTracks().forEach((track) => (track.enabled = enabled));
    this.isMicEnabled.set(enabled && this.hasMic());
  }

  setCamEnabled(enabled: boolean): void {
    this.stream()?.getVideoTracks().forEach((track) => (track.enabled = enabled));
    this.isCamEnabled.set(enabled && this.hasCam());
  }

  /**
   * Replaces the microphone or camera, keeping its on/off state. Falls back to the previous
   * device if the new one fails. Resolves to null if the media was released in the meantime.
   */
  async switchDevice(kind: MediaKind, deviceId: string): Promise<DeviceSwitchResult | null> {
    const stream = this.stream();
    if (!stream) {
      return null;
    }

    const id = ++this.acquireId;
    const current = trackOf(stream, kind);
    const previousId = current?.getSettings().deviceId;
    const wasEnabled = current?.enabled ?? false;
    let track: MediaStreamTrack | null = null;
    let ok = true;

    this.isSwitchingDevice.set(true);
    // Phones often cannot open two cameras at once, so the old track has to go first.
    current?.stop();
    try {
      track = await this.requestTrack(kind, { exact: deviceId });
      storeDevice(kind === 'audio' ? 'audioinput' : 'videoinput', deviceId);
    } catch (error) {
      console.warn('Could not switch device', deviceId, error);
      ok = false;
      if (previousId) {
        // `ideal` alone may open any camera; it only matters if the previous one is gone too.
        track = await this.requestTrack(kind, { exact: previousId })
          .catch(() => this.requestTrack(kind, { ideal: previousId }))
          .catch(() => null);
      }
    }

    if (id !== this.acquireId) {
      track?.stop();
      return null;
    }

    this.isSwitchingDevice.set(false);
    const others = stream.getTracks().filter((item) => item.kind !== kind);
    if (track) {
      track.enabled = wasEnabled;
    }
    this.stream.set(new MediaStream(track ? [...others, track] : others));
    if (!track) {
      (kind === 'audio' ? this.isMicEnabled : this.isCamEnabled).set(false);
    }
    return { track, ok };
  }

  setSpeaker(deviceId: string): void {
    this.speakerId.set(deviceId);
    storeDevice('audiooutput', deviceId);
  }

  /** Resolves to the screen track, or null if the user cancelled the picker. */
  async startScreenShare(onEnded: () => void): Promise<MediaStreamTrack | null> {
    const id = ++this.screenShareId;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      console.warn('Screen capture was not started', error);
      return null;
    }

    const track = stream.getVideoTracks()[0];
    if (id !== this.screenShareId) {
      // The call ended while the picker was open.
      stream.getTracks().forEach((item) => item.stop());
      return null;
    }

    track.contentHint = 'detail';
    // Fires when the user presses the browser's own "Stop sharing" button.
    track.addEventListener('ended', () => {
      if (id === this.screenShareId) {
        this.stopScreenShare();
        onEnded();
      }
    });
    this.screenStream.set(stream);
    return track;
  }

  stopScreenShare(): void {
    this.screenShareId += 1;
    this.screenStream()?.getTracks().forEach((track) => track.stop());
    this.screenStream.set(undefined);
  }

  /** Stops the tracks, which also turns off the browser's camera indicator. */
  release(): void {
    this.acquireId += 1;
    this.stopScreenShare();
    this.stream()?.getTracks().forEach((track) => track.stop());
    this.stream.set(undefined);
    this.isMicEnabled.set(false);
    this.isCamEnabled.set(false);
    this.isSwitchingDevice.set(false);
  }

  private async refreshDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices.set(devices.filter((device) => device.deviceId));
    } catch (error) {
      console.warn('Could not list media devices', error);
    }
  }

  private async requestTrack(kind: MediaKind, deviceId: ConstrainDOMString): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'audio'
        ? { audio: { ...MIC_CONSTRAINTS, deviceId } }
        : { video: { width: CAM_CONSTRAINTS.width, height: CAM_CONSTRAINTS.height, deviceId } }
    );
    return trackOf(stream, kind) as MediaStreamTrack;
  }

  private buildStreamAttempts(): MediaStreamConstraints[] {
    const micId = readStoredDevice('audioinput');
    const camId = readStoredDevice('videoinput');
    const mic: MediaTrackConstraints = micId ? { ...MIC_CONSTRAINTS, deviceId: { exact: micId } } : MIC_CONSTRAINTS;
    const cam: MediaTrackConstraints = camId
      ? { width: CAM_CONSTRAINTS.width, height: CAM_CONSTRAINTS.height, deviceId: { exact: camId } }
      : CAM_CONSTRAINTS;
    // A saved device may be unplugged by now, so the plain request stays as the next attempt.
    const saved: MediaStreamConstraints[] = micId || camId ? [{ audio: mic, video: cam }] : [];

    return [
      ...saved,
      { audio: MIC_CONSTRAINTS, video: CAM_CONSTRAINTS },
      { audio: MIC_CONSTRAINTS, video: true },
      { audio: MIC_CONSTRAINTS, video: false },
      { audio: false, video: true }
    ];
  }

  private async requestStream(): Promise<MediaStream> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return new MediaStream();
    }

    for (const constraints of this.buildStreamAttempts()) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        console.warn('getUserMedia failed', constraints, error);
      }
    }
    return new MediaStream();
  }
}
