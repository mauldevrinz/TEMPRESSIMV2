/*
 * SIS.ino — Safety Instrumented System (ESP32)
 * Updated: Temperature-based SV1 Control
 * 
 * MQTT Topics:
 *   Publish : plant/data/pressure   → JSON { pressure, voltage, sv1_state, sv2_state, alarm_status }
 *   Subscribe: admin/control/sis    → JSON { parameter, value } for manual/limits
 *              admin/control/setpoints → JSON { parameter: "temp", value: 105 } for setpoint
 *              plant/data/temperature  → JSON { temperature: 85.5 } from BPCS Arduino
 * 
 * Temperature Control Logic:
 *   - Receives actual temperature from BPCS Arduino via plant/data/temperature
 *   - Receives setpoint from frontend via admin/control/setpoints
 *   - When tempSetpoint > 0:
 *     * If actualTemp >= setpoint → CLOSE SV1 (stop heating)
 *     * If actualTemp < setpoint → OPEN SV1 (allow heating)
 *   - Safety shutdown always takes priority
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ===== PIN DEFINISI =====
const int ADC_PIN         = 4;
const int RELAY1_PIN      = 2;
const int RELAY2_PIN      = 1;
const int BUZZER_PIN      = 40;
const int SWITCH_FAIL_PIN = 41;

// ===== ADC =====
const float ADC_REF_V = 3.3f;
const int   ADC_MAX   = 4095;

// ===== SENSOR KALIBRATION =====
const float V_ZERO = 0.417f;   // Tegangan offset sensor pada 0 Bar

// ===== DEFAULT SETPOINT =====
float alarmPressure    = 1.0f;
float shutdownPressure = 1.3f;
float tempSetpoint     = 0.0f;  // Temperature setpoint from frontend
float actualTemp       = 0.0f;  // Actual temperature from BPCS Arduino

// ===== HYSTERESIS =====
const float ALARM_HYSTERESIS    = 0.15f;
const float SHUTDOWN_HYSTERESIS = 0.15f;
const float TEMP_HYSTERESIS     = 2.0f;  // 2°C hysteresis for temp control

// ===== DEBOUNCING ALARM & SHUTDOWN =====
const int           DEBOUNCE_SAMPLES  = 12;
const unsigned long DEBOUNCE_INTERVAL = 100;   // ms

// ===== DEBOUNCING SWITCH FAIL =====
const int           SWITCH_DEBOUNCE_SAMPLES  = 3;
const unsigned long SWITCH_DEBOUNCE_INTERVAL = 50;   // ms

const bool REDUNDANT_SAMPLES = true;

// ===== ADVANCED FILTERING (5-STAGE) =====
const int   HARDWARE_OVERSAMPLING = 8;
const int   MEDIAN_FILTER_SIZE    = 5;
const int   MOVING_AVG_SIZE       = 15;
const float SPIKE_THRESHOLD       = 0.25f;

// ===== WIFI & MQTT CONFIG =====
const char* WIFI_SSID  = "Laboratorium I & C";
const char* WIFI_PASS  = "tanyamasgani";
const char* MQTT_HOST  = "daeb68cee1a0470ab4fbd5a4f1691fe8.s1.eu.hivemq.cloud";
const int   MQTT_PORT  = 8883;
const char* MQTT_USER  = "auliazqi";
const char* MQTT_PASS  = "Serveradmin123";
const char* TOPIC_PUB  = "plant/data/pressure";
const char* TOPIC_SUB_SIS  = "admin/control/sis";
const char* TOPIC_SUB_SETPOINT = "admin/control/setpoints";  // Setpoint from frontend
const char* TOPIC_SUB_TEMP = "plant/data/temperature";  // Temperature from BPCS Arduino

WiFiClientSecure espClient;
PubSubClient     mqttClient(espClient);

unsigned long lastMqttReconnect = 0;
unsigned long lastMqttPublish   = 0;
const unsigned long MQTT_PUB_INTERVAL = 5000;   // Publish every 5 seconds

// ===== SECTION CONTROL: Manual Override =====
bool sv1ManualOverride = false;
bool sv2ManualOverride = false;
bool tempControlActive = false;  // NEW: Flag for temperature control mode

// ===== STATE VARIABEL =====
float tekanan          = 0.0f;
float voltage          = 0.0f;
float lastValidPressure = 0.0f;

String SV1state   = "OPEN";
String SV2state   = "OPEN";
String alarmState = "OFF";

bool alarmActive    = false;
bool shutdownActive = false;

// ===== FILTER BUFFERS =====
float medianBuffer[MEDIAN_FILTER_SIZE];
int   medianIndex = 0;

float movingAvgBuffer[MOVING_AVG_SIZE];
int   movingAvgIndex  = 0;
bool  movingAvgFilled = false;

// ===== SWITCH FAIL VARS =====
bool          sv1Fail              = false;
int           switchFailCount      = 0;
unsigned long switchLastSampleTime = 0;
bool          lastSwitchState      = false;

// ===== DEBOUNCING ALARM =====
int           alarmSampleCount     = 0;
unsigned long alarmLastSampleTime  = 0;
bool          alarmBelowThreshold  = true;

// ===== DEBOUNCING SHUTDOWN =====
int           shutdownSampleCount    = 0;
unsigned long shutdownLastSampleTime = 0;
bool          shutdownBelowThreshold = true;

// ===== DEBOUNCING TEMPERATURE CONTROL (NEW) =====
int           tempSampleCount     = 0;
unsigned long tempLastSampleTime  = 0;
bool          tempBelowThreshold  = true;

// ===== SERIAL OUTPUT TIMING =====
unsigned long lastSerial = 0;

// =====================================================
// SECTION CONTROL HELPERS
// =====================================================
bool isManualActive() { return sv1ManualOverride || sv2ManualOverride; }

void setManualSV1(bool close) {
  sv1ManualOverride = close;
  digitalWrite(RELAY1_PIN, close ? HIGH : LOW);
  SV1state = close ? "CLOSE" : "OPEN";
}

void setManualSV2(bool close) {
  sv2ManualOverride = close;
  digitalWrite(RELAY2_PIN, close ? HIGH : LOW);
  SV2state = close ? "CLOSE" : "OPEN";
}

// =====================================================
// MQTT CALLBACK (UPDATED)
// =====================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.printf("\n[MQTT IN] Topic: %s, Msg: %s\n", topic, msg.c_str());

  // Handle temperature data from BPCS Arduino
  if (strcmp(topic, TOPIC_SUB_TEMP) == 0) {
    StaticJsonDocument<256> doc;
    if (deserializeJson(doc, msg) == DeserializationError::Ok) {
      if (doc.containsKey("temperature")) {
        actualTemp = doc["temperature"];
        Serial.printf("🌡️ Actual Temperature: %.2f°C\n", actualTemp);
      }
    }
    return;
  }

  // Handle control parameters (setpoint, pressure limits, manual control)
  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, msg) != DeserializationError::Ok) {
    Serial.println("❌ JSON parse error");
    return;
  }

  if (!doc.containsKey("parameter")) return;

  const char* param = doc["parameter"];
  float val = doc["value"] | 0.0f;

  if (strcmp(param, "pressure_pahh") == 0) {
    shutdownPressure = val;
    Serial.printf("✅ Shutdown limit → %.2f Bar\n", val);

  } else if (strcmp(param, "pressure_pah") == 0) {
    alarmPressure = val;
    Serial.printf("✅ Alarm limit → %.2f Bar\n", val);

  } else if (strcmp(param, "sv1_manual") == 0) {
    setManualSV1(val == 1);
    Serial.printf("🔧 SV1 MANUAL → %s\n", val == 1 ? "CLOSE" : "OPEN");

  } else if (strcmp(param, "sv2_manual") == 0) {
    setManualSV2(val == 1);
    Serial.printf("🔧 SV2 MANUAL → %s\n", val == 1 ? "CLOSE" : "OPEN");

  } else if (strcmp(param, "temp") == 0) {
    tempSetpoint = val;
    if (tempSetpoint > 0) {
      Serial.printf("✅ Temperature Setpoint → %.2f°C | Control ACTIVE\n", val);
    } else {
      Serial.printf("✅ Temperature Control DISABLED\n");
    }
  }
}

// =====================================================
// WIFI & MQTT
// =====================================================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("🔌 Connecting WiFi");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ WiFi OK — IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n⚠ WiFi GAGAL — mode Serial-only");
  }
}

void mqttReconnect() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;
  if (millis() - lastMqttReconnect < 5000) return;
  lastMqttReconnect = millis();

  String clientId = "ESP32_SIS_" + String(random(0xffff), HEX);
  if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    mqttClient.subscribe(TOPIC_SUB_SIS);
    mqttClient.subscribe(TOPIC_SUB_SETPOINT);
    mqttClient.subscribe(TOPIC_SUB_TEMP);
    Serial.println("✅ MQTT Connected, Subscribed to:");
    Serial.printf("   - %s\n", TOPIC_SUB_SIS);
    Serial.printf("   - %s\n", TOPIC_SUB_SETPOINT);
    Serial.printf("   - %s\n", TOPIC_SUB_TEMP);
  } else {
    Serial.printf("❌ MQTT Fail rc=%d\n", mqttClient.state());
  }
}

// =====================================================
// PIPELINE FILTERING — 5 STAGES
// =====================================================
float oversampledADC() {
  long sum = 0;
  for (int i = 0; i < HARDWARE_OVERSAMPLING; i++) {
    sum += analogRead(ADC_PIN);
    delayMicroseconds(100);
  }
  return (float)sum / HARDWARE_OVERSAMPLING;
}

float medianFilter(float newValue) {
  medianBuffer[medianIndex] = newValue;
  medianIndex = (medianIndex + 1) % MEDIAN_FILTER_SIZE;

  float sorted[MEDIAN_FILTER_SIZE];
  memcpy(sorted, medianBuffer, sizeof(medianBuffer));
  for (int i = 0; i < MEDIAN_FILTER_SIZE - 1; i++) {
    for (int j = i + 1; j < MEDIAN_FILTER_SIZE; j++) {
      if (sorted[i] > sorted[j]) { float t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t; }
    }
  }
  return sorted[MEDIAN_FILTER_SIZE / 2];
}

float spikeRejection(float newValue) {
  if (lastValidPressure == 0.0f) { lastValidPressure = newValue; return newValue; }
  if (abs(newValue - lastValidPressure) > SPIKE_THRESHOLD) return lastValidPressure;
  lastValidPressure = newValue;
  return newValue;
}

float movingAverage(float newValue) {
  movingAvgBuffer[movingAvgIndex] = newValue;
  movingAvgIndex = (movingAvgIndex + 1) % MOVING_AVG_SIZE;
  if (!movingAvgFilled && movingAvgIndex == 0) movingAvgFilled = true;
  int count = movingAvgFilled ? MOVING_AVG_SIZE : (movingAvgIndex > 0 ? movingAvgIndex : 1);
  float sum = 0;
  for (int i = 0; i < count; i++) sum += movingAvgBuffer[i];
  return sum / count;
}

float adcToVoltage(float raw) {
  return (raw / (float)ADC_MAX) * ADC_REF_V;
}

// =====================================================
// DEBOUNCING FUNCTIONS
// =====================================================
void updateSwitchFailDebounce() {
  unsigned long now = millis();
  if (now - switchLastSampleTime < SWITCH_DEBOUNCE_INTERVAL) return;
  switchLastSampleTime = now;
  bool current = (digitalRead(SWITCH_FAIL_PIN) == LOW);
  if (current == lastSwitchState) {
    if (++switchFailCount >= SWITCH_DEBOUNCE_SAMPLES) { sv1Fail = current; switchFailCount = SWITCH_DEBOUNCE_SAMPLES; }
  } else { lastSwitchState = current; switchFailCount = 0; }
}

void updateAlarmDebounce() {
  unsigned long now = millis();
  if (now - alarmLastSampleTime < DEBOUNCE_INTERVAL) return;
  alarmLastSampleTime = now;

  float onT  = alarmPressure;
  float offT = alarmPressure - ALARM_HYSTERESIS;
  bool high  = (tekanan >= onT && alarmBelowThreshold) || (tekanan > offT && !alarmBelowThreshold);

  if (high) {
    if (++alarmSampleCount >= DEBOUNCE_SAMPLES) {
      if (!alarmActive) { alarmActive = true; digitalWrite(BUZZER_PIN, HIGH); alarmState = "ON"; }
      alarmBelowThreshold = false;
    }
  } else {
    alarmSampleCount = 0;
    if (alarmActive && tekanan < offT) {
      alarmActive = false; digitalWrite(BUZZER_PIN, LOW); alarmState = "OFF"; alarmBelowThreshold = true;
    }
  }
}

void updateShutdownDebounce() {
  unsigned long now = millis();
  if (now - shutdownLastSampleTime < DEBOUNCE_INTERVAL) return;
  shutdownLastSampleTime = now;

  float onT  = shutdownPressure;
  float offT = shutdownPressure - SHUTDOWN_HYSTERESIS;
  bool high  = (tekanan >= onT && shutdownBelowThreshold) || (tekanan > offT && !shutdownBelowThreshold);

  if (high) {
    if (++shutdownSampleCount >= DEBOUNCE_SAMPLES) { shutdownActive = true; shutdownBelowThreshold = false; }
  } else {
    shutdownSampleCount = 0;
    if (shutdownActive && tekanan < offT) { shutdownActive = false; shutdownBelowThreshold = true; }
  }
}

// ===== NEW: Temperature Control Debounce =====
void updateTempControlDebounce() {
  unsigned long now = millis();
  if (now - tempLastSampleTime < DEBOUNCE_INTERVAL) return;
  tempLastSampleTime = now;

  if (!tempControlActive) return;  // Only if temp control is enabled

  float onT  = tempSetpoint;
  float offT = tempSetpoint - TEMP_HYSTERESIS;
  bool high  = (tekanan >= onT && tempBelowThreshold) || (tekanan > offT && !tempBelowThreshold);

  if (high) {
    if (++tempSampleCount >= DEBOUNCE_SAMPLES) {
      tempBelowThreshold = false;
    }
  } else {
    tempSampleCount = 0;
    if (tekanan < offT) { tempBelowThreshold = true; }
  }
}

// =====================================================
// SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  pinMode(RELAY1_PIN,     OUTPUT);
  pinMode(RELAY2_PIN,     OUTPUT);
  pinMode(BUZZER_PIN,     OUTPUT);
  pinMode(SWITCH_FAIL_PIN, INPUT_PULLUP);

  digitalWrite(RELAY1_PIN, LOW);
  digitalWrite(RELAY2_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  sv1Fail        = (digitalRead(SWITCH_FAIL_PIN) == LOW);
  lastSwitchState = sv1Fail;

  memset(medianBuffer,    0, sizeof(medianBuffer));
  memset(movingAvgBuffer, 0, sizeof(movingAvgBuffer));

  connectWiFi();
  espClient.setInsecure();
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  Serial.println("\n🚀 SIS READY — Pressure Control + Temperature Setpoint Mode");
}

// =====================================================
// LOOP (UPDATED)
// =====================================================
void loop() {
  // --- 1. MQTT keepalive ---
  mqttReconnect();
  if (mqttClient.connected()) mqttClient.loop();

  // --- 2. Switch fail debounce ---
  updateSwitchFailDebounce();

  // --- 3. Serial command (bench testing) ---
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.replace(',', '.');
    if (cmd.startsWith("SET_PRESS=")) {
      shutdownPressure = cmd.substring(10).toFloat();
      Serial.printf("[SER] Shutdown → %.2f Bar\n", shutdownPressure);
    }
    if (cmd.startsWith("SET_ALARM=")) {
      alarmPressure = cmd.substring(10).toFloat();
      Serial.printf("[SER] Alarm → %.2f Bar\n", alarmPressure);
    }
    if (cmd.startsWith("SET_TEMP=")) {
      tempSetpoint = cmd.substring(9).toFloat();
      tempControlActive = (tempSetpoint > 0);
      Serial.printf("[SER] Temp Setpoint → %.2f°C\n", tempSetpoint);
    }
  }

  // --- 4. PIPELINE FILTERING (5-Stage) ---
  float adcRaw = oversampledADC();
  voltage           = adcToVoltage(adcRaw);
  float v_corrected = voltage - V_ZERO;
  if (v_corrected < 0) v_corrected = 0;
  float rawPressure = 3.36405f * v_corrected;
  if (rawPressure < 0.02f) rawPressure = 0.0f;
  if (rawPressure > 2.5f)  rawPressure = 2.5f;
  float med = medianFilter(rawPressure);
  float spiked = spikeRejection(med);
  tekanan = movingAverage(spiked);

  // --- 5. SAFETY LOGIC ---
  updateAlarmDebounce();
  updateShutdownDebounce();

  // --- 6. ACTUATOR OUTPUT (UPDATED: Temperature-based control) ---
  if (!isManualActive()) {
    if (shutdownActive || rawPressure >= 1.2f) {
      // Safety shutdown priority
      digitalWrite(RELAY1_PIN, LOW);  SV1state = "OPEN";
      digitalWrite(RELAY2_PIN, HIGH); SV2state = "CLOSE";
    } 
    else if (tempSetpoint > 0) {
      // Temperature setpoint control mode
      // Logic: if actual_temp >= setpoint → CLOSE SV1, else → OPEN SV1
      if (actualTemp >= tempSetpoint) {
        // Reached setpoint: CLOSE SV1 to stop heating
        digitalWrite(RELAY1_PIN, HIGH); SV1state = "CLOSE";
        digitalWrite(RELAY2_PIN, LOW);  SV2state = "OPEN";
      } else {
        // Below setpoint: OPEN SV1 to allow heating
        digitalWrite(RELAY1_PIN, LOW);  SV1state = "OPEN";
        digitalWrite(RELAY2_PIN, LOW);  SV2state = "OPEN";
      }
    }
    else {
      // Normal operation (no setpoint)
      digitalWrite(RELAY1_PIN, LOW);  SV1state = "OPEN";
      digitalWrite(RELAY2_PIN, LOW);  SV2state = "OPEN";
    }
  }

  // --- 7. SERIAL OUTPUT (100 ms) ---
  unsigned long now = millis();
  if (now - lastSerial >= 100) {
    lastSerial = now;
    Serial.print(tekanan, 2); Serial.print(",");
    Serial.print(voltage, 3); Serial.print(",");
    Serial.print(SV1state);   Serial.print(",");
    Serial.print(SV2state);   Serial.print(",");
    Serial.print(alarmState); Serial.print(",");
    Serial.printf("TempCtrl:%s(%.2f)", tempControlActive ? "ON" : "OFF", tempSetpoint);
    Serial.println();
  }

  // --- 8. MQTT PUBLISH (every 5 s) ---
  if (now - lastMqttPublish >= MQTT_PUB_INTERVAL && mqttClient.connected()) {
    lastMqttPublish = now;

    StaticJsonDocument<256> doc;
    doc["pressure"]        = serialized(String(tekanan, 2));
    doc["voltage"]         = serialized(String(voltage, 3));
    doc["sv1_state"]       = SV1state;
    doc["sv2_state"]       = SV2state;
    doc["alarm_status"]    = alarmState;
    doc["shutdown_active"] = shutdownActive;
    doc["temp_control"]    = tempControlActive;
    doc["temp_setpoint"]   = serialized(String(tempSetpoint, 2));

    char buf[256];
    serializeJson(doc, buf);
    mqttClient.publish(TOPIC_PUB, buf, true);
    Serial.printf("[MQTT OUT] %s\n", buf);
  }

  delay(30);
}
