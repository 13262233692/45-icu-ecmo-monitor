export interface ChannelMeta {
  index: number;
  name: string;
  unit: string;
  min: number;
  max: number;
  color: string;
}

export interface SensorFrame {
  timestamp: number;
  sequence: number;
  samples: Float32Array;
}

export interface DataChunk {
  timestamp: number;
  lastSequence: number;
  frameCount: number;
  channelCount: number;
  samples: Float32Array[];
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const CHUNK_MAGIC = 0x45434D30;
const META_MAGIC = 0x4D455441;

export class EcmoWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private status: ConnectionStatus = 'disconnected';
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private metaListeners = new Set<(meta: ChannelMeta[]) => void>();
  private dataListeners = new Set<(chunk: DataChunk) => void>();
  private rawFrameListeners = new Set<(frame: SensorFrame) => void>();
  private statsListeners = new Set<(stats: { fps: number; total: number }) => void>();
  private totalFrames = 0;
  private fpsFrames = 0;
  private fpsTimer: number | null = null;

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
          this.decodeBinary(event.data);
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

  onStatus(fn: (s: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onMetadata(fn: (meta: ChannelMeta[]) => void) {
    this.metaListeners.add(fn);
    return () => this.metaListeners.delete(fn);
  }

  onDataChunk(fn: (chunk: DataChunk) => void) {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  onFrame(fn: (frame: SensorFrame) => void) {
    this.rawFrameListeners.add(fn);
    return () => this.rawFrameListeners.delete(fn);
  }

  onStats(fn: (stats: { fps: number; total: number }) => void) {
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
        try { fn({ fps, total: this.totalFrames }); } catch (e) { console.error(e); }
      });
    }, 1000);
  }

  private stopFpsCounter() {
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = null;
    }
  }

  private decodeBinary(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    let offset = 0;

    if (buffer.byteLength < 4) return;

    const magic = view.getUint32(offset);
    offset += 4;

    if (magic === META_MAGIC) {
      this.decodeMetadata(view, offset);
    } else if (magic === CHUNK_MAGIC) {
      this.decodeDataChunk(view, offset);
    }
  }

  private decodeMetadata(view: DataView, offset: number) {
    const version = view.getUint8(offset++);
    void version;
    const channelCount = view.getUint16(offset);
    offset += 2;

    const meta: ChannelMeta[] = [];

    for (let i = 0; i < channelCount; i++) {
      const index = view.getUint8(offset++);
      const nameLen = view.getUint8(offset++);
      const nameBytes = new Uint8Array(view.buffer, view.byteOffset + offset, nameLen);
      offset += nameLen;
      const unitLen = view.getUint8(offset++);
      const unitBytes = new Uint8Array(view.buffer, view.byteOffset + offset, unitLen);
      offset += unitLen;
      const min = view.getFloat32(offset); offset += 4;
      const max = view.getFloat32(offset); offset += 4;
      const colorInt = view.getInt32(offset); offset += 4;

      const r = (colorInt >> 16) & 0xFF;
      const g = (colorInt >> 8) & 0xFF;
      const b = colorInt & 0xFF;
      const color = `rgb(${r}, ${g}, ${b})`;

      const decoder = new TextDecoder('utf-8');
      meta.push({
        index,
        name: decoder.decode(nameBytes),
        unit: decoder.decode(unitBytes),
        min, max, color,
      });
    }

    this.metaListeners.forEach(fn => {
      try { fn(meta); } catch (e) { console.error(e); }
    });
  }

  private decodeDataChunk(view: DataView, offset: number) {
    const version = view.getUint8(offset++);
    void version;
    const flags = view.getUint16(offset); offset += 2;
    void flags;
    const firstTimestamp = view.getFloat64(offset); offset += 8;
    const lastSeq = view.getInt32(offset); offset += 4;
    const frameCount = view.getInt32(offset); offset += 4;
    const channelCount = view.getUint16(offset); offset += 2;

    const samplesPerChannel: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      samplesPerChannel.push(new Float32Array(frameCount));
    }
    const frames: SensorFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const ts = view.getFloat64(offset); offset += 8;
      const seq = view.getInt32(offset); offset += 4;
      const sampleArr = new Float32Array(channelCount);
      for (let c = 0; c < channelCount; c++) {
        const v = view.getFloat32(offset); offset += 4;
        sampleArr[c] = v;
        samplesPerChannel[c][f] = v;
      }
      frames.push({ timestamp: ts, sequence: seq, samples: sampleArr });
    }

    this.totalFrames += frameCount;
    this.fpsFrames += frameCount;

    const chunk: DataChunk = {
      timestamp: firstTimestamp,
      lastSequence: lastSeq,
      frameCount,
      channelCount,
      samples: samplesPerChannel,
    };

    this.dataListeners.forEach(fn => {
      try { fn(chunk); } catch (e) { console.error(e); }
    });

    if (this.rawFrameListeners.size > 0) {
      frames.forEach(frame => {
        this.rawFrameListeners!.forEach(fn => {
          try { fn(frame); } catch (e) { console.error(e); }
        });
      });
    }
  }
}
