import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  EcmoStreamStateMachine,
  ChannelMeta,
  StreamStats,
  ConnectionStatus,
  ThrombusEvent,
  ThrombusAlertLevel,
} from './core/streamState';
import { EkgScrollRenderer } from './core/ekgRenderer';
import type { NumericRingBuffer } from './core/ringBuffer';

const STREAM_SINGLETON = new EcmoStreamStateMachine(60000);
const CHANNEL_DISPLAY_ORDER = [0, 4, 1, 2, 3, 5, 10, 11, 6, 7, 8, 9];
const VITAL_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5, 10, 11];

function useNowTick() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useEcmoStream() {
  const [meta, setMeta] = useState<ChannelMeta[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [stats, setStats] = useState<StreamStats>({ fps: 0, totalFrames: 0, lastFrameTime: 0 });
  const [thrombusLevel, setThrombusLevel] = useState<ThrombusAlertLevel>(ThrombusAlertLevel.NORMAL);
  const [thrombusEvent, setThrombusEvent] = useState<ThrombusEvent | null>(null);
  const [, bumpTick] = useState(0);

  const pendingSamplesRef = useRef(0);
  const rafPendingRef = useRef(false);

  const scheduleRenderBump = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const total = pendingSamplesRef.current;
      pendingSamplesRef.current = 0;
      if (total > 0) {
        bumpTick((n) => (n + 1) % 1000000);
      }
    });
  }, []);

  useEffect(() => {
    const offMeta = STREAM_SINGLETON.onMetadata((m) => {
      setMeta(m);
    });
    const offStatus = STREAM_SINGLETON.onStatus((s) => {
      setStatus(s);
    });
    const offStats = STREAM_SINGLETON.onStats((st) => {
      setStats({ ...st });
    });
    const offData = STREAM_SINGLETON.onData((newSamples: number) => {
      pendingSamplesRef.current += newSamples;
      scheduleRenderBump();
    });
    const offThrombus = STREAM_SINGLETON.onThrombusAlert((ev: ThrombusEvent) => {
      setThrombusLevel(ev.level);
      setThrombusEvent({ ...ev });
    });
    STREAM_SINGLETON.start();
    return () => {
      offMeta();
      offStatus();
      offStats();
      offData();
      offThrombus();
      STREAM_SINGLETON.stop();
    };
  }, [scheduleRenderBump]);

  return { meta, status, stats, stream: STREAM_SINGLETON, thrombusLevel, thrombusEvent };
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  const mapping: Record<ConnectionStatus, { cls: string; label: string }> = {
    connected: { cls: '', label: '数据已连接' },
    connecting: { cls: 'connecting', label: '正在连接...' },
    disconnected: { cls: 'error', label: '连接已断开' },
    error: { cls: 'error', label: '连接错误' },
  };
  const m = mapping[status];
  return (
    <div className={`status-pill ${m.cls}`}>
      <div className="status-dot" />
      <span className="status-label">{m.label}</span>
    </div>
  );
}

interface VitalCardProps {
  meta: ChannelMeta;
  stream: EcmoStreamStateMachine;
  tick: number;
}

const VitalCard = React.memo(function VitalCard({ meta, stream, tick }: VitalCardProps) {
  void tick;
  const value = stream.getLatestValue(meta.index);
  const decimals = meta.max > 100 ? 0 : meta.max > 10 ? 1 : 2;
  const displayVal = value.toFixed(decimals);
  return (
    <div className="vital-card">
      <div className="vital-dot" style={{ background: meta.color }} />
      <div className="vital-info">
        <div className="vital-name">{meta.name}</div>
        <div className="vital-value" style={{ color: meta.color }}>{displayVal}</div>
      </div>
      <div className="vital-unit">{meta.unit}</div>
    </div>
  );
});

interface WaveformCellProps {
  meta: ChannelMeta;
  stream: EcmoStreamStateMachine;
  tick: number;
}

