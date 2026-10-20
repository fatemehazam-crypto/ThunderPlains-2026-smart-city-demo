// GPS node: NEO-F10N (L1 + L5) on an ESP32, publishing to the smart city MQTT bus.
//
// How it works: the GNSS module pushes every fix to the ESP32 by itself. The loop never
// waits for the module, so Wi-Fi and MQTT always get serviced on time.

#include <WiFi.h>
#include <PubSubClient.h>
#include <SparkFun_u-blox_GNSS_v3.h>

// ─── Config ───────────────────────────────────────────────────────────────────
const char* ssid         = "YOUR_WIFI_NAME";      // 2.4 GHz network
const char* password     = "YOUR_WIFI_PASSWORD";
const char* MQTT_SERVER  = "192.168.1.100";  // your laptop's IP: npm start prints it
const int   MQTT_PORT    = 1883;
const char* NODE_ID      = "gps-node";
const char* STATUS_TOPIC = "status/gps-node";   // online/offline, kept outside smartcity/# on purpose

// The one knob for speed: fixes per second. 1 = a reading every second.
// (2 would give a reading every 500 ms, at the cost of twice the serial traffic.)
const uint8_t NAV_RATE_HZ = 1;

const unsigned long MIN_PUBLISH_GAP_MS = 250;   // never publish faster than this, whatever the module does
const unsigned long RECONNECT_INTERVAL = 5000;  // how often to retry Wi-Fi / MQTT when down
const unsigned long SIG_WAIT_MS        = 300;   // how long a fix waits for its signal report before going out alone

const bool VERBOSE = false;  // true = print every satellite signal (slow; for bench debugging only)

// ─── NEO-F10N UART Pins ───────────────────────────────────────────────────────
// NEO-F10N TXO -> ESP32 GPIO 18
// NEO-F10N RXI -> ESP32 GPIO 17
// NEO-F10N 3V3 -> ESP32 3.3V
// NEO-F10N GND -> ESP32 GND
#define GNSS_RX_PIN  18
#define GNSS_TX_PIN  17
#define GNSS_BAUD    38400

// NAV-SIG: 8-byte header + 16 bytes per signal. The NEO-F10N can report 60+ signals.
#define NAV_SIG_PAYLOAD_SIZE (8 + (92 * 16))

SFE_UBLOX_GNSS_SERIAL myGNSS;

WiFiClient   espClient;
PubSubClient client(espClient);

// ─── Latest reading ───────────────────────────────────────────────────────────
double        lat            = 0.0;
double        lng            = 0.0;
int           satellites     = 0;
const char*   lockStatus     = "lost";
float         snrL1          = 0.0;
float         snrL5          = 0.0;
unsigned long fixCollectedMs = 0;      // when this fix arrived from the module (device clock)
volatile bool freshFix       = false;  // a new position is waiting to be published
volatile bool freshSig       = false;  // its signal report has arrived too

unsigned long lastPublish = 0;
unsigned long lastWifiTry = 0;
unsigned long lastMqttTry = 0;
unsigned long lastGnssMsg = 0;

// ─── Signal Classification ────────────────────────────────────────────────────
bool isL1Signal(uint8_t gnssId, uint8_t sigId) {
  if (gnssId == 0 && sigId == 0) return true;  // GPS L1 C/A
  if (gnssId == 2 && sigId == 0) return true;  // Galileo E1
  if (gnssId == 3 && sigId == 0) return true;  // BeiDou B1
  if (gnssId == 5 && sigId == 0) return true;  // QZSS L1
  return false;
}

bool isL5Signal(uint8_t gnssId, uint8_t sigId) {
  if (gnssId == 0 && sigId == 7) return true;  // GPS L5
  if (gnssId == 2 && sigId == 4) return true;  // Galileo E5a
  if (gnssId == 5 && sigId == 7) return true;  // QZSS L5
  if (gnssId == 3 && sigId == 5) return true;  // BeiDou B2a
  return false;
}

