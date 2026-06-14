import { NumericRingBuffer } from './ringBuffer';

export interface RendererConfig {
  color: string;
  lineWidth?: number;
  scrollSpeed?: number;
  minValue: number;
  maxValue: number;
  paddingTop?: number;
  paddingBottom?: number;
  showGrid?: boolean;
  gridColor?: string;
  bgColor?: string;
  fadeSpeed?: number;
  glowIntensity?: number;
}

const DEFAULT_CONFIG = {
  lineWidth: 1.5,
  scrollSpeed: 60,
  paddingTop: 4,
  paddingBottom: 4,
  showGrid: true,
  gridColor: 'rgba(77, 150, 255, 0.12)',
  gridColorMajor: 'rgba(77, 150, 255, 0.20)',
  bgColor: 'transparent',
  fadeSpeed: 0.12,
  glowIntensity: 12,
};

function parseRgbColor(color: string): [number, number, number] {
  const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) {
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }
  return [255, 255, 255];
}

export class EkgScrollRenderer {
  private onscreenCtx: CanvasRenderingContext2D | null = null;
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private scrollX = 0;
  private lastScrollX = 0;
  private config: Required<RendererConfig> & { gridColorMajor: string };
  private running = false;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private writeHeadSmoothY = 0;
  private initialized = false;

  private cacheHeadGradColorA = 'rgba(0, 255, 136, 0.6)';
  private cacheHeadGradColorB = 'rgb(0, 255, 136)';
  private cachedHeadGrad: CanvasGradient | null = null;
  private cachedHeadGradXStart = -9999;
  private cachedHeadGradXEnd = -9999;
  private cachedHeadGradH = -1;

  constructor(config: RendererConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<RendererConfig> & { gridColorMajor: string };
    if (!this.config.gridColorMajor) {
      this.config.gridColorMajor = DEFAULT_CONFIG.gridColorMajor;
    }
    this.rebuildColorCaches(this.config.color);
  }