const WaveformCell = React.memo(function WaveformCell({ meta, stream, tick }: WaveformCellProps) {
  void tick;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EkgScrollRenderer | null>(null);
  const lastRenderedSizeRef = useRef(0);
  const valueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new EkgScrollRenderer({
      color: meta.color,
      minValue: meta.min,
      maxValue: meta.max,
      scrollSpeed: 80,
      lineWidth: 1.6,
      glowIntensity: 10,
      paddingTop: 6,
      paddingBottom: 6,
    });
    rendererRef.current = renderer;

    try {
      renderer.attach(canvas);
      renderer.start();
    } catch (e) {
      console.error('Renderer attach failed:', e);
    }

    const onResize = () => {
      requestAnimationFrame(() => renderer.resize());
    };
    window.addEventListener('resize', onResize);
    const resizeObs = new ResizeObserver(onResize);
    if (canvas.parentElement) {
      resizeObs.observe(canvas.parentElement);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObs.disconnect();
      renderer.stop();
      renderer.detach();
    };
  }, [meta.index, meta.color, meta.min, meta.max]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const buf: NumericRingBuffer | null = stream.getChannelBuffer(meta.index);
    if (!buf) return;

    const size = buf.size();
    const newSamples = size - lastRenderedSizeRef.current;
    if (newSamples > 0) {
      renderer.pushBatchFromBuffer(buf, newSamples);
      lastRenderedSizeRef.current = size;
    } else if (newSamples < 0) {
      lastRenderedSizeRef.current = size;
    }

    const decimals = meta.max > 100 ? 0 : meta.max > 10 ? 1 : 2;
    const latest = stream.getLatestValue(meta.index);
    if (valueRef.current) {
      valueRef.current.textContent = latest.toFixed(decimals);
    }
  });

  return (
    <div className="waveform-cell">
      <div className="waveform-header">
        <div className="waveform-title">
          <div className="waveform-color-bar" style={{ background: meta.color }} />
          <span className="waveform-name">{meta.name}</span>
        </div>
        <div className="waveform-readout">
          <span className="readout-value" ref={valueRef} style={{ color: meta.color }}>--</span>
          <span className="readout-unit">{meta.unit}</span>
        </div>
      </div>
      <div className="waveform-canvas-wrap">
        <canvas ref={canvasRef} className="waveform-canvas" />
      </div>
    </div>
  );
});

