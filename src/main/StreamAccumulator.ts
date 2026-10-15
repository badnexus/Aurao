/**
 * StreamAccumulator - Buffers high-frequency streaming chunks and emits them in batches
 * every 50ms-100ms (or on threshold) to prevent IPC flooding in Electron.
 */
export class StreamAccumulator {
  private buffer: string[] = [];
  private bufferLength = 0;
  private timer: NodeJS.Timeout | null = null;
  private isDisposed = false;

  constructor(
    private readonly onFlush: (batchedChunk: string) => void,
    private readonly debounceMs = 60,
    private readonly maxBufferSize = 4096,
  ) {}

  /**
   * Adds a new chunk of string data to the accumulator.
   */
  add(chunk: string): void {
    if (this.isDisposed || !chunk) return;

    this.buffer.push(chunk);
    this.bufferLength += chunk.length;

    if (this.bufferLength >= this.maxBufferSize) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  /**
   * Immediately flushes any buffered chunks.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const combined = this.buffer.join('');
    this.buffer = [];
    this.bufferLength = 0;

    if (combined) {
      this.onFlush(combined);
    }
  }

  /**
   * Flushes remaining data and cleans up timers.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.flush();
    this.isDisposed = true;
  }
}
