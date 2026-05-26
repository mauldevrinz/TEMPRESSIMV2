// server.js

// === 1. IMPORTS UTAMA ===
// Mengimpor semua modul yang diperlukan
const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const util = require('util'); //
const cors = require('cors');
const path = require('path');



const app = express();
app.use(cors());
const port = 3000; // Port untuk server API
app.use(bodyParser.json()); // Middleware untuk mengurai JSON body dari request HTTP

// === 2. KONFIGURASI LOCAL DATABASE (VPS) ===
// === 2. DATABASE — Pool (auto-reconnect, VPS-safe) ===
const dbPool = mysql.createPool({
    host: 'localhost',
    user: 'simulator_user',
    password: 'simulator_pass',
    database: 'simulator_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// queryPromise wraps pool.query so all existing code keeps working
const dbPoolPromise = dbPool.promise();
const queryPromise  = (sql, params) => dbPoolPromise.query(sql, params).then(([rows]) => rows);

// Startup connectivity check
dbPool.getConnection((err, conn) => {
    if (err) {
        console.error('❌ Gagal koneksi database:', err.message);
    } else {
        console.log('✅ Terkoneksi ke Local VPS Database.');
        conn.release();
    }
});

// FUNGSI PENGUJIAN QUERY (WAJIB)
function testDbConnection() {
    queryPromise('SELECT id, username FROM users LIMIT 1')
        .then(results => {
            console.log(`✅ Uji Query Sukses! User pertama: ${results[0] ? results[0].username : 'Tidak ada user'}`);
        })
        .catch(error => {
            // JIKA INI GAGAL, MAKA SIGN UP PASTI GAGAL
            console.error('❌ UJI QUERY GAGAL! ERRORNYA ADA PADA SQL/KOLOM:', error.sqlMessage || error.message);
        });
}

// === 3. KONFIGURASI HIVEMQ CLOUD (MQTT BROKER) ===
const mqttBrokerHost = 'daeb68cee1a0470ab4fbd5a4f1691fe8.s1.eu.hivemq.cloud';
const mqttBrokerPort = 8883; // Port untuk koneksi aman (TLS/SSL)

const mqttOptions = {
    host: mqttBrokerHost, port: mqttBrokerPort, protocol: 'mqtts',
    username: 'auliazqi',
    password: 'Serveradmin123', // Kritis: Password HiveMQ yang sudah disinkronkan
    clientId: 'nodejs_backend_client_' + Math.random().toString(16).substr(2, 8), // Client ID unik
    rejectUnauthorized: false
};

const client = mqtt.connect(mqttOptions);

client.on('connect', () => {
    console.log(`✅ Terkoneksi ke HiveMQ Cloud: ${mqttBrokerHost}`);
    console.log('✅ Backend Connected to MQTT Broker!');

    // 1. Subscribe ke Data Temperature (Plant)
    client.subscribe('plant/data/#', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: plant/data/# (Temperature)`);
        }
    });

    // 2. Subscribe ke Data Pressure (SIS)
    // FIX: SIS firmware publishes to 'plant/data/pressure', bukan 'sis/data/#'
    client.subscribe('plant/data/pressure', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: plant/data/pressure (Pressure/SIS)`);
        }
    });

    // 3. Subscribe ke Control Admin
    client.subscribe('admin/control/#', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: admin/control/# (Perintah Kontrol)`);
        }
    });
});

// --- 4. PENANGANAN DATA MASUK (MQTT MESSAGE) ---
// Deklarasikan variabel global untuk melacak data terakhir yang diterima
lastInsertedId = null;

