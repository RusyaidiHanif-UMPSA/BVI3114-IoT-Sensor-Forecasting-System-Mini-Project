/*************************************************************
 *  ESP32 SENSOR DATA TO GOOGLE SHEETS (FINAL - FULLY WORKING)
 *  December 31, 2025 - Tested & Verified
 *
 *  Key Features:
 *  - Reliable GET upload (fixes HTTP 400 redirect bug)
 *  - Accurate timestamps using NTP (real date/time, not 1970)
 *  - Malaysia timezone (UTC+8) - change if needed
 *  - Median-filtered ultrasonic distance
 *  - Robust BME280 init + validation
 *  - Modern watchdog (Arduino-ESP32 core 3.x+)
 *  - Clear LED status & serial feedback
 *************************************************************/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <esp_task_wdt.h>

// --- NEW: NTP for real timestamps ---
#include <WiFiUdp.h>
#include <NTPClient.h>

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 28800, 60000);  // UTC+8 (Malaysia/Singapore)

// ===================== PIN CONFIG =====================
#define TRIG_PIN    13
#define ECHO_PIN    12
#define STATUS_LED  2

// ===================== SENSORS =====================
Adafruit_BME280 bme;

// ===================== WIFI =====================
const char* WIFI_SSID     = "Galaxy A53";
const char* WIFI_PASSWORD = "12345678";

// ===================== GOOGLE APPS SCRIPT URL =====================
// REPLACE WITH YOUR OWN DEPLOYED WEB APP URL
const char* GOOGLE_SCRIPT_URL = 
  "https://script.google.com/macros/s/AKfycbwaENmv4Iz6S3pNbUJ_Hyv4Q_k2OkcwJgeCUO2zInpTWadrTpGLmS5xSBwmrXX8Av23eQ/exec";

// ===================== SETTINGS =====================
const unsigned long SEND_INTERVAL = 5000;       // 5 seconds between readings
#define WDT_TIMEOUT_SECONDS       20          // Safe timeout

// ===================== DATA STRUCTURE =====================
struct SensorData {
  float distance = -1.0f;
  float temperature = NAN;
  float humidity = NAN;
  float pressure = NAN;
  unsigned long timestamp = 0;  // Now Unix seconds since 1970
  bool bmeValid = false;
};

// ===================== ULTRASONIC WITH MEDIAN FILTER =====================
float getDistanceCM() {
  const int SAMPLES = 5;
  float readings[SAMPLES];
  int valid = 0;

  for (int i = 0; i < SAMPLES; i++) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    long duration = pulseIn(ECHO_PIN, HIGH, 35000);
    if (duration > 0) {
      float dist = duration * 0.0343 / 2.0;
      if (dist >= 2.0 && dist <= 400.0) {
        readings[valid++] = dist;
      }
    }
    delay(60);  // HC-SR04 recovery time
  }

  if (valid == 0) return -1.0f;

  // Bubble sort for median
  for (int i = 0; i < valid - 1; i++) {
    for (int j = i + 1; j < valid; j++) {
      if (readings[i] > readings[j]) {
        float temp = readings[i];
        readings[i] = readings[j];
        readings[j] = temp;
      }
    }
  }
  return readings[valid / 2];
}

// ===================== READ SENSORS =====================
SensorData readSensors() {
  SensorData data;

  // Keep NTP time accurate
  timeClient.update();

  // Real Unix timestamp (seconds since 1970-01-01)
  data.timestamp = timeClient.getEpochTime();

  data.distance = getDistanceCM();

  data.temperature = bme.readTemperature();
  data.humidity    = bme.readHumidity();
  data.pressure    = bme.readPressure() / 100.0F;

  bool tempOk = !isnan(data.temperature) && data.temperature > -40 && data.temperature < 85;
  bool humOk  = !isnan(data.humidity) && data.humidity >= 0 && data.humidity <= 100;
  data.bmeValid = tempOk && humOk;

  if (!data.bmeValid) {
    Serial.println("[Warning] Invalid BME280 readings");
  }

  esp_task_wdt_reset();
  return data;
}

