import { Injectable, OnDestroy } from '@angular/core';

/** Loudness (RMS of the waveform) above which someone counts as speaking. */
const SPEAKING_LEVEL = 0.02;
/** Keeps the highlight through the short pauses between words. */
const HOLD_MS = 700;
const TICK_MS = 100;

interface Watcher {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  lastLoudAt: number;
  isSpeaking: boolean;
  onChange: (isSpeaking: boolean) => void;
}

/** Tells who is speaking by measuring audio levels. One audio context and one timer serve every stream. */
@Injectable({ providedIn: 'root' })
export class SpeechDetectorService implements OnDestroy {
  private context?: AudioContext;
  private timer?: number;
  private readonly watchers = new Set<Watcher>();

  /** Starts measuring a stream; returns the function that stops it. */
  watch(stream: MediaStream, onChange: (isSpeaking: boolean) => void): () => void {
    const context = this.getContext();
    if (!context || stream.getAudioTracks().length === 0) {
      return () => {};
    }
    // Suspended until the page had a user gesture, which joining a room always is.
    context.resume().catch(() => {});

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const watcher: Watcher = {
      source,
      analyser,
      samples: new Float32Array(analyser.fftSize),
      lastLoudAt: 0,
      isSpeaking: false,
      onChange
    };
    this.watchers.add(watcher);
    this.timer ??= window.setInterval(() => this.measure(), TICK_MS);

    return () => {
      this.watchers.delete(watcher);
      source.disconnect();
      if (this.watchers.size === 0) {
        window.clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  ngOnDestroy(): void {
    window.clearInterval(this.timer);
    this.watchers.forEach((watcher) => watcher.source.disconnect());
    this.watchers.clear();
    this.context?.close().catch(() => {});
  }

  private getContext(): AudioContext | undefined {
    if (!this.context && typeof AudioContext !== 'undefined') {
      this.context = new AudioContext();
    }
    return this.context;
  }

  private measure(): void {
    const now = performance.now();
    for (const watcher of this.watchers) {
      watcher.analyser.getFloatTimeDomainData(watcher.samples);
      let sum = 0;
      for (const sample of watcher.samples) {
        sum += sample * sample;
      }
      if (Math.sqrt(sum / watcher.samples.length) > SPEAKING_LEVEL) {
        watcher.lastLoudAt = now;
      }
      const isSpeaking = watcher.lastLoudAt > 0 && now - watcher.lastLoudAt < HOLD_MS;
      if (isSpeaking !== watcher.isSpeaking) {
        watcher.isSpeaking = isSpeaking;
        watcher.onChange(isSpeaking);
      }
    }
  }
}
