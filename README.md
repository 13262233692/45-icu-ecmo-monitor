# ICU ECMO 生命支持监护大屏系统

面向重症医学科（ICU）极高可靠性要求的体外膜肺氧合（ECMO）人工心肺机群监护系统。

## 系统架构

```
┌───────────────────────────────────────────────────────────────────┐
│                        ICU ECMO Monitor                           │
├───────────────────────────────────────────────────────────────────┤
│  前端大屏 (React + Offscreen Canvas2D)                             │
│  ├── WebSocket 客户端 (ArrayBuffer 二进制解码)                     │
│  ├── 内存流式状态机 (环形缓冲区 + 12 路数据聚合)                   │
│  └── 双缓冲 EKG 走纸渲染引擎 (12 路联动动态曲线)                   │
├───────────────────────────────────────────────────────────────────┤
│  ↕ WebSocket 隧道 / 二进制分块传输 / 500Hz 分块聚合                │
├───────────────────────────────────────────────────────────────────┤
│  后端网关 (Java Netty)                                            │
│  ├── WebSocketServer (Netty NIO 多线程 + 客户端会话管理)           │
│  ├── DataBus (发布订阅数据总线)                                    │
│  ├── TCP Server (硬件下位机网关)                                   │
│  └── EcmoBinaryFrameDecoder (ReplayingDecoder 按位解析)            │
├───────────────────────────────────────────────────────────────────┤
│  ↕ 自定义二进制协议 / 500Hz 采样 / 12 路生理传感器                 │
├───────────────────────────────────────────────────────────────────┤
│  ECMO 模拟数据发生器 (内建测试模式)                                 │
└───────────────────────────────────────────────────────────────────┘
```

## 技术栈

### 后端（High-Reliability Data Gateway）
- **Java 17** + **Netty 4.1.100**（NIO 事件循环、高性能网络通信）
- TCP 自定义二进制报文解析（ReplayingDecoder 状态机按位解析）
- WebSocket 二进制分块传输（帧聚合 + 定时 flush + 背压控制）
- 发布订阅数据总线（DataBus，线程安全并发分发）
- Slf4j + Logback 日志框架

### 前端（High-Performance Rendering Engine）
- **React 18** + **TypeScript** + **Vite 5**
- WebSocket ArrayBuffer 原生二进制解码（DataView 零拷贝解析）
- **NumericRingBuffer**：Float32Array 环形缓冲区（60s × 500Hz = 30,000 点）
- **EkgScrollRenderer**：
  - 双缓冲离屏 Canvas（Offscreen + Onscreen）
  - 老式医疗心电图走纸特效（擦除重绘 + 无缝滚动）
  - GPU 加速阴影光晕、平滑插值、write-head 发光扫描线
  - 12 路独立滚动互不干扰

## 12 路监测指标

| # | 指标 | 单位 | 正常范围 | 通道色 |
|---|------|------|----------|--------|
| 0 | Pump RPM 离心泵转速 | RPM | 0-5000 | 翠绿 |
| 1 | Pre-Membrane 膜前压 | mmHg | 0-400 | 红色 |
| 2 | Post-Membrane 膜后压 | mmHg | 0-400 | 橙色 |
| 3 | TMP 跨膜压 | mmHg | 0-150 | 金色 |
| 4 | **SvO₂ 血氧饱和度** | % | 60-100 | 亮绿 |
| 5 | Blood Flow 血流量 | L/min | 0-8 | 蓝色 |
| 6 | Arterial pO₂ 动脉氧分压 | mmHg | 50-500 | 紫色 |
| 7 | Venous pO₂ 静脉氧分压 | mmHg | 30-100 | 淡紫 |
| 8 | Arterial pCO₂ 动脉二氧化碳 | mmHg | 20-60 | 粉紫 |
| 9 | Venous pCO₂ 静脉二氧化碳 | mmHg | 30-70 | 洋红 |
| 10 | pH 酸碱度 | - | 7.0-7.8 | 天青 |
| 11 | Temperature 体温 | °C | 34-42 | 琥珀 |

## 快速开始

### 环境要求
- **后端**：JDK 17+、Maven 3.8+
- **前端**：Node.js 18+、npm 9+

### 一键启动

```bash
# Windows
start.bat
# 选择 3 - 启动全部
```

或分两步启动：

#### 1. 启动后端网关（默认开启模拟器）

```bash
cd backend
mvn clean package -DskipTests
java -Xms512m -Xmx2048m -jar target/icu-ecmo-monitor-1.0.0.jar
```

