import { NumericRingBuffer } from './ringBuffer';

export const enum ThrombusAlertLevel {
  NORMAL = 0,
  WATCH = 1,
  WARNING = 2,
  CRITICAL = 3,
}

export interface ThrombusEvent {
  level: ThrombusAlertLevel;
  timestamp: number;
  currentTMP: number;
  slope: number;
  predictedTMP: number;
  threshold: number;
  confidence: number;
  clamped: boolean;
  message: string;
}

export interface ThrombusDetectorConfig {
  sampleRate: number;
  tmpMin: number;
  tmpMax: number;
  tmpRedLine: number;
  predictionWindowMs: number;
  highPassHz: number;
  lowPassHz: number;
  integrationWindowMs: number;
  refractoryPeriodMs: number;
}

const DEFAULT_CONFIG: ThrombusDetectorConfig = {
  sampleRate: 500,
  tmpMin: 0,
  tmpMax: 150,
  tmpRedLine: 120,
  predictionWindowMs: 500,
  highPassHz: 0.3,
  lowPassHz: 15,
  integrationWindowMs: 150,
  refractoryPeriodMs: 2000,
};

export class PanTompkinsThrombusDetector {
  private config: ThrombusDetectorConfig;

  private inputBuf: NumericRingBuffer;
  private hpBuf: NumericRingBuffer;
  private lpBuf: NumericRingBuffer;
  private derivBuf: NumericRingBuffer;
  private sqBuf: NumericRingBuffer;
  private integBuf: NumericRingBuffer;

  private hpState: { w1: number; w2: number; w3: number } = { w1: 0, w2: 0, w3: 0 };
  private lpState: { y1: number; y2: number; x1: number; x2: number } = {
    y1: 0, y2: 0, x1: 0, x2: 0,
  };

  private integSum = 0;
  private integWindowLen = 0;

  private peakBuf: NumericRingBuffer;
  private thresholdBuf: NumericRingBuffer;
  private spki = 0;
  private npki = 0;
  private thresholdI1 = 0;

  private lastPeakIdx = -1;
  private beatCount = 0;

  private tmpSlopeShort = 0;
  private tmpSlopeLong = 0;
  private tmpBaseline = 0;
  private baselineInitialized = false;

  private lastAlertTime = 0;
  private refractoryMs = 2000;
  private currentLevel: ThrombusAlertLevel = ThrombusAlertLevel.NORMAL;

  private eventScratch: ThrombusEvent = {
    level: ThrombusAlertLevel.NORMAL,
    timestamp: 0,
    currentTMP: 0,
    slope: 0,
    predictedTMP: 0,
    threshold: 0,
    confidence: 0,
    clamped: false,
    message: '',
  };

  private alertListeners = new Set<(ev: ThrombusEvent) => void>();
  private clampListeners = new Set<(ev: ThrombusEvent) => void>();

  private predictionSamples = 0;

  constructor(cfg: Partial<ThrombusDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };

    const sr = this.config.sampleRate;
    const windowSize = Math.floor(sr * 4);

    this.inputBuf = new NumericRingBuffer(windowSize);
    this.hpBuf = new NumericRingBuffer(windowSize);
    this.lpBuf = new NumericRingBuffer(windowSize);
    this.derivBuf = new NumericRingBuffer(windowSize);
    this.sqBuf = new NumericRingBuffer(windowSize);
    this.integBuf = new NumericRingBuffer(windowSize);

    this.peakBuf = new NumericRingBuffer(120);
    this.thresholdBuf = new NumericRingBuffer(120);

    this.integWindowLen = Math.floor(sr * this.config.integrationWindowMs / 1000);
    this.refractoryMs = this.config.refractoryPeriodMs;
    this.predictionSamples = Math.floor(sr * this.config.predictionWindowMs / 1000);

