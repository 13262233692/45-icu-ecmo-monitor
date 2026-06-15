package com.icu.ecmo;

import com.icu.ecmo.config.GatewayConfig;
import com.icu.ecmo.network.tcp.EcmoTcpServer;
import com.icu.ecmo.network.websocket.WebSocketServer;
import com.icu.ecmo.safety.SafetyClampService;
import com.icu.ecmo.simulator.EcmoSimulator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class EcmoGatewayApplication {

    private static final Logger logger = LoggerFactory.getLogger(EcmoGatewayApplication.class);

    private static SafetyClampService safetyClampService;

    public static void main(String[] args) {
        logger.info("================================================");
        logger.info("  ICU ECMO Monitoring Gateway - Starting...");
        logger.info("  High-Reliability Medical Data Platform");
        logger.info("================================================");

        GatewayConfig config = GatewayConfig.load();
        logger.info("Configuration loaded: TCP_PORT={}, WS_PORT={}, SIMULATOR_ENABLED={}",
                config.getTcpPort(), config.getWsPort(), config.isSimulatorEnabled());

        try {
            safetyClampService = new SafetyClampService();
            logger.info("Safety Clamp Service initialized");

            EcmoTcpServer tcpServer = new EcmoTcpServer(config);
            tcpServer.start();

            WebSocketServer wsServer = new WebSocketServer(config, safetyClampService);
            wsServer.start();

            if (config.isSimulatorEnabled()) {
                logger.info("Starting ECMO hardware simulator for testing...");
                EcmoSimulator simulator = new EcmoSimulator(config, safetyClampService);
                simulator.start();
                logger.info("ECMO Simulator started on TCP port {}", config.getTcpPort());
            }

            logger.info("================================================");
            logger.info("  All services started successfully!");
            logger.info("  TCP Gateway    : port {}", config.getTcpPort());
            logger.info("  WebSocket UI   : ws://localhost:{}/ws/ecmo", config.getWsPort());
            logger.info("  Safety Clamp   : ENABLED");
            logger.info("  Press Ctrl+C to shutdown");
            logger.info("================================================");

            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                logger.info("Shutdown hook triggered, closing services...");
                wsServer.stop();
                tcpServer.stop();
                logger.info("All services stopped.");
            }));

            Thread.currentThread().join();
        } catch (Exception e) {
            logger.error("Failed to start ECMO Gateway", e);
            System.exit(1);
        }
    }

    public static SafetyClampService getSafetyClampService() {
        return safetyClampService;
    }
}
