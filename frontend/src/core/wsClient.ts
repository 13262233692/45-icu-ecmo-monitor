import { NumericRingBuffer } from './ringBuffer';

export interface ChannelMeta {
  index: number;
  name: string;
  unit: string;
  min: number;
  max: number;
  color: string;
}

export interface StaticChunkInfo {
  firstTimestamp: number;
  lastSequence: number;
  frameCount: number;
  channelCount: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const CHUNK_MAGIC = 0x45434D30;
const META_MAGIC = 0x4D455441;
const MAX_CHANNELS = 16;
const SCRATCH_LATEST_LEN = MAX_CHANNELS;

export class EcmoWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private status: ConnectionStatus = 'disconnected';
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private metaListeners = new Set<(meta: ChannelMeta[]) => void>();
  private rawChunkListeners = new Set<(info: StaticChunkInfo) => void>();
  private statsListeners = new Set<(fps: number, total: number) => void>();
  private totalFrames = 0;
  private fpsFrames = 0;
  private fpsTimer: number | null = null;

  private channelMeta: ChannelMeta[] | null = null;
  private channelCount = 0;
  private sampleRate = 500;
  private staticLatestScratch: Float32Array = new Float32Array(SCRATCH_LATEST_LEN);

  private metaTextDecoder: TextDecoder | null = null;
  private metaNameBytes: Uint8Array = new Uint8Array(128);
  private metaUnitBytes: Uint8Array = new Uint8Array(64);

  private scratchChunkInfo: StaticChunkInfo = {
    firstTimestamp: 0,
    lastSequence: 0,
    frameCount: 0,
    channelCount: 0,
  };

  private lastChunkView: DataView | null = null;
  private lastChunkPayloadOffset = 0;
  private lastChunkFrameCount = 0;
  private lastChunkChannelCount = 0;
  private lastChunkPerFrameStep = 0;
  private lastChunkSampleBaseOffsets: Int32Array = new Int32Array(MAX_CHANNELS);