    this.reset();
  }

  reset(): void {
    this.inputBuf.clear();
    this.hpBuf.clear();
    this.lpBuf.clear();
    this.derivBuf.clear();
    this.sqBuf.clear();
    this.integBuf.clear();
    this.peakBuf.clear();
    this.thresholdBuf.clear();

    this.hpState = { w1: 0, w2: 0, w3: 0 };
    this.lpState = { y1: 0, y2: 0, x1: 0, x2: 0 };

    this.integSum = 0;
    this.spki = 0;
    this.npki = 0;
    this.thresholdI1 = 0;
    this.lastPeakIdx = -1;
    this.beatCount = 0;
    this.tmpSlopeShort = 0;
    this.tmpSlopeLong = 0;
    this.tmpBaseline = 0;
    this.baselineInitialized = false;
    this.lastAlertTime = 0;
    this.currentLevel = ThrombusAlertLevel.NORMAL;
  }

  onAlert(fn: (ev: ThrombusEvent) => void): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  onClamp(fn: (ev: ThrombusEvent) => void): () => void {
    this.clampListeners.add(fn);
    return () => this.clampListeners.delete(fn);
  }

  getCurrentLevel(): ThrombusAlertLevel {
    return this.currentLevel;
  }

  getCurrentTMP(): number {
    return this.inputBuf.getLast();
  }

  getSlope(): number {
    return this.tmpSlopeShort;
  }

  processChunk(newSamples: number): void {
    if (newSamples <= 0) return;
    const size = this.inputBuf.size();
    if (size < 2) return;
    const startIdx = Math.max(0, size - newSamples);

    for (let i = startIdx; i < size; i++) {
      const sample = this.inputBuf.get(i);
      this.processSample(sample);
    }
  }

  pushSample(value: number): void {
    this.inputBuf.push(value);
    this.processSample(value);
  }

  pushFromRing(ring: NumericRingBuffer, newSamples: number): void {
    if (newSamples <= 0) return;
    const size = ring.size();
    const startIdx = Math.max(0, size - newSamples);
    for (let i = startIdx; i < size; i++) {
      this.pushSample(ring.get(i));
    }
  }

  private processSample(x: number): void {
    const hp = this.highPassButterworth(x);
    this.hpBuf.push(hp);

    const lp = this.lowPassButterworth(hp);
    this.lpBuf.push(lp);

    const deriv = this.derivative5(lp);
    this.derivBuf.push(deriv);

    const sq = deriv * deriv;
    this.sqBuf.push(sq);

    const integ = this.movingWindowIntegral(sq);
    this.integBuf.push(integ);

    this.adaptiveThresholdDetect(integ);

    this.updateTmpSlope(x);

    this.checkThrombusRisk(x);
  }

  private highPassButterworth(x: number): number {
    const fs = this.config.sampleRate;
    const fc = this.config.highPassHz;
    const wc = Math.tan(Math.PI * fc / fs);
    const k1 = Math.SQRT2 * wc;
    const k2 = wc * wc;
    const a0 = 1 + k1 + k2;

    const w0 = x - (k1 * this.hpState.w1 + k2 * this.hpState.w2) / a0;
    const y = (w0 - 2 * this.hpState.w1 + this.hpState.w2) / a0;

    this.hpState.w2 = this.hpState.w1;
    this.hpState.w1 = w0;
    this.hpState.w3 = y;
    return y;
  }

  private lowPassButterworth(x: number): number {
    const fs = this.config.sampleRate;
    const fc = this.config.lowPassHz;
    const wc = Math.tan(Math.PI * fc / fs);
    const k1 = Math.SQRT2 * wc;
    const k2 = wc * wc;
    const a0 = 1 + k1 + k2;

    const y = (k2 * (x + 2 * this.lpState.x1 + this.lpState.x2)
      + (2 * this.lpState.y1 * (1 + k2) + this.lpState.y2 * (k2 - k1 - 1))) / a0;

    this.lpState.x2 = this.lpState.x1;
    this.lpState.x1 = x;
    this.lpState.y2 = this.lpState.y1;
    this.lpState.y1 = y;
    return y;
  }

  private derivative5(_x: number): number {
    const buf = this.lpBuf;
    const n = buf.size();
    if (n < 5) return 0;
    const xm2 = buf.get(n - 5);
    const xm1 = buf.get(n - 4);
    const xp1 = buf.get(n - 2);
    const xp2 = buf.get(n - 1);
    return (xp2 + 2 * xp1 - 2 * xm1 - xm2) * (this.config.sampleRate / 1000.0);
  }

  private movingWindowIntegral(sq: number): number {
    this.integSum += sq;
    if (this.integBuf.size() >= this.integWindowLen) {
      const dropIdx = this.integBuf.size() - this.integWindowLen;
      if (dropIdx >= 0) {
        const dropped = this.integBuf.get(dropIdx);
        this.integSum -= dropped;
      }
    }
    const winLen = Math.min(this.integBuf.size() + 1, this.integWindowLen);
    return this.integSum / winLen;
  }

  private adaptiveThresholdDetect(integ: number): void {
    const n = this.integBuf.size();
    if (n < 3) return;

    const prev1 = this.integBuf.get(n - 2);
    const prev2 = this.integBuf.get(n - 3);

    if (integ > prev1 && prev1 >= prev2 && integ > this.thresholdI1) {
      const minDistMs = 150;
      const minDistSamples = Math.floor(this.config.sampleRate * minDistMs / 1000);

      if (this.lastPeakIdx < 0 || (n - this.lastPeakIdx) > minDistSamples) {
        this.lastPeakIdx = n;
        this.beatCount++;
        this.peakBuf.push(integ);

        this.spki = 0.125 * integ + 0.875 * this.spki;
        this.thresholdI1 = this.npki + 0.25 * (this.spki - this.npki);
        this.thresholdBuf.push(this.thresholdI1);
      }
    } else if (integ < this.thresholdI1) {
      this.npki = 0.125 * integ + 0.875 * this.npki;
      this.thresholdI1 = this.npki + 0.25 * (this.spki - this.npki);
    }
  }

  private updateTmpSlope(x: number): void {
    if (!this.baselineInitialized) {
      this.tmpBaseline = x;
      this.tmpSlopeShort = 0;
      this.tmpSlopeLong = 0;
      this.baselineInitialized = true;
      return;
    }

    const alphaShort = 2 / (this.config.sampleRate * 0.5 + 1);
    const alphaLong = 2 / (this.config.sampleRate * 2 + 1);

    const targetSlope = (x - this.tmpBaseline) * this.config.sampleRate;
    this.tmpSlopeShort = alphaShort * targetSlope + (1 - alphaShort) * this.tmpSlopeShort;
    this.tmpSlopeLong = alphaLong * targetSlope + (1 - alphaLong) * this.tmpSlopeLong;

    const baseAlpha = 1 / (this.config.sampleRate * 3 + 1);
    this.tmpBaseline = baseAlpha * x + (1 - baseAlpha) * this.tmpBaseline;
  }

  private checkThrombusRisk(currentTMP: number): void {
    const now = Date.now();
    if (now - this.lastAlertTime < this.refractoryMs) {
      return;
    }

    const redLine = this.config.tmpRedLine;
    const predSamples = this.predictionSamples;
    const slope = this.tmpSlopeShort;
    const predicted = currentTMP + slope * predSamples / this.config.sampleRate;

    let level = ThrombusAlertLevel.NORMAL;
    let confidence = 0;
    let message = '';

    if (currentTMP > redLine) {
      level = ThrombusAlertLevel.CRITICAL;
      confidence = 0.99;
      message = 'TMP 已突破高压红线 - 立即启动安全钳制';
    } else if (predicted > redLine && slope > 2) {
      level = ThrombusAlertLevel.CRITICAL;
      confidence = Math.min(0.95, 0.6 + (predicted - redLine) / redLine * 0.5);
      message = '预测 500ms 内 TMP 将突破高压红线 - 启动安全钳制';
    } else if (slope > 5 && this.tmpSlopeLong > 1) {
      level = ThrombusAlertLevel.WARNING;
      confidence = 0.7;
      message = 'TMP 斜率异常增高 - 疑似早期血栓形成';
    } else if (slope > 2 || currentTMP > redLine * 0.85) {
      level = ThrombusAlertLevel.WATCH;
      confidence = 0.4;
      message = 'TMP 基线上升 - 密切关注';
    }

    if (level > this.currentLevel && level >= ThrombusAlertLevel.WATCH) {
      this.dispatchAlert(level, currentTMP, slope, predicted, redLine, confidence, message);
      this.currentLevel = level;
      this.lastAlertTime = now;

      if (level === ThrombusAlertLevel.CRITICAL) {
        this.dispatchClamp(level, currentTMP, slope, predicted, redLine, confidence, message);
      }
    } else if (level === ThrombusAlertLevel.NORMAL
      && this.currentLevel !== ThrombusAlertLevel.NORMAL
      && now - this.lastAlertTime > 5000) {
      this.currentLevel = ThrombusAlertLevel.NORMAL;
      this.dispatchAlert(level, currentTMP, slope, predicted, redLine, 0, '状态恢复正常');
    }
  }

  private dispatchAlert(
    level: ThrombusAlertLevel,
    tmp: number,
    slope: number,
    predicted: number,
    threshold: number,
    confidence: number,
    message: string,
  ): void {
    const ev = this.eventScratch;
    ev.level = level;
    ev.timestamp = Date.now();
    ev.currentTMP = tmp;
    ev.slope = slope;
    ev.predictedTMP = predicted;
    ev.threshold = threshold;
    ev.confidence = confidence;
    ev.clamped = level === ThrombusAlertLevel.CRITICAL;
    ev.message = message;
    this.alertListeners.forEach((fn) => {
      try { fn(ev); } catch (e) { console.error(e); }
    });
  }

  private dispatchClamp(
    level: ThrombusAlertLevel,
    tmp: number,
    slope: number,
    predicted: number,
    threshold: number,
    confidence: number,
    message: string,
  ): void {
    const ev = this.eventScratch;
    ev.level = level;
    ev.timestamp = Date.now();
    ev.currentTMP = tmp;
    ev.slope = slope;
    ev.predictedTMP = predicted;
    ev.threshold = threshold;
    ev.confidence = confidence;
    ev.clamped = true;
    ev.message = message;
    this.clampListeners.forEach((fn) => {
      try { fn(ev); } catch (e) { console.error(e); }
    });
  }
}
