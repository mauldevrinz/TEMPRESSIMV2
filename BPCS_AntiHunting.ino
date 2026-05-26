#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>

// ================================================================
// 1. DEFINISI GLOBALS & FORWARD DECLARATION
// ================================================================
class BPCSController;
class StepperValve;
class TimeManager;

BPCSController* globalCtrl    = nullptr;
StepperValve*   globalValve   = nullptr;
TimeManager*    globalTimeMgr = nullptr;

// ================================================================
// 2. CLASS 1: TIME MANAGER (RTC)
// ================================================================
class TimeManager {
  private:
    RTC_DS3231 rtc;
    int _sda, _scl;

  public:
    TimeManager(int sda, int scl) : _sda(sda), _scl(scl) {}

    void begin() {
      Wire.begin(_sda, _scl);
      if (!rtc.begin()) {
        Serial.println("❌ RTC Error!");
      } else {
        rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
        Serial.println("✅ RTC OK & Jam Disinkronkan.");
      }
    }

    void adjustTime(long long epoch) {
      rtc.adjust(DateTime(epoch));
    }

    String getTimestamp() {
      DateTime now = rtc.now();
      DateTime localTime = now + TimeSpan(0, 7, 0, 0); // WIB UTC+7
      char buffer[25];
      sprintf(buffer, "%04d-%02d-%02d %02d:%02d:%02d",
              localTime.year(), localTime.month(), localTime.day(),
              localTime.hour(), localTime.minute(), localTime.second());
      return String(buffer);
    }
};

// ================================================================
// CLASS 2: SENSOR HANDLER (ANTI-HUNTING VERSION)
// ================================================================
class SensorHandler {
  private:
    int pin;
    float vRef, resistor, tMin, tMax, offset;

    // === PARAMETER ANTI-HUNTING ===
    float alpha;                    // EMA coefficient (lebih kecil = lebih smooth)
    static const int AVG_SAMPLES = 16; // Jumlah sample hardware averaging

    // State internal
    float suhuFiltered  = 0.0;
    float suhuTampil    = 0.0;
    float suhuPrev      = 0.0;
    float tegangan      = 0.0;

    // Hysteresis: hanya update jika perubahan melebihi threshold
    static constexpr float HYSTERESIS_THRESHOLD = 0.3f; // °C

  public:
    // -------------------------------------------------------
    // Constructor
    // alpha disarankan 0.03 ~ 0.07 untuk anti-hunting
    // -------------------------------------------------------
    SensorHandler(int p, float vr, float r, float tmin, float tmax, float off, float a)
      : pin(p), vRef(vr), resistor(r), tMin(tmin), tMax(tmax), offset(off), alpha(a) {}

    void begin() {
      analogReadResolution(12);
      analogSetAttenuation(ADC_11db);
    }

    // -------------------------------------------------------
    // update() — Fix 1: Hardware averaging + Fix 2: EMA halus
    // -------------------------------------------------------
    void update() {
      // --- FIX 1: Hardware Multi-Sample Averaging ---
      // Ambil AVG_SAMPLES pembacaan ADC, rata-ratakan
      long sum = 0;
      for (int i = 0; i < AVG_SAMPLES; i++) {
        sum += analogRead(pin);
        delayMicroseconds(120); // Beri jeda antar sample
      }
      int adcAvg = (int)(sum / AVG_SAMPLES);

      // Konversi ADC → Tegangan → Arus → Suhu
      tegangan      = (float)adcAvg * vRef / 4095.0f;
      float arus_mA = (tegangan / resistor) * 1000.0f;
      float rawSuhu;

      if (arus_mA < 4.0f)       rawSuhu = tMin;
      else if (arus_mA > 20.0f) rawSuhu = tMax;
      else                       rawSuhu = ((arus_mA - 4.0f) / 16.0f) * (tMax - tMin) + tMin;

      // --- FIX 2: EMA Filter dengan alpha kecil (0.05) ---
      if (suhuFiltered == 0.0f) suhuFiltered = rawSuhu; // Inisialisasi pertama
      suhuFiltered = alpha * rawSuhu + (1.0f - alpha) * suhuFiltered;

      float candidate = suhuFiltered + offset;

      // --- FIX 3: Hysteresis — hanya update jika berubah > threshold ---
      if (abs(candidate - suhuPrev) >= HYSTERESIS_THRESHOLD) {
        suhuTampil = candidate;
        suhuPrev   = candidate;
      }
      // Jika tidak melewati threshold, suhuTampil tetap nilai sebelumnya
    }

    float getSuhu()     { return suhuTampil; }
    float getTegangan() { return tegangan;   }
};

// ================================================================
// CLASS 3: STEPPER VALVE
// ================================================================
class StepperValve {
  private:
    int  pinDir, pinPwm;
    long minStep, maxStep, currentPosition, rangeStep;

