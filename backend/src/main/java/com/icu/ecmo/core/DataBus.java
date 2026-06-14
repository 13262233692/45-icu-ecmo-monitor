package com.icu.ecmo.core;

import com.icu.ecmo.protocol.EcmoSensorFrame;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

public class DataBus {

    private static final Logger logger = LoggerFactory.getLogger(DataBus.class);
    private static final DataBus INSTANCE = new DataBus();

    private final CopyOnWriteArrayList<Consumer<EcmoSensorFrame>> subscribers = new CopyOnWriteArrayList<>();
    private final AtomicInteger frameCount = new AtomicInteger(0);
    private volatile long lastFrameTimestamp = 0;

    private DataBus() {
        startStatsLogger();
    }

    public static DataBus getInstance() {
        return INSTANCE;
    }

    public void subscribe(Consumer<EcmoSensorFrame> subscriber) {
        subscribers.add(subscriber);
        logger.info("New subscriber added. Total subscribers: {}", subscribers.size());
    }

    public void unsubscribe(Consumer<EcmoSensorFrame> subscriber) {
        subscribers.remove(subscriber);
        logger.info("Subscriber removed. Total subscribers: {}", subscribers.size());
    }

    public void publish(EcmoSensorFrame frame) {
        lastFrameTimestamp = System.currentTimeMillis();
        frameCount.incrementAndGet();
        for (Consumer<EcmoSensorFrame> subscriber : subscribers) {
            try {
                subscriber.accept(frame);
            } catch (Exception e) {
                logger.error("Error delivering frame to subscriber", e);
            }
        }
    }

    public int getSubscriberCount() {
        return subscribers.size();
    }

    public long getLastFrameTimestamp() {
        return lastFrameTimestamp;
    }

    private void startStatsLogger() {
        Thread statsThread = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(5000);
                    int count = frameCount.getAndSet(0);
                    if (count > 0) {
                        logger.debug("DataBus stats: {} frames in last 5s ({} Hz), {} subscribers",
                                count, count / 5, subscribers.size());
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }, "DataBus-Stats");
        statsThread.setDaemon(true);
        statsThread.start();
    }
}
