package com.icu.ecmo.protocol;

public enum EcmoChannel {

    PUMP_RPM(0, "Pump RPM", "RPM", 0f, 5000f, 0x00FF88),
    PRE_MEMBRANE_PRESSURE(1, "Pre-Membrane Pressure", "mmHg", 0f, 400f, 0xFF6B6B),
    POST_MEMBRANE_PRESSURE(2, "Post-Membrane Pressure", "mmHg", 0f, 400f, 0xFFA94D),
    TMP(3, "TMP (Transmembrane)", "mmHg", 0f, 150f, 0xFFD93D),
    SVO2(4, "SvO₂ Saturation", "%", 60f, 100f, 0x6BCB77),
    BLOOD_FLOW(5, "Blood Flow", "L/min", 0f, 8f, 0x4D96FF),
    ARTERIAL_PO2(6, "Arterial pO₂", "mmHg", 50f, 500f, 0x9D4EDD),
    VENOUS_PO2(7, "Venous pO₂", "mmHg", 30f, 100f, 0xC77DFF),
    ARTERIAL_PCO2(8, "Arterial pCO₂", "mmHg", 20f, 60f, 0xE057FD),
    VENOUS_PCO2(9, "Venous pCO₂", "mmHg", 30f, 70f, 0xF72585),
    PH(10, "pH", "", 7.0f, 7.8f, 0x4CC9F0),
    TEMPERATURE(11, "Temperature", "°C", 34f, 42f, 0xFB8500);

    private final int index;
    private final String name;
    private final String unit;
    private final float min;
    private final float max;
    private final int color;

    EcmoChannel(int index, String name, String unit, float min, float max, int color) {
        this.index = index;
        this.name = name;
        this.unit = unit;
        this.min = min;
        this.max = max;
        this.color = color;
    }

    public int getIndex() { return index; }
    public String getName() { return name; }
    public String getUnit() { return unit; }
    public float getMin() { return min; }
    public float getMax() { return max; }
    public int getColor() { return color; }
}