    void pulseStepper(long steps) {
      digitalWrite(pinDir, (steps > 0) ? LOW : HIGH);
      long n = abs(steps);
      for (long i = 0; i < n; i++) {
        digitalWrite(pinPwm, HIGH); delayMicroseconds(800);
        digitalWrite(pinPwm, LOW);  delayMicroseconds(800);
      }
    }

  public:
    StepperValve(int dir, int pwm, long minS, long maxS)
      : pinDir(dir), pinPwm(pwm), minStep(minS), maxStep(maxS) {
      rangeStep       = maxStep - minStep;
      currentPosition = minStep;
    }

    void begin() {
      pinMode(pinDir, OUTPUT);
      pinMode(pinPwm, OUTPUT);
    }

    long percentToStep(float persen) {
      if (persen < 20.0f) persen = 20.0f;
      if (persen > 80.0f) persen = 80.0f;
      float frac = (persen - 20.0f) / 60.0f;
      return minStep + (long)(frac * rangeStep);
    }

    void moveDelta(long delta) {
      pulseStepper(delta);
      currentPosition += delta;
    }

    long getCurrentPosition() { return currentPosition; }

    int getPercent() {
      if (rangeStep == 0) return 0;
      return 20 + (int)((float)(currentPosition - minStep) * 60.0f / rangeStep);
    }
};

// ================================================================
// CLASS 4: BPCS CONTROLLER (ANTI-HUNTING VERSION)
// ================================================================
class BPCSController {
  private:
    float Kp       = 13.0f;
    float setPoint = 105.0f;
    bool  autoMode = true;

    unsigned long lastMove = 0;

    // --- FIX 4: Dead-band diperbesar agar tidak over-react ---
    static constexpr float DEAD_BAND = 2.0f; // °C, naik dari 1.0

    // --- FIX 5: Minimum interval antar gerakan valve (ms) ---
    static constexpr unsigned long MIN_MOVE_INTERVAL = 3000UL; // 3 detik

    // --- FIX 6: Minimum delta step agar tidak micro-stepping ---
    static constexpr long MIN_DELTA_STEP = 20;

  public:
    void setSetPoint(float val) { setPoint = val; }
    void setKp(float val)       { Kp = val;       }
    void setAuto(bool s)        { autoMode = s;   }
    float getSetPoint()         { return setPoint; }

    void update(float temp, StepperValve &v) {
      if (!autoMode) return;
      if (millis() - lastMove < MIN_MOVE_INTERVAL) return;

      float error = setPoint - temp;

      // FIX 4: Dead-band — abaikan error kecil
      if (abs(error) < DEAD_BAND) return;

      float outP   = 20.0f + (error * Kp);
      long  target = v.percentToStep(outP);
      long  delta  = target - v.getCurrentPosition();

      // FIX 6: Hanya gerak jika delta cukup signifikan
      if (abs(delta) > MIN_DELTA_STEP) {
        v.moveDelta(delta);
        lastMove = millis();
      }
    }
};

// ================================================================
// 4. MQTT CALLBACK
// ================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) message += (char)payload[i];

  Serial.println("\n--- 📩 DATA MASUK DARI WEB ---");
  Serial.print("Payload: "); Serial.println(message);

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, message);

  if (!error) {
    // A. Sinkronisasi jam RTC
    if (doc.containsKey("timestamp") && globalTimeMgr != nullptr) {
      long long epoch = doc["timestamp"];
      globalTimeMgr->adjustTime(epoch / 1000);
      Serial.println("⏰ Jam RTC disinkronkan dengan waktu Web.");
    }

    // B. Parameter kontrol
    if (doc.containsKey("parameter")) {
      const char* param = doc["parameter"];
      float val         = doc["value"];

      if (strcmp(param, "temp") == 0) {
        globalCtrl->setSetPoint(val);
        Serial.printf("✅ SETPOINT BARU: %.2f °C\n", val);
      }
      else if (strcmp(param, "kp") == 0) {
        globalCtrl->setKp(val);
        Serial.printf("✅ NILAI KP BARU: %.2f\n", val);
      }
      else if (strcmp(param, "sampling") == 0) {
        Serial.printf("✅ TIME SAMPLING BARU: %.0f Detik\n", val);
      }
      else if (strcmp(param, "mode") == 0) {
        globalCtrl->setAuto(val == 1);
        Serial.printf("✅ MODE: %s\n", (val == 1 ? "AUTO" : "MANUAL"));
      }
      else if (strcmp(param, "stepper_manual") == 0) {
        if (globalCtrl && globalValve) {
          globalCtrl->setAuto(false);
          float pct    = constrain(val, 20.0f, 80.0f);
          long  target = globalValve->percentToStep(pct);
          long  delta  = target - globalValve->getCurrentPosition();
          if (abs(delta) > 10) globalValve->moveDelta(delta);
          Serial.printf("🔧 STEPPER MANUAL: %.0f%%\n", pct);
        }
      }
    }
  } else {
    Serial.println("❌ Gagal parsing JSON dari Web");
  }
  Serial.println("------------------------------\n");
}

