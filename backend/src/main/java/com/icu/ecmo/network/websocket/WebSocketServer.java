package com.icu.ecmo.network.websocket;

import com.icu.ecmo.config.GatewayConfig;
import com.icu.ecmo.core.DataBus;
import com.icu.ecmo.protocol.EcmoSensorFrame;
import com.icu.ecmo.protocol.WebSocketChunkEncoder;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.HttpServerCodec;
import io.netty.handler.codec.http.websocketx.*;
import io.netty.handler.stream.ChunkedWriteHandler;
import io.netty.util.CharsetUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

public class WebSocketServer {

    private static final Logger logger = LoggerFactory.getLogger(WebSocketServer.class);

    private final GatewayConfig config;
    private final DataBus dataBus;
    private EventLoopGroup bossGroup;
    private EventLoopGroup workerGroup;
    private Channel serverChannel;

    public WebSocketServer(GatewayConfig config) {
        this.config = config;
        this.dataBus = DataBus.getInstance();
    }

    public void start() throws InterruptedException {
        bossGroup = new NioEventLoopGroup(1);
        workerGroup = new NioEventLoopGroup(Runtime.getRuntime().availableProcessors());

        ServerBootstrap b = new ServerBootstrap();
        b.group(bossGroup, workerGroup)
                .channel(NioServerSocketChannel.class)
                .option(ChannelOption.SO_BACKLOG, 128)
                .childOption(ChannelOption.SO_KEEPALIVE, true)
                .childOption(ChannelOption.TCP_NODELAY, true)
                .childOption(ChannelOption.SO_SNDBUF, 1024 * 1024)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(SocketChannel ch) {
                        ch.pipeline()
                                .addLast(new HttpServerCodec())
                                .addLast(new HttpObjectAggregator(65536))
                                .addLast(new ChunkedWriteHandler())
                                .addLast(new WebSocketServerHandler(config, dataBus));
                    }
                });

        ChannelFuture f = b.bind(config.getWsPort()).sync();
        serverChannel = f.channel();
        logger.info("ECMO WebSocket Server started on port {}, path: {}",
                config.getWsPort(), config.getWsPath());
    }

    public void stop() {
        ClientSessionManager.getInstance().closeAll();
        if (serverChannel != null) {
            serverChannel.close().syncUninterruptibly();
        }
        if (workerGroup != null) {
            workerGroup.shutdownGracefully();
        }
        if (bossGroup != null) {
            bossGroup.shutdownGracefully();
        }
        logger.info("ECMO WebSocket Server stopped");
    }
}

class ClientSessionManager {
    private static final ClientSessionManager INSTANCE = new ClientSessionManager();
    private final ConcurrentHashMap<String, ClientSession> sessions = new ConcurrentHashMap<>();

    private ClientSessionManager() {}

    public static ClientSessionManager getInstance() {
        return INSTANCE;
    }

    public void addSession(ClientSession session) {
        sessions.put(session.getId(), session);
    }

    public void removeSession(String id) {
        ClientSession session = sessions.remove(id);
        if (session != null) {
            session.close();
        }
    }

    public void closeAll() {
        for (ClientSession session : sessions.values()) {
            session.close();
        }
        sessions.clear();
    }

    public int getSessionCount() {
        return sessions.size();
    }
}

class ClientSession implements Consumer<EcmoSensorFrame> {
    private static final Logger logger = LoggerFactory.getLogger(ClientSession.class);
    private static final AtomicInteger ID_GENERATOR = new AtomicInteger(0);

    private final String id;
    private final Channel channel;
    private final DataBus dataBus;
    private final int chunkSize;
    private final List<EcmoSensorFrame> chunkBuffer;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private volatile long lastFlushTime = System.nanoTime();
    private static final long FLUSH_INTERVAL_NS = 16_666_666L;

    public ClientSession(Channel channel, DataBus dataBus, int chunkSize) {
        this.id = "session-" + ID_GENERATOR.incrementAndGet();
        this.channel = channel;
        this.dataBus = dataBus;
        this.chunkSize = chunkSize;
        this.chunkBuffer = new ArrayList<>(chunkSize);
    }

