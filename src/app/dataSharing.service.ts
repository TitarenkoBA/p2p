import { inject, Injectable, NgZone } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ShortenerService {
  private readonly workerUrl = 'https://link-shortener.zik2009.workers.dev/';
  private readonly zone = inject(NgZone);

  async createLink(longString: string): Promise<string> {
    const id = await this.zone.runOutsideAngular(() =>
      this.requestWithHardTimeout(this.workerUrl, 5000, 'POST', longString)
    );
    return `link-${id}`;
  }

  async getData(fullUrl: string): Promise<string> {
    if (fullUrl.startsWith('link-')) {
      fullUrl = `${this.workerUrl}${fullUrl.slice(5)}`;
      console.log(fullUrl);
    }
    return await this.zone.runOutsideAngular(() =>
      this.requestWithHardTimeout(fullUrl, 5000)
    );
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