  constructor(url: string = 'ws://localhost:8080/ws/ecmo') {
    this.url = url;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        this.startFpsCounter();
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.stopFpsCounter();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus('error');
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.decodeBinaryStatic(event.data);
        }
      };
    } catch (e) {
      this.setStatus('error');
      this.scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
    this.stopFpsCounter();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getChannelCount(): number {
    return this.channelCount;
  }

  getMeta(): ChannelMeta[] | null {
    return this.channelMeta;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  getLatestScratch(): Float32Array {
    return this.staticLatestScratch;
  }

  onStatus(fn: (s: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onMetadata(fn: (meta: ChannelMeta[]) => void) {
    this.metaListeners.add(fn);
    if (this.channelMeta) {
      try { fn(this.channelMeta); } catch (e) { console.error(e); }
    }
    return () => this.metaListeners.delete(fn);
  }

  onRawChunk(fn: (info: StaticChunkInfo) => void) {
    this.rawChunkListeners.add(fn);
    return () => this.rawChunkListeners.delete(fn);
  }

  onStats(fn: (fps: number, total: number) => void) {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.statusListeners.forEach(fn => {
      try { fn(s); } catch (e) { console.error(e); }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 10000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startFpsCounter() {
    this.fpsFrames = 0;
    this.fpsTimer = window.setInterval(() => {
      const fps = this.fpsFrames;
      this.fpsFrames = 0;
      this.statsListeners.forEach(fn => {
        try { fn(fps, this.totalFrames); } catch (e) { console.error(e); }
      });
    }, 1000);
  }

  private stopFpsCounter() {
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = null;
    }
  }

  private decodeBinaryStatic(buffer: ArrayBuffer) {
    if (buffer.byteLength < 4) return;
    const view = new DataView(buffer);
    let offset = 0;
    const magic = view.getUint32(offset);
    offset += 4;

    if (magic === META_MAGIC) {
      this.decodeMetadataStatic(view, offset);
    } else if (magic === CHUNK_MAGIC) {
      this.decodeDataChunkStatic(view, offset);
    }
  }

  private decodeMetadataStatic(view: DataView, offset: number) {
    offset += 1;
    const channelCount = view.getUint16(offset);
    offset += 2;

    if (!this.metaTextDecoder) {
      this.metaTextDecoder = new TextDecoder('utf-8');
    }
    const decoder = this.metaTextDecoder;

    const metaArr: ChannelMeta[] = new Array(channelCount);

    for (let i = 0; i < channelCount; i++) {
      const index = view.getUint8(offset++);
      const nameLen = view.getUint8(offset++);
      for (let j = 0; j < nameLen; j++) {
        this.metaNameBytes[j] = view.getUint8(offset + j);
      }
      offset += nameLen;
      const unitLen = view.getUint8(offset++);
      for (let j = 0; j < unitLen; j++) {
        this.metaUnitBytes[j] = view.getUint8(offset + j);
      }
      offset += unitLen;
      const min = view.getFloat32(offset); offset += 4;
      const max = view.getFloat32(offset); offset += 4;
      const colorInt = view.getInt32(offset); offset += 4;

      const r = (colorInt >> 16) & 0xFF;
      const g = (colorInt >> 8) & 0xFF;
      const b = colorInt & 0xFF;
      const color = `rgb(${r}, ${g}, ${b})`;

      const nameView = this.metaNameBytes.subarray(0, nameLen);
      const unitView = this.metaUnitBytes.subarray(0, unitLen);
      metaArr[i] = {
        index,
        name: decoder.decode(nameView),
        unit: decoder.decode(unitView),
        min, max, color,
      };
    }

    this.channelMeta = metaArr;
    this.channelCount = channelCount;
    if (this.staticLatestScratch.length < channelCount) {
      this.staticLatestScratch = new Float32Array(Math.max(SCRATCH_LATEST_LEN, channelCount));
    }

    this.metaListeners.forEach(fn => {
      try { fn(metaArr); } catch (e) { console.error(e); }
    });
  }

  private decodeDataChunkStatic(view: DataView, offset: number) {
    offset += 1;
    offset += 2;
    const firstTimestamp = view.getFloat64(offset); offset += 8;
    const lastSeq = view.getInt32(offset); offset += 4;
    const frameCount = view.getInt32(offset); offset += 4;
    const channelCount = view.getUint16(offset); offset += 2;

    if (frameCount <= 0 || channelCount <= 0) return;

    this.totalFrames += frameCount;
    this.fpsFrames += frameCount;

    const perFrameStep = 8 + 4 + 4 * channelCount;
    for (let c = 0; c < channelCount && c < MAX_CHANNELS; c++) {
      this.lastChunkSampleBaseOffsets[c] = 8 + 4 + 4 * c;
    }

    this.lastChunkView = view;
    this.lastChunkPayloadOffset = offset;
    this.lastChunkFrameCount = frameCount;
    this.lastChunkChannelCount = channelCount;
    this.lastChunkPerFrameStep = perFrameStep;

    const latest = this.staticLatestScratch;
    const lastFrameOffset = offset + perFrameStep * (frameCount - 1) + 8 + 4;
    for (let c = 0; c < channelCount; c++) {
      latest[c] = view.getFloat32(lastFrameOffset + 4 * c, true);
    }

    const info = this.scratchChunkInfo;
    info.firstTimestamp = firstTimestamp;
    info.lastSequence = lastSeq;
    info.frameCount = frameCount;
    info.channelCount = channelCount;

    this.rawChunkListeners.forEach(fn => {
      try { fn(info); } catch (e) { console.error(e); }
    });
  }

  writeChannelToRing(channelIndex: number, ring: NumericRingBuffer): number {
    const view = this.lastChunkView;
    if (!view) return 0;
    if (channelIndex < 0 || channelIndex >= this.lastChunkChannelCount) return 0;

    const frameCount = this.lastChunkFrameCount;
    const perFrameStep = this.lastChunkPerFrameStep;
    const sampleBaseOffset = this.lastChunkSampleBaseOffsets[channelIndex];
    const payloadOffset = this.lastChunkPayloadOffset;

    const capacity = ring.getCapacity();
    let w = ring.getWriteIndex();
    const raw = ring.getRawBuffer();

    let lastVal = 0;
    for (let f = 0; f < frameCount; f++) {
      const sampleOffset = payloadOffset + f * perFrameStep + sampleBaseOffset;
      const v = view.getFloat32(sampleOffset, true);
      raw[w] = v;
      w = (w + 1) % capacity;
      lastVal = v;
    }

    ring.forceAdvanceWrite(w, frameCount);
    return lastVal;
  }

  getLastChunkFrameCount(): number {
    return this.lastChunkFrameCount;
  }
}
