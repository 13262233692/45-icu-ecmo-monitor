package com.icu.ecmo.protocol;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;

public class EcmoBinaryFrameEncoder {

    public static ByteBuf encode(EcmoSensorFrame frame) {
        ByteBuf buf = Unpooled.buffer();
        buf.writeShort(EcmoSensorFrame.MAGIC_HEADER);
        buf.writeByte(EcmoSensorFrame.FRAME_VERSION);
        buf.writeShort((short) (8 + 4 + 4 * EcmoSensorFrame.CHANNEL_COUNT + 1));
        buf.writeLong(frame.getTimestamp());
        buf.writeInt(frame.getSequence());
        for (float sample : frame.getSamples()) {
            buf.writeFloat(sample);
        }
        byte checksum = calculateChecksum(frame);
        buf.writeByte(checksum);
        return buf;
    }

    private static byte calculateChecksum(EcmoSensorFrame frame) {
        long timestamp = frame.getTimestamp();
        int sequence = frame.getSequence();
        float[] samples = frame.getSamples();
        int sum = 0;
        sum ^= (int) (timestamp & 0xFF);
        sum ^= (int) ((timestamp >> 8) & 0xFF);
        sum ^= (int) ((timestamp >> 16) & 0xFF);
        sum ^= (int) ((timestamp >> 24) & 0xFF);
        sum ^= (sequence & 0xFF);
        sum ^= ((sequence >> 8) & 0xFF);
        sum ^= ((sequence >> 16) & 0xFF);
        sum ^= ((sequence >> 24) & 0xFF);
        for (float sample : samples) {
            int bits = Float.floatToIntBits(sample);
            sum ^= (bits & 0xFF);
            sum ^= ((bits >> 8) & 0xFF);
            sum ^= ((bits >> 16) & 0xFF);
            sum ^= ((bits >> 24) & 0xFF);
        }
        return (byte) (sum & 0xFF);
    }
}