export default function App() {
  const { meta, status, stats, stream, thrombusLevel, thrombusEvent } = useEcmoStream();
  const now = useNowTick();

  const isCritical = thrombusLevel === ThrombusAlertLevel.CRITICAL;
  const clamped = thrombusEvent?.clamped ?? false;

  const pumpStatus = clamped ? 'clamped' : isCritical ? 'clamping' : 'normal';

  const orderedChannels = useMemo(() => {
    if (!meta.length) return [] as ChannelMeta[];
    const arr: ChannelMeta[] = [];
    for (let i = 0; i < CHANNEL_DISPLAY_ORDER.length; i++) {
      const m = meta.find((x) => x.index === CHANNEL_DISPLAY_ORDER[i]);
      if (m) arr.push(m);
    }
    return arr;
  }, [meta]);

  const vitals = useMemo(() => {
    if (!meta.length) return [] as ChannelMeta[];
    const arr: ChannelMeta[] = [];
    for (let i = 0; i < VITAL_INDICES.length; i++) {
      const m = meta.find((x) => x.index === VITAL_INDICES[i]);
      if (m) arr.push(m);
    }
    return arr;
  }, [meta]);

  const bloodGasChannels = useMemo(() => {
    if (!meta.length) return [] as ChannelMeta[];
    return meta.filter((m) => VITAL_INDICES.indexOf(m.index) < 0);
  }, [meta]);

  const timeStr = useMemo(
    () => now.toLocaleTimeString('zh-CN', { hour12: false }),
    [now],
  );
  const dateStr = useMemo(
    () =>
      now.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
      }),
    [now],
  );

  const statusNum =
    status === 'connected' ? 3 : status === 'connecting' ? 2 : status === 'disconnected' ? 0 : 1;
  const renderTick = statusNum * 1000000000 + stats.fps * 100000 + (stats.totalFrames % 100000);

  const latencyItems = useMemo(() => {
    const items: { level: 'info' | 'warning' | 'critical'; msg: string }[] = [];
    const connected = status === 'connected';
    items.push({
      level: 'info',
      msg: `采样率: ${connected ? '500 Hz' : '--'} Hz`,
    });
    items.push({
      level: 'info',
      msg: `数据吞吐: ${stats.fps.toLocaleString()} 帧/秒`,
    });
    if (connected && stats.fps > 0 && stats.fps < 450) {
      items.push({ level: 'warning', msg: `吞吐偏低 (${stats.fps}/500)` });
    }
    if (!connected) {
      items.push({ level: 'critical', msg: '信号丢失 - 请检查设备连接' });
    }
    return items;
  }, [status, stats.fps]);

  return (
    <div className={`app-root ${isCritical ? 'critical-mode' : ''}`}>
      {isCritical && (
        <div className="red-alert-banner">
          <div className="alert-pulse" />
          <div className="alert-icon">⚠</div>
          <div className="alert-content">
            <div className="alert-title">恶性体外循环栓塞 · 一级红色警报</div>
            <div className="alert-desc">
              {thrombusEvent?.message || '检测到 TMP 异常突变，已启动安全钳制'}
              {thrombusEvent && (
                <>
                  {' '}· 当前 TMP: {thrombusEvent.currentTMP.toFixed(1)} mmHg · 预测:{' '}
                  {thrombusEvent.predictedTMP.toFixed(1)} mmHg
                </>
              )}
            </div>
          </div>
          <div className="alert-status-badge">
            {clamped ? '血泵已锁死' : '正在启动钳制...'}
          </div>
        </div>
      )}

      <header className="top-bar">
        <div className="logo-area">
          <div className="logo-icon">E</div>
          <div className="logo-text">
            <h1>ICU ECMO 生命支持监护系统</h1>
            <h2>EXTROCORPOREAL MEMBRANE OXYGENATION</h2>
          </div>
        </div>
        <div className="top-center">
          <StatusPill status={status} />
          <div className="stats-bar">
            <div className="stat-item">
              <span>通道</span>
              <span className="stat-value">{meta.length}/12</span>
            </div>
            <div className="stat-item">
              <span>吞吐</span>
              <span className="stat-value">{stats.fps}/s</span>
            </div>
            <div className="stat-item">
              <span>累计帧</span>
              <span className="stat-value">{stats.totalFrames.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="clock-display">
          <div className="clock-time">{timeStr}</div>
          <div className="clock-date">{dateStr}</div>
        </div>
      </header>

      <main className="main-content">
        <aside className="left-panel">
          <div className={`pump-status-card ${pumpStatus}`}>
            <div className="pump-status-header">
              <div className={`pump-status-dot ${pumpStatus}`} />
              <span className="pump-status-label">血泵安全控制</span>
            </div>
            <div className="pump-status-main">
              <span className={`pump-status-text ${pumpStatus}`}>
                {clamped ? '安全钳制已启动' : isCritical ? '正在钳制...' : '正常运行'}
              </span>
            </div>
            <div className="pump-status-detail">
              <span>模式: VA-ECMO</span>
              <span className="pump-status-sep">·</span>
              <span>状态: {clamped ? 'FLOW LOCKED' : 'AUTO'}</span>
            </div>
            {thrombusEvent && isCritical && (
              <div className="pump-clamp-info">
                <div>触发: {thrombusEvent.message}</div>
                <div>置信度: {(thrombusEvent.confidence * 100).toFixed(0)}%</div>
              </div>
            )}
          </div>

          <div className="vitals-panel">
            <div className="panel-title">
              <h3>关键参数</h3>
              <span className="title-icon">♥</span>
            </div>
            {vitals.map((m) => (
              <VitalCard key={m.index} meta={m} stream={stream} tick={renderTick} />
            ))}
          </div>
          <div className="vitals-panel">
            <div className="panel-title">
              <h3>血气指标</h3>
              <span className="title-icon">⚡</span>
            </div>
            {bloodGasChannels.map((m) => (
              <VitalCard key={m.index} meta={m} stream={stream} tick={renderTick} />
            ))}
          </div>
        </aside>

        <section className="waveform-area">
          <div className="waveform-grid">
            {orderedChannels.map((m) => (
              <WaveformCell key={m.index} meta={m} stream={stream} tick={renderTick} />
            ))}
          </div>
        </section>

        <footer className="bottom-alerts">
          {latencyItems.map((a, i) => (
            <div key={i} className={`alert-item ${a.level}`}>
              {a.level === 'critical' && '● '}
              {a.level === 'warning' && '⚠ '}
              {a.level === 'info' && 'ℹ '}
              {a.msg}
            </div>
          ))}
          <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
            床位 ICU-A03 · 患者 ID #241108017 · 模式 VA-ECMO
          </div>
        </footer>
      </main>
    </div>
  );
}