client.on('message', (topic, message) => {
    try {
        const sensorData = JSON.parse(message.toString());

        // Ekstraksi nilai sensor dan timestamp yang diterima dari ESP32
        const sendTimestamp = sensorData.send_timestamp;
        let sensorValue = null;
        let columnName = null;
        let extraData = {};

        // KASUS 1: TEMPERATURE (Tetap di plant/data)
        if (topic === 'plant/data/temperature') {
            sensorValue = sensorData.temperature;
            columnName = 'temperature';
            let voltageVal = sensorData.voltage !== undefined ? sensorData.voltage : 0;

            extraData = {
                voltage: voltageVal // Masukkan ke wadah agar terbawa ke database
            };
        // KASUS 2: PRESSURE (dari SIS firmware)
        } else if (topic === 'plant/data/pressure') {
            sensorValue = parseFloat(sensorData.pressure);
            columnName  = 'pressure';
            let voltageVal = sensorData.voltage !== undefined ? parseFloat(sensorData.voltage) : 0;

            // FIX: firmware mengirim sv1_state/sv2_state ("OPEN"/"CLOSE") & alarm_status ("ON"/"OFF")
            // Dukung kedua format: string (firmware baru) & int (lama)
            const sv1Raw = sensorData.sv1_state;
            const sv2Raw = sensorData.sv2_state;
            const sv1Val = (sv1Raw === 'OPEN' || sv1Raw === 1 || sv1Raw === true) ? 1 : 0;
            const sv2Val = (sv2Raw === 'OPEN' || sv2Raw === 1 || sv2Raw === true) ? 1 : 0;
            const buzzerVal = (sensorData.alarm_status === 'ON' || sensorData.alarm_status === 1) ? 1 : 0;

            extraData = {
                sv1: sv1Val,
                sv2: sv2Val,
                buzzer: buzzerVal,
                voltage: voltageVal
            };

        } else {
            // Abaikan jika topik tidak dikenali (misal topic control)
            return;
        }

        console.log(`[DATA] Menerima ${columnName}: ${sensorValue}, Extra:`, extraData);

        // --- Mulai Logika UPDATE/INSERT ---
        handleDbUpdate(columnName, sensorValue, sendTimestamp, extraData);

    } catch (e) {
        console.error('❌ Error parsing JSON atau logic MQTT:', e.message);
    }
});


// --- 4. PENANGANAN DATA MASUK (MQTT MESSAGE) ---
// Deklarasikan variabel global untuk melacak data terakhir yang diterima
//Fungsi untuk menangani INSERT atau UPDATE (FINAL LOGIC)
function handleDbUpdate(columnName, sensorValue, sendTimestamp, extraData = {}) {
    // Ambil nilai sv1/sv2 dari extraData. Jika tidak ada, baru pakai 0.
    const sv1 = extraData.sv1 !== undefined ? extraData.sv1 : 0;
    const sv2 = extraData.sv2 !== undefined ? extraData.sv2 : 0;
    const buzzer = extraData.buzzer !== undefined ? extraData.buzzer : 0;
    const voltage = extraData.voltage !== undefined ? extraData.voltage : 0
    // 1. UPDATE (Jika baris terakhir masih kosong kolomnya)
    let updateQuery = '';
    let updateValues = [];

    if (columnName === 'pressure') {
        // Update Pressure SEKALIGUS status Valve
        // Cek: baris terakhir yang temperature-nya sudah ada tapi pressure masih NULL
        updateQuery = `
            UPDATE sensor_data
            SET pressure = ?, sv1_status = ?, sv2_status = ?, buzzer_status = ?, voltage_pressure = ?, receive_timestamp = NOW()
            WHERE id = ? AND pressure IS NULL;
        `;
        updateValues = [sensorValue, sv1, sv2, buzzer, voltage, lastInsertedId];
    } else {
        // Update Temperature
        // Cek: baris terakhir yang pressure-nya sudah ada tapi temperature masih NULL
        updateQuery = `
            UPDATE sensor_data
            SET temperature = ?, voltage_temp = ?, receive_timestamp = NOW()
            WHERE id = ? AND temperature IS NULL;
        `;
        updateValues = [sensorValue, voltage, lastInsertedId];
    }

    // Eksekusi UPDATE
    dbPool.query(updateQuery, updateValues, (err, result) => {
        if (err) { console.error('❌ Error UPDATE DB:', err.message); return; }

        if (result.affectedRows > 0) {
            console.log(`✅ UPDATE Data Masuk ke ID: ${lastInsertedId}`);
            return;
        }

        // 2. INSERT BARU (Jika Update Gagal/Baris Penuh)
        // PERHATIKAN: Di sini kita pakai variabel sv1 & sv2, BUKAN ANGKA 0 LAGI
        const insertQuery = `
           INSERT INTO sensor_data (temperature, pressure, relay_status, sv1_status, sv2_status, buzzer_status, voltage_temp, voltage_pressure, send_timestamp, receive_timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW());
        `;

        let insertValues = [];
        if (columnName === 'temperature') {
            // Urutan : Temp, Press, SV1, SV2, Buzzer, Volt_Temp, Volt_Press, Send_Timestamp, Receive_Timestamp
            // Kita masukkan data 'voltage' ke kolom 'voltage_temp'
            insertValues = [sensorValue, null, 0, 0, 0, 0, voltage, null, sendTimestamp];
        } else {
            // PRESSURE: Masukkan data 'voltage' ke kolom 'voltage_pressure'
            insertValues = [null, sensorValue, 0, sv1, sv2, buzzer, null, voltage, sendTimestamp];
        }

        dbPool.query(insertQuery, insertValues, (err, result) => {
            if (err) { console.error('❌ Error INSERT DB:', err.message); return; }
            lastInsertedId = result.insertId;
            console.log(`⭐ INSERT BARU (ID: ${lastInsertedId}) -> Pressure: ${sensorValue}, SV1: ${sv1}, SV2: ${sv2}`);
        });
    });
}

