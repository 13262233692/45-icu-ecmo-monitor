package com.icu.ecmo.simulator;

import com.icu.ecmo.config.GatewayConfig;
import com.icu.ecmo.protocol.EcmoBinaryFrameEncoder;
import com.icu.ecmo.protocol.EcmoSensorFrame;
import io.netty.bootstrap.Bootstrap;
import io.netty.buffer.ByteBuf;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

public class EcmoSimulator {

    private static final Logger logger = LoggerFactory.getLogger(EcmoSimulator.class);

    private final GatewayConfig config;
    private EventLoopGroup group;
    private Channel channel;
    private volatile boolean running = false;
    private final AtomicInteger sequence = new AtomicInteger(0);

    public EcmoSimulator(GatewayConfig config) {
        this.config = config;
    }

    public void start() throws InterruptedException {
        group = new NioEventLoopGroup(1);
        Bootstrap b = new Bootstrap();
        b.group(group)
                .channel(NioSocketChannel.class)
                .option(ChannelOption.TCP_NODELAY, true)
                .option(ChannelOption.SO_KEEPALIVE, true)
                .option(ChannelOption.SO_SNDBUF, 2 * 1024 * 1024)
                .handler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(SocketChannel ch) {
                    }
                });

        int attempts = 0;
        while (attempts < 10) {
            try {
                ChannelFuture f = b.connect("127.0.0.1", config.getTcpPort()).sync();
                channel = f.channel();
                running = true;
                startDataGenerator();
                return;
            } catch (Exception e) {
                attempts++;
                logger.warn("Simulator connection attempt {} failed, retrying...", attempts);
                Thread.sleep(500);
            }
        }
        logger.error("Simulator failed to connect to TCP gateway after {} attempts", attempts);
    }

    private void startDataGenerator() {
        int sampleRate = config.getSampleRate();
        long intervalNanos = 1_000_000_000L / sampleRate;

        Thread genThread = new Thread(() -> {
            logger.info("ECMO Simulator data generator started at {} Hz", sampleRate);

            double[] phases = new double[EcmoSensorFrame.CHANNEL_COUNT];
            double[] baseValues = new double[EcmoSensorFrame.CHANNEL_COUNT];
            double[] amplitudes = new double[EcmoSensorFrame.CHANNEL_COUNT];
            double[] frequencies = new double[EcmoSensorFrame.CHANNEL_COUNT];

            baseValues[0] = 3200;    amplitudes[0] = 150;   frequencies[0] = 0.2;
            baseValues[1] = 260;     amplitudes[1] = 15;    frequencies[1] = 1.2;
            baseValues[2] = 140;     amplitudes[2] = 12;    frequencies[2] = 1.2;
            baseValues[3] = 120;     amplitudes[3] = 8;     frequencies[3] = 1.2;
            baseValues[4] = 82;      amplitudes[4] = 3;     frequencies[4] = 0.3;
            baseValues[5] = 4.5f;    amplitudes[5] = 0.4;   frequencies[5] = 0.5;
            baseValues[6] = 380;     amplitudes[6] = 25;    frequencies[6] = 0.8;
            baseValues[7] = 55;      amplitudes[7] = 5;     frequencies[7] = 0.8;
            baseValues[8] = 38;      amplitudes[8] = 3;     frequencies[8] = 0.6;
            baseValues[9] = 46;      amplitudes[9] = 4;     frequencies[9] = 0.6;
            baseValues[10] = 7.38;   amplitudes[10] = 0.03; frequencies[10] = 0.2;
            baseValues[11] = 37.2;   amplitudes[11] = 0.3;  frequencies[11] = 0.15;

            long startTime = System.nanoTime();
            long nextTick = startTime;
            int batchSize = 5;
            float[] samples = new float[EcmoSensorFrame.CHANNEL_COUNT];

            while (running && !Thread.currentThread().isInterrupted()) {
                long now = System.nanoTime();
                if (now < nextTick) {
                    long sleepMs = (nextTick - now) / 1_000_000;
                    if (sleepMs > 0) {
                        try { Thread.sleep(sleepMs); } catch (InterruptedException e) { return; }
                    }
                    continue;
                }

                try {
                    for (int batch = 0; batch < batchSize; batch++) {
                        long timestamp = System.currentTimeMillis();
                        int seq = sequence.getAndIncrement();
                        double t = (nextTick - startTime) / 1_000_000_000.0;
                        ThreadLocalRandom rng = ThreadLocalRandom.current();

                        for (int i = 0; i < EcmoSensorFrame.CHANNEL_COUNT; i++) {
                            phases[i] = t * frequencies[i] * 2 * Math.PI;
                            double noise = (rng.nextDouble() - 0.5) * amplitudes[i] * 0.1;
                            samples[i] = (float) (baseValues[i]
                                    + Math.sin(phases[i]) * amplitudes[i]
                                    + Math.sin(phases[i] * 2.3 + 0.5) * amplitudes[i] * 0.3
                                    + Math.sin(phases[i] * 0.47) * amplitudes[i] * 0.2
                                    + noise);
                        }

                        EcmoSensorFrame frame = new EcmoSensorFrame(timestamp, seq, samples.clone());
                        ByteBuf buf = EcmoBinaryFrameEncoder.encode(frame);
                        if (channel != null && channel.isActive()) {
                            channel.writeAndFlush(buf);
                        }
                        nextTick += intervalNanos;
                    }
                } catch (Exception e) {
                    if (running) {
                        logger.error("Simulator generator error", e);
                    }
                }
            }
            logger.info("ECMO Simulator data generator stopped");
        }, "ECMO-Simulator-Generator");
        genThread.setDaemon(true);
        genThread.setPriority(Thread.MAX_PRIORITY);
        genThread.start();
    }

    public void stop() {
        running = false;
        if (channel != null) {
            channel.close().syncUninterruptibly();
        }
        if (group != null) {
            group.shutdownGracefully();
        }
        logger.info("ECMO Simulator stopped");
    }
}