// ─── GNSS callbacks: the module calls these each time it has something new ────
void onPVT(UBX_NAV_PVT_data_t *pvt) {
  lat        = pvt->lat / 10000000.0;
  lng        = pvt->lon / 10000000.0;
  satellites = pvt->numSV;
  lockStatus = (satellites > 0 && pvt->fixType >= 2) ? "locked" : "lost";

  fixCollectedMs = millis();
  lastGnssMsg    = fixCollectedMs;
  freshFix       = true;
  freshSig       = false;   // the signal report for this fix follows right behind
}

void onNAVSIG(UBX_NAV_SIG_data_t *sig) {
  float l1Sum = 0, l5Sum = 0;
  int   l1Count = 0, l5Count = 0;

  uint8_t numSigs = sig->header.numSigs;
  if (VERBOSE) Serial.printf("NAV-SIG: %d signals\n", numSigs);

  for (uint8_t i = 0; i < numSigs; i++) {
    uint8_t gnssId = sig->blocks[i].gnssId;
    uint8_t sigId  = sig->blocks[i].sigId;
    uint8_t cno    = sig->blocks[i].cno;

    bool l1 = isL1Signal(gnssId, sigId);
    bool l5 = isL5Signal(gnssId, sigId);

    if (VERBOSE) {
      Serial.printf("  [%s] gnssId=%d sigId=%d svId=%d cno=%d\n",
                    l1 ? "L1" : (l5 ? "L5" : "?"), gnssId, sigId, sig->blocks[i].svId, cno);
    }

    if (cno > 0) {
      if (l1) { l1Sum += cno; l1Count++; }
      if (l5) { l5Sum += cno; l5Count++; }
    }
  }

  snrL1 = (l1Count > 0) ? (l1Sum / l1Count) : 0.0;
  snrL5 = (l5Count > 0) ? (l5Sum / l5Count) : 0.0;

  lastGnssMsg = millis();
  freshSig    = true;
}

// ─── Publish ──────────────────────────────────────────────────────────────────
// Same message shape as the other nodes: {"value": ..., "unit": "...", "collected_ms": ...}
// jsonValue must already be valid JSON: a bare number, or a string wrapped in quotes.
void publishMetric(const char* metric, const String& jsonValue, const char* unit, unsigned long collectedMs) {
  char topic[64];
  char payload[128];
  snprintf(topic, sizeof(topic), "smartcity/%s/%s", NODE_ID, metric);
  snprintf(payload, sizeof(payload), "{\"value\":%s,\"unit\":\"%s\",\"collected_ms\":%lu}",
           jsonValue.c_str(), unit, collectedMs);
  client.publish(topic, payload);
}

void publishGPSData() {
  int rssi = WiFi.RSSI();
  unsigned long t = fixCollectedMs;   // all seven values share one timestamp: they are ONE reading

  Serial.printf("%s  sats=%d  L1=%.1f  L5=%.1f  rssi=%d  (%.6f, %.6f)\n",
                lockStatus, satellites, snrL1, snrL5, rssi, lat, lng);

  if (!client.connected()) {
    Serial.println("MQTT not connected, reading skipped");
    return;
  }

  publishMetric("lock_status", String("\"") + lockStatus + "\"", "",      t);
  publishMetric("satellites",  String(satellites),               "",      t);
  publishMetric("snr_l1",      String(snrL1, 1),                 "dB-Hz", t);
  publishMetric("snr_l5",      String(snrL5, 1),                 "dB-Hz", t);
  publishMetric("lat",         String(lat, 6),                   "deg",   t);
  publishMetric("lng",         String(lng, 6),                   "deg",   t);
  publishMetric("wifi_rssi",   String(rssi),                     "dBm",   t);
}

// ─── Connections: retried in the background, never in a waiting loop ──────────
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < RECONNECT_INTERVAL) return;
  lastWifiTry = millis();
  Serial.println("WiFi down, reconnecting...");
  WiFi.reconnect();
}

