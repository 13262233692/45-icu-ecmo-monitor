package com.icu.ecmo.protocol;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;

import java.util.List;

public class WebSocketChunkEncoder {

    public static final int CHUNK_MAGIC = 0x45434D30;
    public static final int CHUNK_VERSION = 0x01;
    public static final int HEADER_SIZE = 4 + 1 + 2 + 8 + 4 + 4 + 2;

    public static ByteBuf encodeChunk(List<EcmoSensorFrame> frames) {
        int frameCount = frames.size();
        int channelCount = EcmoSensorFrame.CHANNEL_COUNT;
        int frameSize = 8 + 4 + 4 * channelCount;
        int payloadSize = frameCount * frameSize;
        int totalSize = HEADER_SIZE + payloadSize;

        ByteBuf buf = Unpooled.buffer(totalSize);

        buf.writeInt(CHUNK_MAGIC);
        buf.writeByte(CHUNK_VERSION);

        short flags = 0;
        flags |= (1 << 0);
        buf.writeShort(flags);

        long firstTimestamp = frames.isEmpty() ? 0 : frames.get(0).getTimestamp();
        buf.writeLong(firstTimestamp);

        int lastSeq = frames.isEmpty() ? 0 : frames.get(frameCount - 1).getSequence();
        buf.writeInt(lastSeq);

        buf.writeInt(frameCount);

        buf.writeShort(channelCount);

        for (EcmoSensorFrame frame : frames) {
            buf.writeLong(frame.getTimestamp());
            buf.writeInt(frame.getSequence());
            for (float sample : frame.getSamples()) {
                buf.writeFloat(sample);
            }
        }

        return buf;
    }

    public static ByteBuf encodeMetadata() {
        int metaMagic = 0x4D455441;
        int channelCount = EcmoChannel.values().length;
        EcmoChannel[] channels = EcmoChannel.values();

        ByteBuf buf = Unpooled.buffer();
        buf.writeInt(metaMagic);
        buf.writeByte(CHUNK_VERSION);
        buf.writeShort(channelCount);

        for (EcmoChannel ch : channels) {
            buf.writeByte(ch.getIndex());
            byte[] nameBytes = ch.getName().getBytes();
            buf.writeByte(nameBytes.length);
            buf.writeBytes(nameBytes);
            byte[] unitBytes = ch.getUnit().getBytes();
            buf.writeByte(unitBytes.length);
            buf.writeBytes(unitBytes);
            buf.writeFloat(ch.getMin());
            buf.writeFloat(ch.getMax());
            buf.writeInt(ch.getColor());
        }

        return buf;
    }
}
