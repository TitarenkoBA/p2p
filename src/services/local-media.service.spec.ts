import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { LocalMediaService } from './local-media.service';

class FakeTrack {
  enabled = true;
  stop = vi.fn();
  addEventListener = vi.fn();
  constructor(
    readonly kind: string,
    private readonly deviceId = 'default'
  ) {}
  getSettings = () => ({ deviceId: this.deviceId });
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks.filter((track) => track.kind === 'audio');
  getVideoTracks = () => this.tracks.filter((track) => track.kind === 'video');
}

describe('LocalMediaService', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let service: LocalMediaService;

  beforeEach(() => {
    getUserMedia = vi.fn();
    vi.stubGlobal('MediaStream', FakeStream);
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service = TestBed.inject(LocalMediaService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps tracks disabled until the user turns them on', async () => {
    const mic = new FakeTrack('audio');
    const cam = new FakeTrack('video');
    getUserMedia.mockResolvedValue(new FakeStream([mic, cam]));

    await service.acquire();
    expect(mic.enabled).toBe(false);
    expect(cam.enabled).toBe(false);

    service.setMicEnabled(true);
    expect(mic.enabled).toBe(true);
    expect(cam.enabled).toBe(false);
    expect(service.isMicEnabled()).toBe(true);
  });

  it('falls back to camera only when there is no microphone', async () => {
    const cam = new FakeTrack('video');
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) {
        throw new Error('no mic');
      }
      return new FakeStream([cam]);
    });

    await service.acquire();
    expect(service.hasCam()).toBe(true);
    expect(service.hasMic()).toBe(false);
    expect(service.notice()).toContain('Video only');
  });

  it('falls back to chat only when every attempt fails', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'));

    await service.acquire();
    expect(service.hasCam()).toBe(false);
    expect(service.hasMic()).toBe(false);
    expect(service.notice()).toContain('Chat only');
  });

  it('stops tracks on release', async () => {
    const mic = new FakeTrack('audio');
    getUserMedia.mockResolvedValue(new FakeStream([mic]));

    await service.acquire();
    service.release();
    expect(mic.stop).toHaveBeenCalled();
    expect(service.stream()).toBeUndefined();
  });

  it('stops a stream that arrives after release', async () => {
    const mic = new FakeTrack('audio');
    let grant!: (stream: FakeStream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => (grant = resolve)));

    const acquiring = service.acquire();
    service.release();
    grant(new FakeStream([mic]));
    await acquiring;

    expect(mic.stop).toHaveBeenCalled();
    expect(service.stream()).toBeUndefined();
  });

  it('opens the saved camera and falls back when it is gone', async () => {
    localStorage.setItem('p2p.device.camera', 'cam-2');
    const cam = new FakeTrack('video', 'cam-1');
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      const video = constraints.video as MediaTrackConstraints;
      if ((video.deviceId as ConstrainDOMStringParameters | undefined)?.exact === 'cam-2') {
        throw new DOMException('gone', 'OverconstrainedError');
      }
      return new FakeStream([cam]);
    });

    await service.acquire();
    localStorage.removeItem('p2p.device.camera');

    expect((getUserMedia.mock.calls[0][0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'cam-2' });
    expect(service.cameraId()).toBe('cam-1');
  });

  describe('switchDevice', () => {
    it('keeps the on/off state and stops the old track', async () => {
      const oldCam = new FakeTrack('video', 'cam-1');
      const newCam = new FakeTrack('video', 'cam-2');
      getUserMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack('audio'), oldCam]));
      await service.acquire();
      service.setCamEnabled(true);

      getUserMedia.mockResolvedValueOnce(new FakeStream([newCam]));
      const result = await service.switchDevice('video', 'cam-2');

      expect(result).toEqual({ track: newCam, ok: true });
      expect(oldCam.stop).toHaveBeenCalled();
      expect(newCam.enabled).toBe(true);
      expect(service.cameraId()).toBe('cam-2');
      expect(service.hasMic()).toBe(true);
    });

    it('falls back to the previous device when the new one fails', async () => {
      const restored = new FakeTrack('video', 'cam-1');
      getUserMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack('video', 'cam-1')]));
      await service.acquire();

      getUserMedia.mockRejectedValueOnce(new Error('busy'));
      getUserMedia.mockResolvedValueOnce(new FakeStream([restored]));
      const result = await service.switchDevice('video', 'cam-2');

      expect(result).toEqual({ track: restored, ok: false });
      expect(service.hasCam()).toBe(true);
    });

    it('drops the track when no device can be opened', async () => {
      getUserMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack('video', 'cam-1')]));
      await service.acquire();
      service.setCamEnabled(true);

      getUserMedia.mockRejectedValue(new Error('gone'));
      const result = await service.switchDevice('video', 'cam-2');

      expect(result).toEqual({ track: null, ok: false });
      expect(service.hasCam()).toBe(false);
      expect(service.isCamEnabled()).toBe(false);
    });

    it('stops a track that arrives after release', async () => {
      const late = new FakeTrack('video', 'cam-2');
      let grant!: (stream: FakeStream) => void;
      getUserMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack('video', 'cam-1')]));
      await service.acquire();

      getUserMedia.mockReturnValueOnce(new Promise((resolve) => (grant = resolve)));
      const switching = service.switchDevice('video', 'cam-2');
      service.release();
      grant(new FakeStream([late]));

      expect(await switching).toBeNull();
      expect(late.stop).toHaveBeenCalled();
    });
  });

  describe('screen sharing', () => {
    let getDisplayMedia: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getDisplayMedia = vi.fn();
      (navigator.mediaDevices as unknown as { getDisplayMedia: unknown }).getDisplayMedia = getDisplayMedia;
    });

    it('treats a cancelled picker as no share', async () => {
      getDisplayMedia.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
      expect(await service.startScreenShare(vi.fn())).toBeNull();
      expect(service.isSharingScreen()).toBe(false);
    });

    it('stops sharing when the browser ends the capture', async () => {
      const screen = new FakeTrack('video');
      const onEnded = vi.fn();
      getDisplayMedia.mockResolvedValue(new FakeStream([screen]));

      expect(await service.startScreenShare(onEnded)).toBe(screen);
      expect(service.isSharingScreen()).toBe(true);

      screen.addEventListener.mock.calls[0][1]();
      expect(service.isSharingScreen()).toBe(false);
      expect(onEnded).toHaveBeenCalled();
    });

    it('stops a capture that arrives after the share was stopped', async () => {
      const screen = new FakeTrack('video');
      let grant!: (stream: FakeStream) => void;
      getDisplayMedia.mockReturnValue(new Promise((resolve) => (grant = resolve)));

      const starting = service.startScreenShare(vi.fn());
      service.stopScreenShare();
      grant(new FakeStream([screen]));

      expect(await starting).toBeNull();
      expect(screen.stop).toHaveBeenCalled();
    });
  });
});
