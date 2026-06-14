package com.icu.ecmo.network.tcp;

import com.icu.ecmo.config.GatewayConfig;
import com.icu.ecmo.core.DataBus;
import com.icu.ecmo.protocol.EcmoBinaryFrameDecoder;
import com.icu.ecmo.protocol.EcmoSensorFrame;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class EcmoTcpServer {

    private static final Logger logger = LoggerFactory.getLogger(EcmoTcpServer.class);

    private final GatewayConfig config;
    private final DataBus dataBus;
    private EventLoopGroup bossGroup;
    private EventLoopGroup workerGroup;
    private Channel serverChannel;

    public EcmoTcpServer(GatewayConfig config) {
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
                .option(ChannelOption.TCP_NODELAY, true)
                .option(ChannelOption.SO_RCVBUF, 1024 * 1024)
                .childOption(ChannelOption.SO_KEEPALIVE, true)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(SocketChannel ch) {
                        ch.pipeline()
                                .addLast(new EcmoBinaryFrameDecoder())
                                .addLast(new TcpDataHandler());
                    }
                });

        ChannelFuture f = b.bind(config.getTcpPort()).sync();
        serverChannel = f.channel();
        logger.info("ECMO TCP Gateway started on port {}", config.getTcpPort());
    }

    public void stop() {
        if (serverChannel != null) {
            serverChannel.close().syncUninterruptibly();
        }
        if (workerGroup != null) {
            workerGroup.shutdownGracefully();
        }
        if (bossGroup != null) {
            bossGroup.shutdownGracefully();
        }
        logger.info("ECMO TCP Gateway stopped");
    }

    @ChannelHandler.Sharable
    private class TcpDataHandler extends SimpleChannelInboundHandler<EcmoSensorFrame> {
        @Override
        protected void channelRead0(ChannelHandlerContext ctx, EcmoSensorFrame frame) {
            dataBus.publish(frame);
        }

        @Override
        public void channelActive(ChannelHandlerContext ctx) {
            logger.info("ECMO hardware device connected: {}", ctx.channel().remoteAddress());
        }

        @Override
        public void channelInactive(ChannelHandlerContext ctx) {
            logger.warn("ECMO hardware device disconnected: {}", ctx.channel().remoteAddress());
        }

        @Override
        public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
            logger.error("TCP connection error", cause);
            ctx.close();
        }
    }
}
