import { EcmoWsClient, ChannelMeta, DataChunk, ConnectionStatus } from './wsClient';
import { NumericRingBuffer } from './ringBuffer';

export interface StreamStats {
  fps: number;
  totalFrames: number;
  lastFrameTime: number;
}

export type { ConnectionStatus, ChannelMeta };

export class EcmoStreamStateMachine {
  private ws: EcmoWsClient;
  private channelMeta: ChannelMeta[] = [];
  private buffers: NumericRingBuffer[] = [];
  private latestValues: Float32Array = new Float32Array(12);
  private minValues: Float32Array = new Float32Array(12);
  private maxValues: Float32Array = new Float32Array(12);
  private initialized = false;

  private metaListeners = new Set<(meta: ChannelMeta[]) => void>();
  private dataListeners = new Set<() => void>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private statsListeners = new Set<(stats: StreamStats) => void>();

  private stats: StreamStats = {
    fps: 0,
    totalFrames: 0,
    lastFrameTime: 0,
  };

  static DEFAULT_BUFFER_SIZE = 60000;

  constructor(bufferSize: number = EcmoStreamStateMachine.DEFAULT_BUFFER_SIZE) {
    this.ws = new EcmoWsClient();
    this.setupListeners(bufferSize);
  }

  private setupListeners(bufferSize: number) {
    this.ws.onMetadata((meta) => {
      this.channelMeta = meta;
      const chCount = meta.length;
      this.buffers = new Array(chCount);
      for (let i = 0; i < chCount; i++) {
        this.buffers[i] = new NumericRingBuffer(bufferSize);
      }
      this.latestValues = new Float32Array(chCount);
      this.minValues = new Float32Array(chCount);
      this.maxValues = new Float32Array(chCount);
      for (let i = 0; i < chCount; i++) {
        this.minValues[i] = meta[i].min;
        this.maxValues[i] = meta[i].max;
      }
      this.initialized = true;
      this.metaListeners.forEach(fn => {
        try { fn(meta); } catch (e) { console.error(e); }
      });
    });

    this.ws.onDataChunk((chunk) => {
      this.processChunk(chunk);
    });

    this.ws.onStatus((s) => {
      this.statusListeners.forEach(fn => {
        try { fn(s); } catch (e) { console.error(e); }
      });
    });

    this.ws.onStats(({ fps, total }) => {
      this.stats.fps = fps;
      this.stats.totalFrames = total;
      this.stats.lastFrameTime = performance.now();
      this.statsListeners.forEach(fn => {
        try { fn(this.stats); } catch (e) { console.error(e); }
      });
    });
  }

  private processChunk(chunk: DataChunk) {
    if (!this.initialized) return;

    const { frameCount, channelCount, samples } = chunk;

    for (let c = 0; c < channelCount && c < this.buffers.length; c++) {
      const buf = this.buffers[c];
      const chData = samples[c];
      if (chData.length === frameCount) {
        buf.pushAll(chData);
      } else {
        for (let f = 0; f < frameCount && f < chData.length; f++) {
          buf.push(chData[f]);
        }
      }
      if (frameCount > 0) {
        this.latestValues[c] = chData[frameCount - 1];
      }
    }

    this.dataListeners.forEach(fn => {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  start() {
    this.ws.connect();
  }

  stop() {
    this.ws.disconnect();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getStatus(): ConnectionStatus {
    return this.ws.getStatus();
  }

  getChannelCount(): number {
    return this.channelMeta.length;
  }

  getChannelMeta(): ChannelMeta[] {
    return this.channelMeta.slice();
  }

  getChannelBuffer(index: number): NumericRingBuffer | null {
    return this.buffers[index] || null;
  }

  getLatestValue(index: number): number {
    return this.latestValues[index] || 0;
  }

  getLatestValues(): Float32Array {
    return new Float32Array(this.latestValues);
  }

  getChannelMin(index: number): number {
    return this.minValues[index] || 0;
  }

  getChannelMax(index: number): number {
    return this.maxValues[index] || 0;
  }

  getStats(): StreamStats {
    return { ...this.stats };
  }

  onMetadata(fn: (meta: ChannelMeta[]) => void) {
    this.metaListeners.add(fn);
    if (this.channelMeta.length > 0) {
      try { fn(this.channelMeta); } catch (e) { console.error(e); }
    }
    return () => this.metaListeners.delete(fn);
  }

  onData(fn: () => void) {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  onStatus(fn: (s: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    try { fn(this.getStatus()); } catch (e) { console.error(e); }
    return () => this.statusListeners.delete(fn);
  }

  onStats(fn: (stats: StreamStats) => void) {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }
}
