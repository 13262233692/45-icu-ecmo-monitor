package com.icu.ecmo.protocol;

public class EcmoSensorFrame {

    public static final int MAGIC_HEADER = 0xEC5A;
    public static final int FRAME_VERSION = 0x01;
    public static final int CHANNEL_COUNT = 12;

    private long timestamp;
    private int sequence;
    private float[] samples;

    public EcmoSensorFrame() {
        this.samples = new float[CHANNEL_COUNT];
    }

    public EcmoSensorFrame(long timestamp, int sequence, float[] samples) {
        this.timestamp = timestamp;
        this.sequence = sequence;
        this.samples = samples;
    }

    public long getTimestamp() { return timestamp; }
    public void setTimestamp(long timestamp) { this.timestamp = timestamp; }
    public int getSequence() { return sequence; }
    public void setSequence(int sequence) { this.sequence = sequence; }
    public float[] getSamples() { return samples; }
    public void setSamples(float[] samples) { this.samples = samples; }

    public float getPumpRpm() { return samples[0]; }
    public float getPreMembranePressure() { return samples[1]; }
    public float getPostMembranePressure() { return samples[2]; }
    public float getTmp() { return samples[3]; }
    public float getSvo2() { return samples[4]; }
    public float getBloodFlow() { return samples[5]; }
    public float getArterialPo2() { return samples[6]; }
    public float getVenousPo2() { return samples[7]; }
    public float getArterialPco2() { return samples[8]; }
    public float getVenousPco2() { return samples[9]; }
    public float getPh() { return samples[10]; }
    public float getTemperature() { return samples[11]; }
}
