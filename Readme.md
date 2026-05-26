README
# TEMPRESSIMV2

TEMPRESSIMV2 merupakan sistem **simulator panci bertekanan** berbasis IoT yang terdiri dari:

- Frontend web untuk monitoring dan kontrol
- Backend Node.js sebagai API, MQTT bridge, dan logging database
- Firmware ESP32 untuk sistem BPCS dan SIS

---

## 📁 Struktur Proyek

```text
TEMPRESSIMV2/
├── frontend/
│   ├── auth.html
│   ├── index.html
│   └── frontend.js
├── backend/
│   ├── server.js
│   ├── sim_alat.js
│   └── package.json
├── BPCS_AntiHunting.ino
└── SIS.ino
```

---

## ✨ Fitur Utama

- Login dan signup user
- Monitoring suhu dan tekanan secara real-time
- Kontrol:
  - Setpoint suhu
  - Pressure limit
  - Valve (SV1 / SV2)
  - Stepper motor
- Penyimpanan data ke database MySQL
- Export log suhu dan tekanan ke format CSV
- Integrasi MQTT dengan ESP32

---

## 🛠️ Teknologi yang Digunakan

- Node.js
- Express.js
- MySQL / MariaDB
- MQTT
- ESP32
- HTML, CSS, JavaScript

---

## 📦 Kebutuhan Sistem

Sebelum menjalankan project, pastikan telah menginstall:

- Node.js v18+ (disarankan)
- MySQL / MariaDB
- MQTT Broker  
  (default menggunakan HiveMQ Cloud)
- Arduino IDE  
  (opsional, untuk upload firmware `.ino`)

---

## 🚀 Menjalankan Backend

### 1. Masuk ke folder backend

```bash
cd /tmp/workspace/mauldevrinz/TEMPRESSIMV2/backend
```