// ==============================================
// 5. ENDPOINTS API (FUNGSI KONTROL & OTENTIKASI)
// ==============================================
/// server.js: [A] Endpoint API untuk Sign Up (DEBUGGING TANPA HASHING)

app.post('/api/signup', async (req, res) => { // <-- KOREKSI 3A: TAMBAH async
    try {
        const { username, email, phone, password } = req.body;

        // --- BCRYPT DIHIDUPKAN KEMBALI ---
        const hash = await bcrypt.hash(password, 10); // <-- KOREKSI 3B: BCRYPT ASYNC
        // --- BCRYPT DIHIDUPKAN KEMBALI ---

        // QUERY MENGGUNAKAN NAMA KOLOM YANG SUDAH ANDA KONFIRMASI
        const query = 'INSERT INTO users (username, email, phone, password, role) VALUES (?, ?, ?, ?, ?)';

        // KOREKSI 3C: GUNAKAN await queryPromise
        const result = await queryPromise(query, [username, email, phone, hash, 'user']);

        console.log(`✅ User ${username} berhasil didaftarkan.`);
        res.status(201).json({ success: true, message: 'Akun berhasil dibuat.' });

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Username atau Email sudah terdaftar.' });
        }
        // *** INI ADALAH LOG UTAMA KITA ***
        console.error('❌ FINAL DB ERROR (Sign Up):', err.sqlMessage || err.message);
        return res.status(500).json({ success: false, message: 'Server error saat pendaftaran.' });
    }
});

// [B] Endpoint API untuk Login (KOREKSI)
// server.js: [B] Endpoint API untuk Login (KODE YANG BENAR DAN STABIL)

app.post('/api/login', async (req, res) => { // <-- KOREKSI 4A: TAMBAH async
    try {
        const { email, password } = req.body;

        // Pastikan 5 kolom diambil
        const query = 'SELECT id, username, email, phone, password, role FROM users WHERE email = ?';

        // KOREKSI 4B: GUNAKAN await queryPromise
        const results = await queryPromise(query, [email]);

        if (results.length === 0) {
            return res.status(401).json({ success: false, message: 'Email tidak terdaftar.' });
        }

        const user = results[0];
        const hashedPassword = user.password;

        // KOREKSI 4C: BCRYPT ASYNC
        const isMatch = await bcrypt.compare(password, hashedPassword);

        if (isMatch) {
            // Login berhasil
            const userData = { id: user.id, username: user.username, email: user.email, role: user.role };
            console.log(`✅ Login berhasil untuk user: ${user.username}`);
            res.json({ success: true, user: userData, message: 'Login berhasil!' });
        } else {
            return res.status(401).json({ success: false, message: 'Password salah.' });
        }
    } catch (err) {
        console.error('❌ FINAL DB ERROR (Login):', err.sqlMessage || err.message);
        return res.status(500).json({ success: false, message: 'Server error saat login.' });
    }
});