  private rebuildColorCaches(color: string) {
    const rgb = parseRgbColor(color);
    this.cacheHeadGradColorA = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`;
    this.cacheHeadGradColorB = color;
    this.cachedHeadGrad = null;
    this.cachedHeadGradXStart = -9999;
    this.cachedHeadGradXEnd = -9999;
    this.cachedHeadGradH = -1;
  }

  attach(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;

    const rect = canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    canvas.width = Math.floor(this.width * dpr);
    canvas.height = Math.floor(this.height * dpr);

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('Failed to get onscreen context');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    this.onscreenCtx = ctx;

    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = Math.floor(this.width * dpr);
    this.offscreenCanvas.height = Math.floor(this.height * dpr);
    const offCtx = this.offscreenCanvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!offCtx) throw new Error('Failed to get offscreen context');
    offCtx.scale(dpr, dpr);
    offCtx.imageSmoothingEnabled = true;
    this.offscreenCtx = offCtx;

    this.clearAll();
    this.initialized = true;
  }

  detach() {
    this.stop();
    this.onscreenCtx = null;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.initialized = false;
  }

  resize() {
    if (!this.onscreenCtx) return;
    const canvas = this.onscreenCtx.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === this.width && rect.height === this.height) return;

    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.width = rect.width;
    this.height = rect.height;

    canvas.width = Math.floor(this.width * dpr);
    canvas.height = Math.floor(this.height * dpr);

    this.onscreenCtx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (this.onscreenCtx) {
      this.onscreenCtx.scale(dpr, dpr);
      this.onscreenCtx.imageSmoothingEnabled = true;
    }

    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = Math.floor(this.width * dpr);
    this.offscreenCanvas.height = Math.floor(this.height * dpr);
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: true, desynchronized: true });
    if (this.offscreenCtx) {
      this.offscreenCtx.scale(dpr, dpr);
      this.offscreenCtx.imageSmoothingEnabled = true;
    }

    this.cachedHeadGrad = null;
    this.clearAll();
  }

  clearAll() {
    if (!this.offscreenCtx || !this.onscreenCtx) return;
    const w = this.width;
    const h = this.height;

    if (this.config.bgColor !== 'transparent') {
      this.offscreenCtx.fillStyle = this.config.bgColor;
      this.offscreenCtx.fillRect(0, 0, w, h);
    } else {
      this.offscreenCtx.clearRect(0, 0, w, h);
    }

    if (this.config.bgColor !== 'transparent') {
      this.onscreenCtx.fillStyle = this.config.bgColor;
      this.onscreenCtx.fillRect(0, 0, w, h);
    } else {
      this.onscreenCtx.clearRect(0, 0, w, h);
    }

    this.scrollX = 0;
    this.lastScrollX = 0;
  }

  start() {
    if (this.running || !this.initialized) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    this.renderScroll(dt);

    this.rafId = requestAnimationFrame(this.tick);
  };

  private renderScroll(dt: number) {
    if (!this.offscreenCtx || !this.onscreenCtx) return;

    const w = this.width;
    const h = this.height;
    const speed = this.config.scrollSpeed;

    this.lastScrollX = this.scrollX;
    this.scrollX = (this.scrollX + speed * dt) % w;

    const scrollDelta = this.scrollX - this.lastScrollX;
    if (scrollDelta < 0) return;

    const eraseX = this.scrollX;
    const eraseWidth = Math.max(2, Math.ceil(scrollDelta + 4));

    const off = this.offscreenCtx;

    off.globalCompositeOperation = 'destination-out';
    off.fillStyle = 'rgba(0, 0, 0, 1)';
    off.fillRect(eraseX, 0, eraseWidth, h);
    off.globalCompositeOperation = 'source-over';

    if (this.config.showGrid) {
      this.drawScrollingGrid(off, eraseX, eraseWidth, h);
    }

    this.drawHeadMarker(off, eraseX, h);

    this.onscreenCtx.clearRect(0, 0, w, h);
    this.drawFromOffscreen(this.onscreenCtx);
  }

  private drawScrollingGrid(ctx: CanvasRenderingContext2D, eraseX: number, eraseWidth: number, h: number) {
    const gridColor = this.config.gridColor;
    const gridColorMajor = this.config.gridColorMajor;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    const startX = Math.floor(eraseX / 20) * 20;
    const endX = eraseX + eraseWidth + 20;
    for (let x = startX; x < endX; x += 20) {
      const ax = x + 0.5;
      ctx.beginPath();
      ctx.moveTo(ax, 0);
      ctx.lineTo(ax, h);
      ctx.stroke();
    }

    const majorH = h / 4;
    ctx.strokeStyle = gridColorMajor;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.floor(i * majorH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(eraseX, y);
      ctx.lineTo(eraseX + eraseWidth + 4, y);
      ctx.stroke();
    }
  }

  private drawHeadMarker(ctx: CanvasRenderingContext2D, x: number, h: number) {
    const x0 = x - 30;
    const x1 = x + 6;

    let grad = this.cachedHeadGrad;
    if (!grad || this.cachedHeadGradXStart !== x0 || this.cachedHeadGradXEnd !== x1 || this.cachedHeadGradH !== h) {
      grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      grad.addColorStop(0.85, this.cacheHeadGradColorA);
      grad.addColorStop(1, this.cacheHeadGradColorB);
      this.cachedHeadGrad = grad;
      this.cachedHeadGradXStart = x0;
      this.cachedHeadGradXEnd = x1;
      this.cachedHeadGradH = h;
    }

    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 1, 0);
    ctx.lineTo(x + 1, h);
    ctx.stroke();
  }

  private drawFromOffscreen(ctx: CanvasRenderingContext2D) {
    if (!this.offscreenCanvas) return;
    const w = this.width;
    const h = this.height;

    const off1 = this.scrollX;
    const width1 = w - off1;

    if (width1 > 0) {
      ctx.drawImage(
        this.offscreenCanvas,
        off1 * this.dpr, 0,
        width1 * this.dpr, h * this.dpr,
        0, 0,
        width1, h
      );
    }

    if (off1 > 0) {
      ctx.drawImage(
        this.offscreenCanvas,
        0, 0,
        off1 * this.dpr, h * this.dpr,
        width1, 0,
        off1, h
      );
    }
  }

  pushSample(value: number) {
    if (!this.offscreenCtx || this.width === 0) return;

    const h = this.height;
    const padTop = this.config.paddingTop;
    const padBot = this.config.paddingBottom;
    const range = this.config.maxValue - this.config.minValue;
    const clamped = Math.max(this.config.minValue, Math.min(this.config.maxValue, value));
    const normalized = (clamped - this.config.minValue) / range;
    const y = padTop + (h - padTop - padBot) * (1 - normalized);

    const writeX = this.scrollX;
    const prevX = (writeX - 1 + this.width) % this.width;
    const prevY = this.writeHeadSmoothY || y;

    const smoothY = prevY + (y - prevY) * 0.7;
    this.writeHeadSmoothY = smoothY;

    this.drawSegmentNoSave(this.offscreenCtx, prevX, prevY, writeX, smoothY);

    if (writeX < prevX) {
      this.drawSegmentNoSave(this.offscreenCtx, this.width - 1, prevY, this.width - 1, prevY);
      this.drawSegmentNoSave(this.offscreenCtx, 0, smoothY, 0, y);
    }
  }

  pushBatchFromBuffer(buffer: NumericRingBuffer, newSamples: number) {
    if (!this.offscreenCtx || this.width === 0 || newSamples <= 0) return;

    const size = buffer.size();
    if (size < 2) return;

    const h = this.height;
    const padTop = this.config.paddingTop;
    const padBot = this.config.paddingBottom;
    const range = this.config.maxValue - this.config.minValue;
    const invRange = 1.0 / range;

    const sampleCount = Math.min(newSamples, size);
    const startIdx = Math.max(0, size - sampleCount);

    let prevX = (this.scrollX + 0.5) % this.width;
    let prevY = this.writeHeadSmoothY || this.valueToY(buffer.get(Math.max(0, startIdx - 1)), h, padTop, padBot, invRange);
    const startX = prevX;

    const ctx = this.offscreenCtx;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = this.config.lineWidth;

    if (this.config.glowIntensity > 0) {
      ctx.shadowColor = this.config.color;
      ctx.shadowBlur = this.config.glowIntensity;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = this.config.color;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);

    const w = this.width;
    const threshold = w * 0.5;

    for (let i = startIdx; i < size; i++) {
      const value = buffer.get(i);
      const y = this.valueToY(value, h, padTop, padBot, invRange);
      prevY = prevY + (y - prevY) * 0.7;

      const advanceX = (w * (i - startIdx + 1)) / sampleCount;
      const nextX = (startX + advanceX) % w;

      if (nextX < prevX || (nextX - prevX) > threshold) {
        ctx.lineTo(w - 1, prevY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, prevY);
      }

      ctx.lineTo(nextX, prevY);
      prevX = nextX;
    }

    ctx.stroke();

    ctx.shadowBlur = 0;

    this.writeHeadSmoothY = prevY;
  }

  private valueToY(value: number, h: number, padTop: number, padBot: number, invRange: number): number {
    const clamped = Math.max(this.config.minValue, Math.min(this.config.maxValue, value));
    const normalized = (clamped - this.config.minValue) * invRange;
    return padTop + (h - padTop - padBot) * (1 - normalized);
  }

  private drawSegmentNoSave(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number,
    x2: number, y2: number,
  ) {
    const dy = Math.abs(y2 - y1);
    if (dy < 0.5 && Math.abs(x2 - x1) < 1) return;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = this.config.lineWidth;

    if (this.config.glowIntensity > 0) {
      ctx.shadowColor = this.config.color;
      ctx.shadowBlur = this.config.glowIntensity;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = this.config.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.shadowBlur = 0;
  }
}
