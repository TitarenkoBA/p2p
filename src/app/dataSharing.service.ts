import { inject, Injectable, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ShortenerService {
  private readonly workerUrl = 'https://link-shortener.zik2009.workers.dev/';
  private readonly zone = inject(NgZone);

  async createLink(longString: string): Promise<string> {
    const id = await this.zone.runOutsideAngular(() =>
      this.withProxyRetry((url) => this.requestWithHardTimeout(url, 5000, 'POST', longString))
    );
    return `${this.workerUrl}${id}`;
  }

  async getData(fullUrl: string): Promise<string> {
    return await this.zone.runOutsideAngular(() =>
      this.withProxyRetry((url) => this.requestWithHardTimeout(url, 5000))
    );
  }

  private async withProxyRetry(requestFn: (url: string) => Promise<string>): Promise<string> {
    try {
      return await requestFn(this.workerUrl);
    } catch (e) {
      console.warn('Первая попытка не удалась, идем в прокси...', e);
      const proxyUrl = `https://corsproxy.io?${encodeURIComponent(this.workerUrl)}`;
      return await requestFn(proxyUrl);
    }
  }

  private async requestWithHardTimeout(
    url: string, 
    ms: number, 
    method: 'GET' | 'POST' = 'GET', 
    body?: string
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);

    try {
      const response = await fetch(url, {
        method,
        body,
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`FETCH_ERROR: ${response.status}`);
      return await response.text();
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('HARD_TIMEOUT');
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