启动后：
- TCP 硬件网关：`localhost:7000`（500Hz 二进制报文）
- WebSocket UI：`ws://localhost:8080/ws/ecmo`
- 健康检查：`http://localhost:8080/health`
- 内置模拟器自动连接并产生 500Hz 测试数据

#### 2. 启动前端大屏

```bash
cd frontend
npm install
npm run dev
```

访问 `http://localhost:3000` 打开监护大屏。

## 协议格式

### TCP → 网关：传感器原始帧

```
┌──────────────┬─────────┬───────────┬─────────────┬──────────────┬─────────────────────┬──────────┐
│ Magic Header │ Version │ Length    │ Timestamp   │ Sequence     │ 12 × Float (48B)    │ Checksum │
│ 0xEC5A (2B)  │ 0x01    │ (2B)      │ 8B          │ 4B           │ Samples             │ 1B (XOR) │
└──────────────┴─────────┴───────────┴─────────────┴──────────────┴─────────────────────┴──────────┘
```

### 网关 → 前端：WebSocket 分块帧

```
┌──────────────┬─────────┬───────────┬─────────────┬──────────────┬────────────┬─────────────┬──────────────────────┐
│ Magic        │ Version │ Flags     │ First TS    │ Last Seq     │ FrameCnt   │ ChCount     │ Frames × (TS+SEQ+S)  │
│ 0x45434D30   │ 1B      │ 2B        │ 8B          │ 4B           │ 4B         │ 2B          │ N × 60B              │
└──────────────┴─────────┴───────────┴─────────────┴──────────────┴────────────┴─────────────┴──────────────────────┘
```

### 元数据帧

```
┌──────────────┬─────────┬───────────────┬────────────────────────────────────────┐
│ Magic 0x4D45│ Version │ ChCount       │ Per-channel: idx|name|unit|min|max|color │
└──────────────┴─────────┴───────────────┴────────────────────────────────────────┘
```

## 项目结构

```
45-icu-ecmo-monitor/
├── backend/
│   ├── pom.xml
│   └── src/main/java/com/icu/ecmo/
│       ├── EcmoGatewayApplication.java     # 主入口
│       ├── config/GatewayConfig.java       # 配置加载
│       ├── core/DataBus.java               # 发布订阅数据总线
│       ├── protocol/
│       │   ├── EcmoChannel.java            # 12 通道元定义
│       │   ├── EcmoSensorFrame.java        # 数据帧模型
│       │   ├── EcmoBinaryFrameDecoder.java # TCP 报文解码状态机
│       │   ├── EcmoBinaryFrameEncoder.java # TCP 报文编码
│       │   └── WebSocketChunkEncoder.java  # WS 分块编码
│       ├── network/
│       │   ├── tcp/EcmoTcpServer.java      # Netty TCP 硬件网关
│       │   └── websocket/WebSocketServer.java  # Netty WS 服务 + 会话管理
│       └── simulator/EcmoSimulator.java    # 硬件模拟器
│
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                         # 监护大屏 UI
│       ├── styles.css                      # 医疗级深色主题
│       └── core/
│           ├── wsClient.ts                 # WS 二进制解码器
│           ├── ringBuffer.ts               # 通用/数值环形缓冲区
│           ├── streamState.ts              # 流式状态机 Facade
│           └── ekgRenderer.ts              # 双缓冲 EKG 走纸渲染引擎
│
├── start-backend.bat / start-frontend.bat / start.bat
└── README.md
```

## 设计亮点

1. **Netty ReplayingDecoder 状态机解析**：针对致密二进制报文，使用多阶段状态机按位精准解析，支持帧头校验、版本校验、XOR 校验，极强容错。

2. **WebSocket 帧聚合**：后端每 50 帧（100ms）或 16.6ms 聚合一次批量发送，前端分块解码避免频繁事件循环，兼顾实时性与带宽效率。

3. **双缓冲离屏 Canvas 走纸**：
   - 离屏 Canvas 只在写头位置局部擦除 3-4px，其余像素整体平移
   - 屏幕 Canvas 单次 drawImage 合成，避免逐像素重绘
   - 发光阴影 + write-head 高亮光晕 + 格线随擦除同步重绘

4. **DataBus 解耦**：TCP / WS / 模拟器 完全通过发布订阅解耦，支持任意数量前端客户端同时订阅一路数据流。

5. **自动重连指数退避**：前端 WebSocket 断线自动重连（1s→2s→4s→8s→10s cap）。
