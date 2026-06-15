package com.icu.ecmo.safety;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.List;
import java.util.function.Consumer;

public class SafetyClampService {

    private static final Logger log = LoggerFactory.getLogger(SafetyClampService.class);

    public enum ClampReason {
        THROMBUS_DETECTED("血栓检测触发"),
        MANUAL_OPERATOR("操作员手动触发"),
        PRESSURE_EXCEEDED("压力超限"),
        HARDWARE_FAULT("硬件故障"),
        SYSTEM_SELF_TEST("系统自检");

        private final String description;

        ClampReason(String description) {
            this.description = description;
        }

        public String getDescription() {
            return description;
        }
    }

    public enum ClampState {
        NORMAL,
        ARMED,
        CLAMPING,
        CLAMPED,
        RELEASING,
        FAULT
    }

    private final AtomicBoolean clamped = new AtomicBoolean(false);
    private final AtomicInteger clampLevel = new AtomicInteger(0);
    private volatile ClampState state = ClampState.NORMAL;
    private volatile ClampReason lastReason = null;
    private volatile long clampTimestamp = 0;
    private volatile double targetPumpRpm = 0;
    private volatile double currentPumpRpm = 4000;

    private final List<Consumer<ClampState>> stateListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<ClampReason>> clampListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<Void>> releaseListeners = new CopyOnWriteArrayList<>();

    private static final double MAX_RPM = 5000;
    private static final double MIN_SAFE_RPM = 1500;
    private static final long CLAMP_RAMP_MS = 300;

    private Thread clampRampThread = null;
    private final Object rampLock = new Object();

    public boolean triggerClamp(ClampReason reason) {
        if (clamped.get()) {
            log.warn("安全钳制已处于激活状态，忽略重复触发: {}", reason);
            return false;
        }

        boolean wasClamped = clamped.getAndSet(true);
        if (wasClamped) {
            return false;
        }

        lastReason = reason;
        clampTimestamp = System.currentTimeMillis();
        setState(ClampState.CLAMPING);

        log.error("================================================");
        log.error("  安全钳制已触发！原因: {}", reason.getDescription());
        log.error("  时间: {}", new java.util.Date());
        log.error("================================================");

        simulateSerialPortClamp();

        startClampRamp();

        clampListeners.forEach(listener -> {
            try {
                listener.accept(reason);
            } catch (Exception e) {
                log.error("Clamp listener error", e);
            }
        });

        return true;
    }

    public boolean releaseClamp() {
        if (!clamped.get()) {
            return false;
        }

        boolean wasClamped = clamped.getAndSet(false);
        if (!wasClamped) {
            return false;
        }

        setState(ClampState.RELEASING);

        log.info("安全钳制解除");

        simulateSerialPortRelease();

        startReleaseRamp();

        releaseListeners.forEach(listener -> {
            try {
                listener.accept(null);
            } catch (Exception e) {
                log.error("Release listener error", e);
            }
        });

        return true;
    }

    private void simulateSerialPortClamp() {
        log.info("[串口模拟] 正在向血泵控制器发送紧急停机指令...");
        log.info("[串口模拟] 指令: 0xAA 0x01 0xFF 0x00 0x55 (EMERGENCY_STOP)");
        log.info("[串口模拟] 校验和: XOR校验通过");

        try {
            Thread.sleep(5);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        log.info("[串口模拟] 血泵控制器 ACK: 0xAA 0x81 0x00 0x55 (已接收)");
    }

    private void simulateSerialPortRelease() {
        log.info("[串口模拟] 正在向血泵控制器发送恢复指令...");
        log.info("[串口模拟] 指令: 0xAA 0x02 0xFF 0x00 0x55 (RESUME)");

        try {
            Thread.sleep(5);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        log.info("[串口模拟] 血泵控制器 ACK: 0xAA 0x82 0x00 0x55 (已接收)");
    }

    private void startClampRamp() {
        synchronized (rampLock) {
            if (clampRampThread != null && clampRampThread.isAlive()) {
                clampRampThread.interrupt();
            }

            clampRampThread = new Thread(() -> {
                try {
                    double startRpm = currentPumpRpm;
                    double targetRpm = Math.max(0, MIN_SAFE_RPM * 0.2);
                    long startTime = System.currentTimeMillis();
                    long duration = CLAMP_RAMP_MS;

                    while (System.currentTimeMillis() - startTime < duration) {
                        double progress = (double) (System.currentTimeMillis() - startTime) / duration;
                        double eased = 1 - Math.pow(1 - progress, 3);
                        currentPumpRpm = startRpm + (targetRpm - startRpm) * eased;
                        Thread.sleep(10);
                    }

                    currentPumpRpm = targetRpm;
                    targetPumpRpm = targetRpm;
                    setState(ClampState.CLAMPED);
                    log.info("安全钳制完成，血泵转速降至: {} RPM", String.format("%.1f", currentPumpRpm));

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }, "clamp-ramp-thread");

            clampRampThread.setDaemon(true);
            clampRampThread.setPriority(Thread.MAX_PRIORITY);
            clampRampThread.start();
        }
    }

    private void startReleaseRamp() {
        synchronized (rampLock) {
            if (clampRampThread != null && clampRampThread.isAlive()) {
                clampRampThread.interrupt();
            }

            clampRampThread = new Thread(() -> {
                try {
                    double startRpm = currentPumpRpm;
                    double targetRpm = 4000;
                    long startTime = System.currentTimeMillis();
                    long duration = 2000;

                    while (System.currentTimeMillis() - startTime < duration) {
                        double progress = (double) (System.currentTimeMillis() - startTime) / duration;
                        double eased = 1 - Math.pow(1 - progress, 2);
                        currentPumpRpm = startRpm + (targetRpm - startRpm) * eased;
                        Thread.sleep(20);
                    }

                    currentPumpRpm = targetRpm;
                    targetPumpRpm = targetRpm;
                    setState(ClampState.NORMAL);
                    log.info("血泵恢复正常运行: {} RPM", String.format("%.1f", currentPumpRpm));

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }, "release-ramp-thread");

            clampRampThread.setDaemon(true);
            clampRampThread.setPriority(Thread.NORM_PRIORITY);
            clampRampThread.start();
        }
    }

    private void setState(ClampState newState) {
        this.state = newState;
        stateListeners.forEach(listener -> {
            try {
                listener.accept(newState);
            } catch (Exception e) {
                log.error("State listener error", e);
            }
        });
    }

    public boolean isClamped() {
        return clamped.get();
    }

    public ClampState getState() {
        return state;
    }

    public ClampReason getLastReason() {
        return lastReason;
    }

    public long getClampTimestamp() {
        return clampTimestamp;
    }

    public double getCurrentPumpRpm() {
        return currentPumpRpm;
    }

    public double getTargetPumpRpm() {
        return targetPumpRpm;
    }

    public int getClampLevel() {
        return clampLevel.get();
    }

    public void onStateChange(Consumer<ClampState> listener) {
        stateListeners.add(listener);
    }

    public void onClamp(Consumer<ClampReason> listener) {
        clampListeners.add(listener);
    }

    public void onRelease(Runnable listener) {
        releaseListeners.add(v -> listener.run());
    }
}
