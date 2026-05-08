import { Injectable, signal, computed } from '@angular/core';
import { Subject } from 'rxjs';
import { throttleTime } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private sounds: Map<string, HTMLAudioElement> = new Map();
  private throttledPlay$ = new Subject<string>();

  // Сигнал для хранения состояния звука
  private isMutedSignal = signal<boolean>(false);
  
  // Публичный сигнал (readonly), чтобы компоненты могли только читать его
  readonly isMuted = this.isMutedSignal.asReadonly();

  constructor() {
    this.preloadSound('click', 'assets/sounds/mixkit-typewriter-soft-click-1125.wav');
    this.preloadSound('send-message', 'assets/sounds/mixkit-mouse-click-close-1113.wav');
    this.preloadSound('connected', 'assets/sounds/notification-sound.mp3');
    this.preloadSound('notification', 'assets/sounds/mixkit-arcade-game-jump-coin-216.wav');

    this.throttledPlay$.pipe(
      throttleTime(5000)
    ).subscribe(key => this.executePlay(key));
  }

  private preloadSound(key: string, path: string) {
    const audio = new Audio(path);
    audio.load();
    this.sounds.set(key, audio);
  }

  /**
   * Переключение звука через Signal update
   */
  toggleMute(): void {
    this.isMutedSignal.update(state => !state);
  }

  play(key: string) {
    this.executePlay(key);
  }

  playNotification(key: string) {
    this.throttledPlay$.next(key);
  }

  private executePlay(key: string) {
    // Проверяем значение сигнала
    if (this.isMutedSignal()) return;

    const audio = this.sounds.get(key);
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(err => console.warn(`Ошибка воспроизведения ${key}:`, err));
    }
  }
}