void ensureMQTT() {
  if (client.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (lastMqttTry != 0 && millis() - lastMqttTry < RECONNECT_INTERVAL) return;
  lastMqttTry = millis();

  Serial.print("MQTT connecting... ");
  // Last will: if this node dies or drops off, the broker itself publishes "offline".
  bool ok = client.connect(NODE_ID, STATUS_TOPIC, 1, true, "offline");

  if (ok) {
    espClient.setNoDelay(true);   // send each small message immediately instead of holding it to batch
    client.publish(STATUS_TOPIC, "online", true);
    Serial.println("connected");
  } else {
    Serial.printf("failed rc=%d (will retry)\n", client.state());
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
  // Serial over USB: if the board is plugged into a computer but nothing reads the port,
  // every print would wait for a timeout and the board would crawl. Drop prints instead.
  Serial.setTxTimeoutMs(0);
#endif
  Serial.begin(115200);
  delay(3000);

  Serial.println("\n=== GPS NODE STARTING ===");
  Serial.println("Using UART (GPIO 17/18) — NEO-F10N has no I2C\n");

  Serial1.setRxBufferSize(4096);   // room for a full signal report while we are busy publishing
  Serial1.begin(GNSS_BAUD, SERIAL_8N1, GNSS_RX_PIN, GNSS_TX_PIN);
  delay(1000);

  myGNSS.setPacketCfgPayloadSize(NAV_SIG_PAYLOAD_SIZE);

  if (myGNSS.begin(Serial1) == false) {
    Serial.println("u-blox GNSS not detected!");
    Serial.println("   Check: NEO-F10N TXO -> GPIO 18");
    Serial.println("          NEO-F10N RXI -> GPIO 17");
    Serial.println("          NEO-F10N 3V3 -> 3.3V");
    Serial.println("          NEO-F10N GND -> GND");
    Serial.println("Restarting in 10 s to try again...");
    delay(10000);
    ESP.restart();
  }

  Serial.println("u-blox GNSS detected!\n");

  myGNSS.setUART1Output(COM_TYPE_UBX);

  // ── Enable L5 ──
  myGNSS.setVal8(UBLOX_CFG_SIGNAL_GPS_L5_ENA, 1);
  myGNSS.setGPSL5HealthOverride(true);
  myGNSS.softwareResetGNSSOnly();
  delay(2000);

  // ── Reconnect after reset (module reverts baud to 9600) ──
  Serial1.begin(9600, SERIAL_8N1, GNSS_RX_PIN, GNSS_TX_PIN);
  delay(500);
  myGNSS.setSerialRate(38400);
  delay(100);
  Serial1.begin(38400, SERIAL_8N1, GNSS_RX_PIN, GNSS_TX_PIN);
  delay(500);

  Serial.println("L5 enabled + health override applied + baud restored");

  // ── Ask the module to push every fix to us (set AFTER the reset so it sticks) ──
  myGNSS.setNavigationFrequency(NAV_RATE_HZ);
  bool pvtOk = myGNSS.setAutoPVTcallbackPtr(&onPVT);
  bool sigOk = myGNSS.setAutoNAVSIGcallbackPtr(&onNAVSIG);
  Serial.printf("Push mode: position %s, signals %s, %d fixes per second\n",
                pvtOk ? "ok" : "FAILED", sigOk ? "ok" : "FAILED", NAV_RATE_HZ);
  Serial.println("Waiting for satellite lock...\n");

  // ── WiFi + MQTT ──
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected — IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWiFi not up yet, will keep trying in the background");
  }

  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setKeepAlive(15);
  client.setSocketTimeout(3);   // a dead broker can stall us for 3 s at most, not 15
  ensureMQTT();

  lastGnssMsg = millis();
  Serial.println("\nSetup complete!\n");
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop() {
  ensureWiFi();
  ensureMQTT();
  client.loop();

  myGNSS.checkUblox();       // read whatever the module has sent
  myGNSS.checkCallbacks();   // hand complete messages to onPVT / onNAVSIG

  // Publish once per fix: as soon as its signal report is in, or after a short wait without it.
  bool sigReady = freshSig || (millis() - fixCollectedMs > SIG_WAIT_MS);
  if (freshFix && sigReady && millis() - lastPublish >= MIN_PUBLISH_GAP_MS) {
    lastPublish = millis();
    freshFix = false;
    freshSig = false;
    publishGPSData();
  }

  // Nothing from the module for 5 s: say so on the serial monitor (the dashboard sees the silence).
  if (millis() - lastGnssMsg > 5000) {
    lastGnssMsg = millis();
    Serial.println("No data from the GNSS module for 5 s — check wiring/power");
  }
}
