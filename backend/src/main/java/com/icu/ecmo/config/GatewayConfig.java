package com.icu.ecmo.config;

public class GatewayConfig {

    private int tcpPort = 7000;
    private int wsPort = 8080;
    private String wsPath = "/ws/ecmo";
    private boolean simulatorEnabled = true;
    private int sampleRate = 500;
    private int chunkSize = 50;
    private int channelCount = 12;

    public static GatewayConfig load() {
        GatewayConfig config = new GatewayConfig();
        String tcpPort = System.getProperty("gateway.tcp.port");
        String wsPort = System.getProperty("gateway.ws.port");
        String simulator = System.getProperty("gateway.simulator.enabled");
        if (tcpPort != null) config.setTcpPort(Integer.parseInt(tcpPort));
        if (wsPort != null) config.setWsPort(Integer.parseInt(wsPort));
        if (simulator != null) config.setSimulatorEnabled(Boolean.parseBoolean(simulator));
        return config;
    }

    public int getTcpPort() { return tcpPort; }
    public void setTcpPort(int tcpPort) { this.tcpPort = tcpPort; }
    public int getWsPort() { return wsPort; }
    public void setWsPort(int wsPort) { this.wsPort = wsPort; }
    public String getWsPath() { return wsPath; }
    public void setWsPath(String wsPath) { this.wsPath = wsPath; }
    public boolean isSimulatorEnabled() { return simulatorEnabled; }
    public void setSimulatorEnabled(boolean simulatorEnabled) { this.simulatorEnabled = simulatorEnabled; }
    public int getSampleRate() { return sampleRate; }
    public int getChunkSize() { return chunkSize; }
    public int getChannelCount() { return channelCount; }
}