/// [C] Endpoint API untuk mendapatkan data terbaru (KOREKSI FINAL)
app.get('/api/latest-data', async (req, res) => {
    try {
        // Query latest non-null TEMPERATURE row separately
        const tempQuery = `SELECT temperature, voltage_temp, sv1_status, send_timestamp
                           FROM sensor_data WHERE temperature IS NOT NULL
                           ORDER BY receive_timestamp DESC LIMIT 1`;

        // Query latest non-null PRESSURE row separately
        const pressQuery = `SELECT pressure, voltage_pressure, sv1_status, sv2_status,
                                   buzzer_status, send_timestamp AS pressure_timestamp
                            FROM sensor_data WHERE pressure IS NOT NULL
                            ORDER BY receive_timestamp DESC LIMIT 1`;

        const [tempResult, pressResult] = await Promise.all([
            queryPromise(tempQuery),
            queryPromise(pressQuery)
        ]);

        // Merge both into one object so frontend gets both regardless of which arrived last
        const combined = {
            ...(tempResult[0] || {}),
            ...(pressResult[0] || {})
        };

        res.json(Object.keys(combined).length > 0 ? combined : {});

    } catch (err) {
        console.error('❌ FATAL ERROR DI /api/latest-data:', err.sqlMessage || err.message);
        res.status(500).send('Gagal mengambil data dari server database.');
    }
});

// [D] ENDPOINT API UNTUK SETPOINT SUHU/KP/SAMPLING (MENU 1)
app.post('/api/control/setpoint/:param', (req, res) => {
    const param = req.params.param; // parameter yang dikirim (temp, sampling, kp)
    const value = req.body.value;

    console.log(`[REQUEST RECEIVED] API Control hit: ${param} = ${value}`);

    if (isNaN(value)) { return res.status(400).send({ success: false, message: 'Nilai tidak valid.' }); }

    const payload = { parameter: param, value: value, timestamp: Date.now() };

    // PUBLISH ke MQTT (Topic: admin/control/setpoints)
    client.publish('admin/control/setpoints', JSON.stringify(payload), (err) => {
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL SUCCESS] Setpoint ${param} dikirim: ${value}`);
        res.send({ success: true, message: `Setpoint ${param} berhasil dikirim.` });
    });
});

// [E] ENDPOINT API UNTUK BATAS TEKANAN (PAH/PAHH - MENU 2)
// FIX: Map param names correctly → SIS firmware expects 'pressure_pahh' / 'sampling'
//   'pressure'          -> 'pressure_pahh'  (setShutdownLimit in SIS mqttCallback)
//   'pressure-sampling' -> 'sampling'       (acknowledged in firmware log)
app.post('/api/control/pressure-limit/:param', (req, res) => {
    const param = req.params.param;
    const value = req.body.value;

    if (isNaN(value)) { return res.status(400).send({ success: false, message: 'Nilai tekanan tidak valid.' }); }

    const paramMap = {
        'pressure':          'pressure_pahh',
        'pressure-sampling': 'sampling',
    };

    const mqttParam = paramMap[param];
    if (!mqttParam) {
        return res.status(400).send({ success: false, message: `Parameter '${param}' tidak dikenal.` });
    }

    const payload = { parameter: mqttParam, value: parseFloat(value), timestamp: Date.now() };

    client.publish('admin/control/setpoints', JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL] Pressure limit '${mqttParam}' dikirim: ${value}`);
        res.send({ success: true, message: `Setpoint '${mqttParam}' = ${value} Bar berhasil dikirim ke SIS.` });
    });
});


