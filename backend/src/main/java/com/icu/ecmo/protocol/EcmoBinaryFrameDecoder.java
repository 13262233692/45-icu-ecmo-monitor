package com.icu.ecmo.protocol;

import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.ReplayingDecoder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;

public class EcmoBinaryFrameDecoder extends ReplayingDecoder<EcmoBinaryFrameDecoder.DecodeState> {

    private static final Logger logger = LoggerFactory.getLogger(EcmoBinaryFrameDecoder.class);

    public enum DecodeState {
        MAGIC_HEADER,
        VERSION_LENGTH,
        TIMESTAMP_SEQ,
        SAMPLES,
        CHECKSUM
    }

    private int magicHeader;
    private byte version;
    private short payloadLength;
    private long timestamp;
    private int sequence;
    private float[] samples;
    private byte checksum;

    public EcmoBinaryFrameDecoder() {
        super(DecodeState.MAGIC_HEADER);
    }

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
        switch (state()) {
            case MAGIC_HEADER:
                magicHeader = in.readUnsignedShort();
                if (magicHeader != EcmoSensorFrame.MAGIC_HEADER) {
                    logger.warn("Invalid magic header: 0x{}, expected 0xEC5A",
                            Integer.toHexString(magicHeader));
                    in.skipBytes(actualReadableBytes());
                    return;
                }
                checkpoint(DecodeState.VERSION_LENGTH);
            case VERSION_LENGTH:
                version = in.readByte();
                payloadLength = in.readShort();
                if (version != EcmoSensorFrame.FRAME_VERSION) {
                    logger.warn("Unsupported frame version: {}", version);
                    in.skipBytes(payloadLength);
                    resetState();
                    return;
                }
                checkpoint(DecodeState.TIMESTAMP_SEQ);
            case TIMESTAMP_SEQ:
                timestamp = in.readLong();
                sequence = in.readInt();
                checkpoint(DecodeState.SAMPLES);
            case SAMPLES:
                int channelCount = EcmoSensorFrame.CHANNEL_COUNT;
                samples = new float[channelCount];
                for (int i = 0; i < channelCount; i++) {
                    samples[i] = in.readFloat();
                }
                checkpoint(DecodeState.CHECKSUM);
            case CHECKSUM:
                checksum = in.readByte();
                byte calculatedChecksum = calculateChecksum(timestamp, sequence, samples);
                if (checksum != calculatedChecksum) {
                    logger.warn("Checksum mismatch: frame={}, calculated={}",
                            checksum, calculatedChecksum);
                    resetState();
                    return;
                }
                EcmoSensorFrame frame = new EcmoSensorFrame(timestamp, sequence, samples);
                out.add(frame);
                resetState();
                break;
            default:
                throw new IllegalStateException("Unknown decode state: " + state());
        }
    }

    private byte calculateChecksum(long timestamp, int sequence, float[] samples) {
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

    private void resetState() {
        checkpoint(DecodeState.MAGIC_HEADER);
    }
}