    public String getId() {
        return id;
    }

    public void start() {
        sendMetadata();
        dataBus.subscribe(this);
    }

    private void sendMetadata() {
        if (!channel.isActive()) return;
        ByteBuf meta = WebSocketChunkEncoder.encodeMetadata();
        byte[] bytes = new byte[meta.readableBytes()];
        meta.readBytes(bytes);
        meta.release();
        channel.writeAndFlush(new BinaryWebSocketFrame(Unpooled.wrappedBuffer(bytes)));
    }

    @Override
    public void accept(EcmoSensorFrame frame) {
        if (closed.get() || !channel.isActive()) {
            return;
        }

        synchronized (chunkBuffer) {
            chunkBuffer.add(frame);
            long now = System.nanoTime();
            if (chunkBuffer.size() >= chunkSize || (now - lastFlushTime) >= FLUSH_INTERVAL_NS) {
                flushChunkLocked();
                lastFlushTime = now;
            }
        }
    }

    private void flushChunkLocked() {
        if (chunkBuffer.isEmpty()) return;
        List<EcmoSensorFrame> frames = new ArrayList<>(chunkBuffer);
        chunkBuffer.clear();

        ByteBuf chunk = WebSocketChunkEncoder.encodeChunk(frames);
        byte[] bytes = new byte[chunk.readableBytes()];
        chunk.readBytes(bytes);
        chunk.release();

        if (channel.isActive()) {
            channel.writeAndFlush(new BinaryWebSocketFrame(Unpooled.wrappedBuffer(bytes)))
                    .addListener(ChannelFutureListener.FIRE_EXCEPTION_ON_FAILURE);
        }
    }

    public void close() {
        if (closed.compareAndSet(false, true)) {
            dataBus.unsubscribe(this);
            synchronized (chunkBuffer) {
                if (!chunkBuffer.isEmpty()) {
                    flushChunkLocked();
                }
            }
            if (channel.isActive()) {
                try {
                    channel.writeAndFlush(new CloseWebSocketFrame()).syncUninterruptibly();
                } catch (Exception ignored) {}
            }
            logger.debug("Client session {} closed", id);
        }
    }
}

class WebSocketServerHandler extends SimpleChannelInboundHandler<Object> {
    private static final Logger logger = LoggerFactory.getLogger(WebSocketServerHandler.class);

    private final GatewayConfig config;
    private final DataBus dataBus;
    private WebSocketServerHandshaker handshaker;
    private ClientSession session;

    public WebSocketServerHandler(GatewayConfig config, DataBus dataBus) {
        this.config = config;
        this.dataBus = dataBus;
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, Object msg) {
        if (msg instanceof io.netty.handler.codec.http.FullHttpRequest) {
            handleHttpRequest(ctx, (io.netty.handler.codec.http.FullHttpRequest) msg);
        } else if (msg instanceof WebSocketFrame) {
            handleWebSocketFrame(ctx, (WebSocketFrame) msg);
        }
    }

