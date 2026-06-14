import { useEffect, useRef, useState, useCallback } from 'react';
import { EcmoStreamStateMachine, ChannelMeta, StreamStats, ConnectionStatus } from './core/streamState';
import { EkgScrollRenderer } from './core/ekgRenderer';

const STREAM = new EcmoStreamStateMachine(60000);

const CHANNEL_DISPLAY_ORDER = [0, 4, 1, 2, 3, 5, 10, 11, 6, 7, 8, 9];

function useNowTick() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useEcmoStream() {
  const [meta, setMeta] = useState<ChannelMeta[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [stats, setStats] = useState<StreamStats>({ fps: 0, totalFrames: 0, lastFrameTime: 0 });
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const offMeta = STREAM.onMetadata(setMeta);
    const offStatus = STREAM.onStatus(setStatus);
    const offStats = STREAM.onStats(setStats);
    const offData = STREAM.onData(() => forceUpdate(n => (n + 1) % 1000000));
    STREAM.start();
    return () => {
      offMeta();
      offStatus();
      offStats();
      offData();
      STREAM.stop();
    };
  }, []);

  return { meta, status, stats, stream: STREAM };
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  const mapping = {
    connected: { cls: '', label: '数据已连接', dot: true },
    connecting: { cls: 'connecting', label: '正在连接...', dot: true },
    disconnected: { cls: 'error', label: '连接已断开', dot: false },
    error: { cls: 'error', label: '连接错误', dot: false },
  };
  const m = mapping[status];
  return (
    <div className={`status-pill ${m.cls}`}>
      <div className="status-dot" />
      <span className="status-label">{m.label}</span>
    </div>
  );
}

function VitalCard({
  meta, value,
}: { meta: ChannelMeta; value: number }) {
  const displayVal = value.toFixed(meta.max > 100 ? 0 : meta.max > 10 ? 1 : 2);
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
}

interface WaveformCellProps {
  meta: ChannelMeta;
  stream: EcmoStreamStateMachine;
  value: number;
  onReady: (index: number) => void;
}

function WaveformCell({ meta, stream, value, onReady }: WaveformCellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EkgScrollRenderer | null>(null);
  const lastPushedRef = useRef(0);

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
    resizeObs.observe(canvas.parentElement!);

    onReady(meta.index);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObs.disconnect();
      renderer.stop();
      renderer.detach();
    };
  }, [meta.index, meta.color, meta.min, meta.max, onReady]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const buf = stream.getChannelBuffer(meta.index);
    if (!buf) return;

    const bufSize = buf.size();
    const newSamples = Math.max(0, bufSize - lastPushedRef.current);
    if (newSamples > 0) {
      renderer.pushBatchFromBuffer(buf, newSamples);
      lastPushedRef.current = bufSize;
    }
  });

  const displayVal = value.toFixed(meta.max > 100 ? 0 : meta.max > 10 ? 1 : 2);

  return (
    <div className="waveform-cell">
      <div className="waveform-header">
        <div className="waveform-title">
          <div className="waveform-color-bar" style={{ background: meta.color }} />
          <span className="waveform-name">{meta.name}</span>
        </div>
        <div className="waveform-readout">
          <span className="readout-value" style={{ color: meta.color }}>{displayVal}</span>
          <span className="readout-unit">{meta.unit}</span>
        </div>
      </div>
      <div className="waveform-canvas-wrap">
        <canvas ref={canvasRef} className="waveform-canvas" />
      </div>
    </div>
  );
}

export default function App() {
  const { meta, status, stats, stream } = useEcmoStream();
  const now = useNowTick();
  const readyChannelsRef = useRef<Set<number>>(new Set());
  const [, forceReady] = useState(0);

  const handleCellReady = useCallback((index: number) => {
    readyChannelsRef.current.add(index);
    forceReady(readyChannelsRef.current.size);
  }, []);

  const orderedChannels = CHANNEL_DISPLAY_ORDER
    .map(i => meta.find(m => m.index === i))
    .filter(Boolean) as ChannelMeta[];

  const vitalIndices = [0, 1, 2, 3, 4, 5, 10, 11];
  const vitals = vitalIndices
    .map(i => meta.find(m => m.index === i))
    .filter(Boolean) as ChannelMeta[];

  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });

  const latencies: { level: 'info' | 'warning' | 'critical'; msg: string }[] = [];
  latencies.push({ level: 'info', msg: `采样率: ${stream.getStatus() === 'connected' ? '500 Hz' : '--'} Hz` });
  latencies.push({ level: 'info', msg: `数据吞吐: ${stats.fps.toLocaleString()} 帧/秒` });
  if (status === 'connected' && stats.fps < 450) {
    latencies.push({ level: 'warning', msg: `吞吐偏低 (${stats.fps}/500)` });
  }
  if (status !== 'connected') {
    latencies.push({ level: 'critical', msg: '信号丢失 - 请检查设备连接' });
  }

  return (
    <div className="app-root">
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
          <div className="vitals-panel">
            <div className="panel-title">
              <h3>关键参数</h3>
              <span className="title-icon">♥</span>
            </div>
            {vitals.map(m => (
              <VitalCard key={m.index} meta={m} value={stream.getLatestValue(m.index)} />
            ))}
          </div>
          <div className="vitals-panel">
            <div className="panel-title">
              <h3>血气指标</h3>
              <span className="title-icon">⚡</span>
            </div>
            {meta.filter(m => !vitalIndices.includes(m.index)).map(m => (
              <VitalCard key={m.index} meta={m} value={stream.getLatestValue(m.index)} />
            ))}
          </div>
        </aside>

        <section className="waveform-area">
          <div className="waveform-grid">
            {orderedChannels.map(m => (
              <WaveformCell
                key={m.index}
                meta={m}
                stream={stream}
                value={stream.getLatestValue(m.index)}
                onReady={handleCellReady}
              />
            ))}
          </div>
        </section>

        <footer className="bottom-alerts">
          {latencies.map((a, i) => (
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
