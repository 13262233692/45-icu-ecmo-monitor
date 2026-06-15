import { EcmoWsClient, ChannelMeta, StaticChunkInfo, ConnectionStatus } from './wsClient';
import { NumericRingBuffer } from './ringBuffer';
import {
  PanTompkinsThrombusDetector,
  ThrombusEvent,
  ThrombusAlertLevel,
} from './thrombusDetector';

export interface StreamStats {
  fps: number;
  totalFrames: number;
  lastFrameTime: number;
}

export type { ConnectionStatus, ChannelMeta, ThrombusEvent };
export { ThrombusAlertLevel };

const TMP_CHANNEL_INDEX = 3;

export class EcmoStreamStateMachine {
  private ws: EcmoWsClient;
  private channelMeta: ChannelMeta[] | null = null;
  private buffers: NumericRingBuffer[] = [];
  private latestValues: Float32Array = new Float32Array(16);
  private minValues: Float32Array = new Float32Array(16);
  private maxValues: Float32Array = new Float32Array(16);
  private initialized = false;

  private thrombusDetector: PanTompkinsThrombusDetector | null = null;
  private lastThrombusTick = 0;

  private metaListeners = new Set<(meta: ChannelMeta[]) => void>();
  private dataListeners = new Set<(newSamples: number) => void>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private statsListeners = new Set<(stats: StreamStats) => void>();
  private thrombusListeners = new Set<(ev: ThrombusEvent) => void>();
  private clampListeners = new Set<(ev: ThrombusEvent) => void>();

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
      if (this.buffers.length < chCount) {
        const newBufs: NumericRingBuffer[] = new Array(chCount);
        for (let i = 0; i < chCount; i++) {
          newBufs[i] = i < this.buffers.length ? this.buffers[i] : new NumericRingBuffer(bufferSize);
        }
        this.buffers = newBufs;
      }
      if (this.latestValues.length < chCount) {
        this.latestValues = new Float32Array(Math.max(16, chCount));
        this.minValues = new Float32Array(Math.max(16, chCount));
        this.maxValues = new Float32Array(Math.max(16, chCount));
      }
      for (let i = 0; i < chCount; i++) {
        this.minValues[i] = meta[i].min;
        this.maxValues[i] = meta[i].max;
      }

      if (TMP_CHANNEL_INDEX < chCount) {
        const tmpMeta = meta[TMP_CHANNEL_INDEX];
        this.thrombusDetector = new PanTompkinsThrombusDetector({
          sampleRate: this.ws.getSampleRate() || 500,
          tmpMin: tmpMeta.min,
          tmpMax: tmpMeta.max,
          tmpRedLine: tmpMeta.max * 0.8,
        });
        this.thrombusDetector.onAlert((ev) => {
          this.lastThrombusTick++;
          this.thrombusListeners.forEach(fn => {
            try { fn(ev); } catch (e) { console.error(e); }
          });
        });
        this.thrombusDetector.onClamp((ev) => {
          this.clampListeners.forEach(fn => {
            try { fn(ev); } catch (e) { console.error(e); }
          });
        });
      }

      this.initialized = true;
      this.metaListeners.forEach(fn => {
        try { fn(meta); } catch (e) { console.error(e); }
      });
    });

    this.ws.onRawChunk((_info: StaticChunkInfo) => {
      this.processChunkRaw(_info.frameCount);
    });

    this.ws.onStatus((s) => {
      this.statusListeners.forEach(fn => {
        try { fn(s); } catch (e) { console.error(e); }
      });
    });

    this.ws.onStats((fps: number, total: number) => {
      this.stats.fps = fps;
      this.stats.totalFrames = total;
      this.stats.lastFrameTime = performance.now();
      this.statsListeners.forEach(fn => {
        try { fn(this.stats); } catch (e) { console.error(e); }
      });
    });
  }

  private processChunkRaw(newSamples: number) {
    if (!this.initialized) return;
    const channelCount = this.ws.getChannelCount();
    const latest = this.ws.getLatestScratch();
    const n = Math.min(channelCount, this.buffers.length);
    for (let c = 0; c < n; c++) {
      const lastVal = this.ws.writeChannelToRing(c, this.buffers[c]);
      this.latestValues[c] = lastVal !== 0 ? lastVal : latest[c];
    }

    if (this.thrombusDetector && TMP_CHANNEL_INDEX < n) {
      const tmpBuf = this.buffers[TMP_CHANNEL_INDEX];
      if (tmpBuf) {
        this.thrombusDetector.pushFromRing(tmpBuf, newSamples);
      }
    }

    this.dataListeners.forEach(fn => {
      try { fn(newSamples); } catch (e) { console.error(e); }
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
    return this.channelMeta ? this.channelMeta.length : 0;
  }

  getChannelMeta(): ChannelMeta[] | null {
    return this.channelMeta;
  }

  getChannelBuffer(index: number): NumericRingBuffer | null {
    return this.buffers[index] || null;
  }

  getLatestValue(index: number): number {
    return this.latestValues[index] || 0;
  }

  getLatestValues(): Float32Array {
    return this.latestValues;
  }

  getChannelMin(index: number): number {
    return this.minValues[index] || 0;
  }

  getChannelMax(index: number): number {
    return this.maxValues[index] || 0;
  }

  getStats(): StreamStats {
    return this.stats;
  }

  onMetadata(fn: (meta: ChannelMeta[]) => void) {
    this.metaListeners.add(fn);
    if (this.channelMeta) {
      try { fn(this.channelMeta); } catch (e) { console.error(e); }
    }
    return () => this.metaListeners.delete(fn);
  }

  onData(fn: (newSamples: number) => void) {
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

  getThrombusLevel(): ThrombusAlertLevel {
    return this.thrombusDetector
      ? this.thrombusDetector.getCurrentLevel()
      : ThrombusAlertLevel.NORMAL;
  }

  getThrombusTick(): number {
    return this.lastThrombusTick;
  }

  getThrombusDetector(): PanTompkinsThrombusDetector | null {
    return this.thrombusDetector;
  }

  onThrombusAlert(fn: (ev: ThrombusEvent) => void) {
    this.thrombusListeners.add(fn);
    return () => this.thrombusListeners.delete(fn);
  }

  onThrombusClamp(fn: (ev: ThrombusEvent) => void) {
    this.clampListeners.add(fn);
    return () => this.clampListeners.delete(fn);
  }

  triggerThrombusTest(pressure: number): void {
    if (this.thrombusDetector) {
      for (let i = 0; i < 50; i++) {
        this.thrombusDetector.pushSample(pressure);
      }
    }
  }
}