// [F] ENDPOINT API UNTUK TOGGLE VALVE (SV1/SV2 - MENU 2)
app.post('/api/control/valve/:valveId', (req, res) => {
    const valveId = req.params.valveId;
    const status = req.body.status;

    const payload = { command: 'valve_toggle', valve: valveId, status: status, timestamp: Date.now() };

    client.publish('admin/control/valve', JSON.stringify(payload), (err) => { // Topic khusus untuk valve
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL] Valve ${valveId} disetel ke: ${status}`);
        res.send({ success: true, message: `Valve ${valveId} disetel ke ${status ? 'ON' : 'OFF'}.` });
    });
});

// [F.2] ENDPOINT API UNTUK SIS SIMULATION TOGGLE + SECTION CONTROL (ACTUATOR)
app.post('/api/sis-control', (req, res) => {
    // --- Case 1: Legacy SIS simulation ON/OFF toggle ---
    if (req.body.command === 'SET_SIS_MODE') {
        const { status } = req.body;
        if (status !== 'ON' && status !== 'OFF') {
            return res.status(400).json({ success: false, message: 'Status tidak valid.' });
        }
        const payload = { command: 'SET_SIS_MODE', status, timestamp: Date.now() };
        client.publish('admin/control/sis', JSON.stringify(payload), { qos: 1 }, (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal kirim.' });
            console.log(`[CONTROL] SIS Mode → ${status}`);
            res.json({ success: true, message: `Sistem berhasil di-set ke ${status}` });
        });
        return;
    }

    // --- Case 2: Section Control — manual actuator toggle (SV1 / SV2) ---
    const { actuator, value } = req.body;
    const validActuators = ['sv1', 'sv2'];
    if (!validActuators.includes(actuator) || value === undefined) {
        return res.status(400).json({ success: false, message: 'Actuator atau value tidak valid.' });
    }

    const param = actuator === 'sv1' ? 'sv1_manual' : 'sv2_manual';
    const payload = JSON.stringify({ parameter: param, value: parseInt(value) });

    client.publish('admin/control/sis', payload, { qos: 1 }, (err) => {
        if (err) {
            console.error('[MQTT ERROR] Gagal publish SIS Control:', err);
            return res.status(500).json({ success: false, message: 'Gagal kirim ke SIS ESP32.' });
        }
        console.log(`[CONTROL] ${actuator.toUpperCase()} → ${value == 1 ? 'CLOSE' : 'OPEN'}  payload: ${payload}`);
        res.json({ success: true, message: `${actuator.toUpperCase()} set to ${value == 1 ? 'CLOSE' : 'OPEN'}` });
    });
});

// [F.3] ENDPOINT API UNTUK MANUAL STEPPER (BPCS)
// Body: { value: <20-80>, mode: 'manual' }  OR  { mode: 'auto' }
app.post('/api/control/stepper', (req, res) => {
    const { value, mode } = req.body;

    if (mode === 'auto') {
        const payload = JSON.stringify({ parameter: 'mode', value: 1, timestamp: Date.now() });
        client.publish('admin/control/setpoints', payload, { qos: 1 }, (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal kirim.' });
            console.log('[CONTROL] BPCS Mode → AUTO');
            res.json({ success: true, message: 'Stepper mode set to AUTO (PID enabled).' });
        });
        return;
    }

    const pct = parseFloat(value);
    if (isNaN(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ success: false, message: 'Value harus 0-100.' });
    }
    const payload = JSON.stringify({ parameter: 'stepper_manual', value: pct, timestamp: Date.now() });
    client.publish('admin/control/setpoints', payload, { qos: 1 }, (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal kirim.' });
        console.log(`[CONTROL] Stepper MANUAL → ${pct}%`);
        res.json({ success: true, message: `Stepper set to ${pct}%` });
    });
});

// server.js (Tambahkan di bagian API Endpoints)

// Fungsi utilitas untuk konversi array JSON ke CSV string
const jsonToCsv = (data, headerColumns) => {
    if (!data || data.length === 0) return headerColumns.join(',') + '\n';

    const header = headerColumns.join(',') + '\n';
    const rows = data.map(obj =>
        headerColumns.map(col => {
            // Tangani nilai null atau undefined
            const value = (obj[col] !== null && obj[col] !== undefined) ? obj[col] : '';
            // Pastikan nilai yang mengandung koma dibungkus quotes (opsional)
            return (typeof value === 'string' && value.includes(',')) ? `"${value}"` : value;
        }).join(',')
    ).join('\n');

    return header + rows;
};

// [G] ENDPOINT API UNTUK EXPORT SUHU (MENU 1)
app.get('/api/export/temperature-log', async (req, res) => {
    try {
        // 1. Tangkap parameter start & end dari Frontend
        const { start, end } = req.query;

        const header = ['id', 'temperature', 'sv1_status', 'receive_timestamp'];
        let query = '';
        let params = [];

        // 2. Logika Pemilihan Query
        if (start && end) {
            // JIKA ADA WAKTU RECORD: Ambil data DIANTARA waktu start & end
            console.log(`[EXPORT TEMP] Request Range: ${start} s/d ${end}`);
            query = 'SELECT id, temperature, sv1_status, receive_timestamp FROM sensor_data WHERE temperature IS NOT NULL AND receive_timestamp BETWEEN ? AND ? ORDER BY receive_timestamp ASC';
            params = [start, end];
        } else {
            // JIKA TIDAK ADA (Default): Ambil 500 data terakhir
            console.log(`[EXPORT TEMP] Request Default (500 limit)`);
            query = 'SELECT id, temperature, sv1_status, receive_timestamp FROM sensor_data WHERE temperature IS NOT NULL ORDER BY receive_timestamp DESC LIMIT 500';
        }

        const results = await queryPromise(query, params);
        const csv = jsonToCsv(results, header);

        res.header('Content-Type', 'text/csv');
        res.attachment(`Temperature_Log.csv`);
        res.send(csv);

    } catch (err) {
        console.error('❌ Error Export Temp:', err);
        res.status(500).send('Server Error');
    }
});

// [H] ENDPOINT API UNTUK EXPORT TEKANAN (MENU 2)
app.get('/api/export/pressure-log', async (req, res) => {
    try {
        // 1. Tangkap parameter start & end
        const { start, end } = req.query;

        const header = ['id', 'pressure', 'sv1_status', 'sv2_status', 'buzzer_status', 'receive_timestamp'];
        let query = '';
        let params = [];

        // 2. Logika Pemilihan Query
        if (start && end) {
            console.log(`[EXPORT PRESSURE] Request Range: ${start} s/d ${end}`);
            query = 'SELECT id, pressure, sv1_status, sv2_status, buzzer_status, receive_timestamp FROM sensor_data WHERE pressure IS NOT NULL AND receive_timestamp BETWEEN ? AND ? ORDER BY receive_timestamp ASC';
            params = [start, end];
        } else {
            console.log(`[EXPORT PRESSURE] Request Default (500 limit)`);
            query = 'SELECT id, pressure, sv1_status, sv2_status, buzzer_status, receive_timestamp FROM sensor_data WHERE pressure IS NOT NULL ORDER BY receive_timestamp DESC LIMIT 500';
        }

        const results = await queryPromise(query, params);
        const csv = jsonToCsv(results, header);

        res.header('Content-Type', 'text/csv');
        res.attachment(`Pressure_Log.csv`);
        res.send(csv);

    } catch (err) {
        console.error('❌ Error Export Pressure:', err);
        res.status(500).send('Server Error');
    }
});

const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath, { index: false }));

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'auth.html'));
});
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ msg: 'API Not Found' });
    res.sendFile(path.join(frontendPath, 'auth.html'));
});

// --- 6. START SERVER ---
app.listen(port, () => {
    console.log(`Server backend berjalan di http://localhost:${port}`);
}); 
