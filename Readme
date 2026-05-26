# TEMPRESSIMV2

Repository ini berisi sistem **simulator panci bertekanan** berbasis:
- **Frontend** web (monitoring & control)
- **Backend** Node.js (API, MQTT bridge, logging database)
- **Firmware ESP32** untuk BPCS dan SIS

## Struktur Proyek

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

## Fitur Utama

- Login & signup user
- Monitoring suhu dan tekanan real-time
- Kontrol setpoint suhu, pressure limit, dan aktuator (SV1/SV2, stepper)
- Simpan data ke MySQL
- Export log suhu/tekanan ke CSV
- Integrasi MQTT dengan perangkat ESP32

## Kebutuhan

- Node.js 18+ (disarankan)
- MySQL / MariaDB
- MQTT broker (default: HiveMQ Cloud)
- (Opsional) Arduino IDE untuk upload firmware `.ino`

## Menjalankan Backend

1. Masuk ke folder backend:
   ```bash
   cd /tmp/workspace/mauldevrinz/TEMPRESSIMV2/backend
   ```
2. Install dependency:
   ```bash
   npm install
   ```
3. Jalankan server:
   ```bash
   npm start
   ```
4. Backend aktif di:
   - `http://localhost:3000`

## Menjalankan Frontend

Frontend dilayani langsung oleh backend dari folder `frontend/`.

- Buka:
  - `http://localhost:3000/` → halaman login (`auth.html`)
  - setelah login akan masuk dashboard (`index.html`)

## Endpoint API yang Digunakan

- `POST /api/signup`
- `POST /api/login`
- `GET /api/latest-data`
- `POST /api/control/setpoint/:param`
- `POST /api/control/pressure-limit/:param`
- `POST /api/control/valve/:valveId`
- `POST /api/sis-control`
- `POST /api/control/stepper`
- `GET /api/export/temperature-log`
- `GET /api/export/pressure-log`

## MQTT Topic (ringkas)

- Telemetri perangkat:
  - `plant/data/temperature`
  - `plant/data/pressure`
- Kontrol dari backend/frontend:
  - `admin/control/setpoints`
  - `admin/control/sis`
  - `admin/control/#`

## Catatan Konfigurasi

- Konfigurasi database dan MQTT saat ini berada langsung di `backend/server.js`.
- URL backend untuk dashboard ada di `frontend/frontend.js` (`backendUrl`).
- Untuk produksi, pindahkan kredensial sensitif ke environment variable.

## Validasi

Script NPM yang tersedia di backend:
- `npm start` → jalankan server
- `npm run dev` → jalankan simulator MQTT (`sim_alat.js`)
- `npm test` → saat ini belum ada test otomatis (placeholder default)
