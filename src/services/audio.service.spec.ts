import { TestBed } from '@angular/core/testing';
import { AudioService } from './audio.service';

describe('AudioService', () => {
  beforeEach(() => localStorage.clear());

  it('restores a stored volume of 0 instead of the default', () => {
    localStorage.setItem('audio_volume', '0');
    expect(TestBed.inject(AudioService).volume()).toBe(0);
  });

  it('falls back to the defaults for missing or broken values', () => {
    localStorage.setItem('audio_volume', 'oops');
    const service = TestBed.inject(AudioService);
    expect(service.volume()).toBe(0.2);
    expect(service.remoteVolume()).toBe(1);
  });

  it('clamps volumes to the 0..1 range', () => {
    const service = TestBed.inject(AudioService);
    service.setVolume(5);
    service.setRemoteVolume(-1);
    expect(service.volume()).toBe(1);
    expect(service.remoteVolume()).toBe(0);
  });
});