    private void handleHttpRequest(ChannelHandlerContext ctx, io.netty.handler.codec.http.FullHttpRequest req) {
        if (!req.decoderResult().isSuccess()) {
            sendHttpResponse(ctx, req, new io.netty.handler.codec.http.DefaultFullHttpResponse(
                    io.netty.handler.codec.http.HttpVersion.HTTP_1_1,
                    io.netty.handler.codec.http.HttpResponseStatus.BAD_REQUEST));
            return;
        }

        if (!io.netty.handler.codec.http.HttpMethod.GET.equals(req.method())) {
            sendHttpResponse(ctx, req, new io.netty.handler.codec.http.DefaultFullHttpResponse(
                    io.netty.handler.codec.http.HttpVersion.HTTP_1_1,
                    io.netty.handler.codec.http.HttpResponseStatus.FORBIDDEN));
            return;
        }

        String uri = req.uri();
        String expectedPath = config.getWsPath();
        if (!uri.startsWith(expectedPath)) {
            if (uri.equals("/") || uri.equals("/health")) {
                io.netty.handler.codec.http.DefaultFullHttpResponse resp =
                        new io.netty.handler.codec.http.DefaultFullHttpResponse(
                                io.netty.handler.codec.http.HttpVersion.HTTP_1_1,
                                io.netty.handler.codec.http.HttpResponseStatus.OK,
                                Unpooled.copiedBuffer("{\"status\":\"ok\",\"service\":\"ecmo-gateway\"}", CharsetUtil.UTF_8));
                resp.headers().set(io.netty.handler.codec.http.HttpHeaderNames.CONTENT_TYPE, "application/json");
                sendHttpResponse(ctx, req, resp);
                return;
            }
            sendHttpResponse(ctx, req, new io.netty.handler.codec.http.DefaultFullHttpResponse(
                    io.netty.handler.codec.http.HttpVersion.HTTP_1_1,
                    io.netty.handler.codec.http.HttpResponseStatus.NOT_FOUND));
            return;
        }

        String wsUrl = "ws://" + req.headers().get(io.netty.handler.codec.http.HttpHeaderNames.HOST) + uri;
        WebSocketServerHandshakerFactory wsFactory = new WebSocketServerHandshakerFactory(wsUrl, null, true, 20 * 1024 * 1024);
        handshaker = wsFactory.newHandshaker(req);
        if (handshaker == null) {
            WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel());
        } else {
            handshaker.handshake(ctx.channel(), req);
            session = new ClientSession(ctx.channel(), dataBus, config.getChunkSize());
            ClientSessionManager.getInstance().addSession(session);
            session.start();
            logger.info("WebSocket client connected: {}, active sessions: {}",
                    ctx.channel().remoteAddress(), ClientSessionManager.getInstance().getSessionCount());
        }
    }

    private void handleWebSocketFrame(ChannelHandlerContext ctx, WebSocketFrame frame) {
        if (frame instanceof CloseWebSocketFrame) {
            if (session != null) {
                ClientSessionManager.getInstance().removeSession(session.getId());
            }
            handshaker.close(ctx.channel(), (CloseWebSocketFrame) frame.retain());
            logger.info("WebSocket client disconnected: {}, active sessions: {}",
                    ctx.channel().remoteAddress(), ClientSessionManager.getInstance().getSessionCount());
            return;
        }
        if (frame instanceof PingWebSocketFrame) {
            ctx.writeAndFlush(new PongWebSocketFrame(frame.content().retain()));
            return;
        }
        if (frame instanceof PongWebSocketFrame) {
            return;
        }
        if (frame instanceof TextWebSocketFrame) {
            String text = ((TextWebSocketFrame) frame).text();
            logger.debug("Received text frame: {}", text);
            ctx.writeAndFlush(new TextWebSocketFrame("{\"ack\":true}"));
            return;
        }
        if (frame instanceof BinaryWebSocketFrame) {
            logger.debug("Received binary frame, {} bytes", frame.content().readableBytes());
            return;
        }
    }

    private static void sendHttpResponse(ChannelHandlerContext ctx,
                                         io.netty.handler.codec.http.FullHttpRequest req,
                                         io.netty.handler.codec.http.FullHttpResponse res) {
        if (res.status().code() != 200) {
            ByteBuf buf = Unpooled.copiedBuffer(res.status().toString(), CharsetUtil.UTF_8);
            res.content().writeBytes(buf);
            buf.release();
        }
        io.netty.handler.codec.http.HttpUtil.setContentLength(res, res.content().readableBytes());
        ChannelFuture f = ctx.channel().writeAndFlush(res);
        if (!io.netty.handler.codec.http.HttpUtil.isKeepAlive(req) || res.status().code() != 200) {
            f.addListener(ChannelFutureListener.CLOSE);
        }
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        if (session != null) {
            ClientSessionManager.getInstance().removeSession(session.getId());
            logger.info("WebSocket channel closed: {}, active sessions: {}",
                    ctx.channel().remoteAddress(), ClientSessionManager.getInstance().getSessionCount());
        }
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        logger.error("WebSocket handler error", cause);
        if (session != null) {
            ClientSessionManager.getInstance().removeSession(session.getId());
        }
        ctx.close();
    }
}