// ===================== WIFI CONNECT =====================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("Connecting to WiFi ");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WiFi] Connection failed");
  }
}

// ===================== UPLOAD WITH GET (RELIABLE) =====================
bool uploadSingleReading(const SensorData& data) {
  WiFiClientSecure client;
  client.setInsecure();  // Needed for Google Apps Script

  HTTPClient https;

  // Build full URL with query parameters
  String url = String(GOOGLE_SCRIPT_URL) + "?";
  url += "distance="    + String(data.distance, 2);
  url += "&temperature=" + String(data.temperature, 2);
  url += "&humidity="   + String(data.humidity, 2);
  url += "&pressure="   + String(data.pressure, 2);
  url += "&timestamp="  + String(data.timestamp);  // Now real Unix time

  Serial.println("[Upload] Sending GET:");
  Serial.println(url);

  https.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  https.setTimeout(30000);
  https.setConnectTimeout(10000);

  if (!https.begin(client, url)) {
    Serial.println("[HTTP] begin() failed");
    return false;
  }

  int httpCode = https.GET();

  if (httpCode > 0) {
    String response = https.getString();
    Serial.println("[HTTP] Code: " + String(httpCode) + " | Response: " + response);

    if (httpCode == 200 || httpCode == 201 || httpCode == 302) {
      digitalWrite(STATUS_LED, HIGH);
      return true;
    }
  } else {
    Serial.println("[HTTP] GET failed: " + https.errorToString(httpCode));
  }

  https.end();

  // Fast blink on failure
  for (int i = 0; i < 6; i++) {
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
    delay(150);
  }
  return false;
}

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // Startup LED flash
  for (int i = 0; i < 4; i++) {
    digitalWrite(STATUS_LED, HIGH); delay(150);
    digitalWrite(STATUS_LED, LOW);  delay(150);
  }

  connectWiFi();

  // Initialize NTP
  timeClient.begin();
  Serial.print("Syncing NTP time");
  while (!timeClient.update()) {
    Serial.print(".");
    delay(500);
  }
  Serial.println("\n[NTP] Time synchronized: " + timeClient.getFormattedDate());

  // BME280 init
  Serial.println("Initializing BME280...");
  if (!bme.begin(0x76) && !bme.begin(0x77)) {
    Serial.println("[FATAL] BME280 not detected!");
    while (1) {
      digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
      delay(100);
    }
  }
  Serial.println("[OK] BME280 ready");

  // Watchdog setup
  esp_task_wdt_deinit();
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
    .trigger_panic = true
  };
  esp_task_wdt_init(&wdt_config);
  esp_task_wdt_add(NULL);

  Serial.println("[System] Ready - Starting sensor loop");
  digitalWrite(STATUS_LED, HIGH);
}

// ===================== LOOP =====================
void loop() {
  static unsigned long lastSend = 0;

  connectWiFi();

  if (millis() - lastSend >= SEND_INTERVAL) {
    lastSend = millis();

    SensorData current = readSensors();

    Serial.println("\n=== New Reading ===");
    Serial.printf("Distance   : %.2f cm\n", current.distance);
    Serial.printf("Temp       : %.2f °C\n", current.temperature);
    Serial.printf("Humidity   : %.2f %%\n", current.humidity);
    Serial.printf("Pressure   : %.2f hPa\n", current.pressure);
    Serial.printf("Timestamp  : %lu (Unix)\n", current.timestamp);
    Serial.printf("Date/Time  : %s\n", timeClient.getFormattedDate().c_str());
    Serial.printf("BME Valid  : %s\n", current.bmeValid ? "Yes" : "No");

    if (WiFi.status() == WL_CONNECTED) {
      bool success = uploadSingleReading(current);
      if (success) {
        Serial.println("[SUCCESS] Data uploaded to Google Sheets!");
      } else {
        Serial.println("[FAILED] Upload failed - retrying next cycle");
      }
    } else {
      digitalWrite(STATUS_LED, (millis() % 400 < 200) ? HIGH : LOW);
      Serial.println("[OFFLINE] No WiFi - will retry later");
    }
  }

  esp_task_wdt_reset();
}