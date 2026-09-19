import type { ServerResponse } from 'node:http';

/**
 * Server-sent events, hand-rolled.
 *
 * Deliberately does not use sendJson: that helper always sets Content-Length
 * and ends the response, which is the opposite of a stream.
 *
 * Every open stream is tracked, because an open response keeps its socket alive
 * and server.close() would otherwise never call back — Ctrl-C would appear to
 * hang, and so would the test suite.
 */
export class SseHub {
  private readonly open = new Set<ServerResponse>();

  get size(): number {
    return this.open.size;
  }

  add(res: ServerResponse, options: { retryMs?: number; heartbeatMs?: number } = {}): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Tells a reverse proxy not to buffer the stream into uselessness.
      'X-Accel-Buffering': 'no',
    });

    // The browser's own reconnect delay; EventSource handles retrying itself.
    res.write(`retry: ${options.retryMs ?? 3000}\n\n`);
    res.write(': connected\n\n');

    this.open.add(res);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, options.heartbeatMs ?? 15_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.open.delete(res);
    };

    res.on('close', cleanup);
    return cleanup;
  }

  /** `id:` lets the browser send Last-Event-ID so a reconnect can replay. */
  send(res: ServerResponse, event: { seq: number; type: string; data: unknown }): void {
    if (res.writableEnded) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  closeAll(): void {
    for (const res of this.open) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.open.clear();
  }
}
