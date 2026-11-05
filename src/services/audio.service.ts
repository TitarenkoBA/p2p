import { Injectable, signal, effect } from '@angular/core';
import { Subject } from 'rxjs';
import { throttleTime } from 'rxjs/operators';

const STORAGE_KEYS = {
  VOLUME: 'audio_volume',
  REMOTE_VOLUME: 'audio_remote_volume',
  MUTED: 'audio_muted'
};

const DEFAULT_VOLUME = 0.2;
const DEFAULT_REMOTE_VOLUME = 1;

export type SoundKey = 'click' | 'send-message' | 'connected' | 'disconnected' | 'notification';

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// 0 — допустимая громкость, поэтому пустое и битое значение проверяем явно
function readStoredVolume(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  const value = stored === null ? NaN : Number(stored);
  return Number.isFinite(value) ? clampVolume(value) : fallback;
}

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private sounds: Map<SoundKey, HTMLAudioElement> = new Map();
  private throttledPlay$ = new Subject<SoundKey>();

  // Загружаем начальные значения из localStorage
  private isMutedSignal = signal<boolean>(localStorage.getItem(STORAGE_KEYS.MUTED) === 'true');
  readonly isMuted = this.isMutedSignal.asReadonly();

  private volumeSignal = signal<number>(readStoredVolume(STORAGE_KEYS.VOLUME, DEFAULT_VOLUME));
  readonly volume = this.volumeSignal.asReadonly();

  private remoteVolumeSignal = signal<number>(readStoredVolume(STORAGE_KEYS.REMOTE_VOLUME, DEFAULT_REMOTE_VOLUME));
  readonly remoteVolume = this.remoteVolumeSignal.asReadonly();

  constructor() {
    this.preloadSounds();

    // Эффект для автоматического сохранения изменений в localStorage
    effect(() => {
      const vol = this.volumeSignal();
      const remoteVol = this.remoteVolumeSignal();
      const muted = this.isMutedSignal();

      localStorage.setItem(STORAGE_KEYS.VOLUME, vol.toString());
      localStorage.setItem(STORAGE_KEYS.REMOTE_VOLUME, remoteVol.toString());
      localStorage.setItem(STORAGE_KEYS.MUTED, muted.toString());

      // Синхронизируем громкость во всех загруженных аудио-объектах
      this.sounds.forEach(audio => audio.volume = vol);
    });

    this.throttledPlay$.pipe(throttleTime(5000)).subscribe(key => this.executePlay(key));
  }

  private preloadSounds() {
    const assets: { key: SoundKey; path: string }[] = [
      { key: 'click', path: 'assets/sounds/mixkit-typewriter-soft-click-1125.wav' },
      { key: 'send-message', path: 'assets/sounds/mixkit-mouse-click-close-1113.wav' },
      { key: 'connected', path: 'assets/sounds/notification-sound.mp3' },
      { key: 'disconnected', path: 'assets/sounds/error-in-the-computer.mp3' },
      { key: 'notification', path: 'assets/sounds/mixkit-arcade-game-jump-coin-216.wav' }
    ];

    assets.forEach(asset => {
      const audio = new Audio(asset.path);
      audio.volume = this.volumeSignal(); // Установка громкости при инициализации
      audio.load();
      this.sounds.set(asset.key, audio);
    });
  }

  setVolume(value: number): void {
    this.volumeSignal.set(clampVolume(value));
  }

  setRemoteVolume(value: number): void {
    this.remoteVolumeSignal.set(clampVolume(value));
  }

  toggleMute(): void {
    this.isMutedSignal.update(state => !state);
  }

  play(key: SoundKey) {
    this.executePlay(key);
  }

  playNotification(key: SoundKey) {
    this.throttledPlay$.next(key);
  }

  private executePlay(key: SoundKey) {
    if (this.isMutedSignal()) return;

    const audio = this.sounds.get(key);
    if (audio) {
      audio.currentTime = 0;
      audio.volume = this.volumeSignal();
      audio.play().catch(err => console.warn(`Ошибка воспроизведения ${key}:`, err));
    }
  }
}