// ================================================================
// CLASS 5: NETWORK MANAGER
// ================================================================
class MqttNetworkManager {
  private:
    const char *ssid, *pass, *mqtt_server, *mqtt_user, *mqtt_pass, *topic_pub, *topic_sub;
    int mqtt_port;
    WiFiClientSecure espClient;
    PubSubClient     client;
    unsigned long    lastSend = 0, lastReconnect = 0;

  public:
    MqttNetworkManager(const char* s, const char* p,
                       const char* ms, int mp,
                       const char* mu, const char* mpa,
                       const char* tp, const char* ts)
      : ssid(s), pass(p), mqtt_server(ms), mqtt_port(mp),
        mqtt_user(mu), mqtt_pass(mpa),
        topic_pub(tp), topic_sub(ts),
        client(espClient) {}

    void begin(TimeManager &tm) {
      WiFi.mode(WIFI_STA);
      WiFi.begin(ssid, pass);
      Serial.print("Connecting WiFi");
      int att = 0;
      while (WiFi.status() != WL_CONNECTED && att < 20) {
        delay(1000); Serial.print("."); att++;
      }
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n✅ WiFi OK");
        Serial.print("IP: "); Serial.println(WiFi.localIP());
      } else {
        Serial.println("\n❌ WiFi Fail");
      }

      espClient.setInsecure();
      client.setServer(mqtt_server, mqtt_port);
      client.setCallback(mqttCallback);
    }

    void update() {
      if (WiFi.status() == WL_CONNECTED && !client.connected()
          && millis() - lastReconnect > 10000) {
        lastReconnect = millis();
        String id = "ESP32_Plant_" + String(random(0xffff), HEX);
        if (client.connect(id.c_str(), mqtt_user, mqtt_pass)) {
          client.subscribe(topic_sub);
          Serial.println("✅ MQTT Connected");
        } else {
          Serial.print("❌ MQTT Fail, rc="); Serial.println(client.state());
        }
      }
      if (client.connected()) client.loop();
    }

    void sendData(SensorHandler &s, StepperValve &v, TimeManager &tm) {
      unsigned long now = millis();
      if (now - lastSend >= 5000) {
        lastSend = now;
        if (client.connected()) {
          StaticJsonDocument<512> doc;
          doc["temperature"]     = s.getSuhu();
          doc["voltage"]         = s.getTegangan() * 1000.0f;
          doc["valve_percent"]   = v.getPercent();
          doc["send_timestamp"]  = tm.getTimestamp();

          char buffer[512];
          serializeJson(doc, buffer);

          if (client.publish(topic_pub, buffer)) {
            Serial.print("📤 DATA KELUAR KE WEB: ");
            Serial.println(buffer);
          }
        }
      }
    }
};

// ================================================================
// KONFIGURASI SISTEM
// ================================================================

// --- Sensor: alpha = 0.05 (diturunkan dari 0.15) ---
// Pin, vRef, Resistor, TMin, TMax, Offset, Alpha
SensorHandler sensor(4, 3.334f, 150.0f, 0.0f, 200.0f, 6.2f, 0.05f);
//                                                           ^^^^
//                                  PERUBAHAN: 0.15 → 0.05 (anti-hunting)

StepperValve valve(5, 6, 1169, 4700);
BPCSController controller;
TimeManager timeMgr(8, 9);
MqttNetworkManager network(
  "Laboratorium I & C",                           // SSID
  "tanyamasgani",                                  // Password WiFi
  "daeb68cee1a0470ab4fbd5a4f1691fe8.s1.eu.hivemq.cloud", // MQTT Server
  8883,                                            // MQTT Port
  "auliazqi",                                      // MQTT User
  "Serveradmin123",                                // MQTT Password
  "plant/data/temperature",                        // Topic Publish
  "admin/control/setpoints"                        // Topic Subscribe
);

// ================================================================
// MAIN PROGRAM
// ================================================================
void setup() {
  Serial.begin(115200);

  // Assign pointer global
  globalCtrl    = &controller;
  globalValve   = &valve;
  globalTimeMgr = &timeMgr;

  timeMgr.begin();
  sensor.begin();
  valve.begin();
  network.begin(timeMgr);

  Serial.println("🚀 Sistem Siap! (Anti-Hunting Mode)");
  Serial.println("====================================");
  Serial.println("Fix aktif:");
  Serial.println("  ✅ Hardware averaging 16 sample");
  Serial.println("  ✅ EMA alpha = 0.05");
  Serial.println("  ✅ Hysteresis 0.3°C");
  Serial.println("  ✅ Dead-band controller 2.0°C");
  Serial.println("  ✅ Min move interval 3000ms");
  Serial.println("  ✅ Min delta step 20");
  Serial.println("====================================");
}

void loop() {
  network.update();
  sensor.update();
  controller.update(sensor.getSuhu(), valve);
  network.sendData(sensor, valve, timeMgr);
}
