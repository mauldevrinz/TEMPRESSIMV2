
/**
 * frontend.js (refactored)
 * - Struktur modular ringan (single-file)
 * - Semua DOM diinisialisasi setelah DOMContentLoaded
 * - Menghindari duplikasi variabel / fungsi
 * - Memperbaiki bug pada updateCharts (sv2 sebelumnya salah menggunakan sv1 value)
 * - Menjaga API publik yang mungkin dipanggil dari HTML: setControlValue, showTab, logoutUser
 */

'use strict';

const App = (() => {

    // ======================================================================
    // 1) CONSTANTS & GLOBAL STATE
    // ======================================================================
    const backendUrl = 'http://72.62.120.229:3000'

    // Display / physical constants
    const MAX_TEMP_DISPLAY = 120;       // untuk visual tank
    const MAX_PRESSURE_BAR = 2.5;
    const ALARM_THRESHOLD = 1.5;

    // Sampling defaults
    const DEFAULT_T_SAMPLING = 1;       // seconds for pressure simulation if not overridden
    const MAX_DATA_POINTS = 200;

    // Chart instances
    let tempChart = null;
    let pressureChart = null;
    let sv1Chart = null;
    let sv2Chart = null;

    // Flags
    let chartsInitialized = false;
    let monitoringTimerId = null;
    let pollingTimerId = null;
    let clockTimerId = null;

    // Simulation & pressure state (used by pressure monitoring module)
    const pressureState = {
        simulationTime: 0,
        P_UNIT: 1.1,
        T_SAMPLING: DEFAULT_T_SAMPLING,
        P_LIMIT: 1.1,
        A_LIMIT: 0.9,
        SV1_STATUS: 'OPEN',
        SV2_STATUS: 'OPEN',
        BUZZER_STATUS: 'OFF',
        logCounter: 0,
        chartData: { pressure: { labels: [], data: [] }, sv1: { labels: [], data: [] }, sv2: { labels: [], data: [] } }
    };

    const recordingState = {
        temperature: { isRecording: false, startTime: null, stopTime: null },
        pressure: { isRecording: false, startTime: null, stopTime: null }
    };

    // Config (user-changeable)
    const config = {
        activeTab: 'temperature',
        setpoint: 105,
        kp: 13,
        samplingTime: 60,
        isSystemRunning: false,

        // temperature logs
        tempLogCounter: 0,
        tempLogData: [],
        tempMaxLogEntries: 6
    };

    // DOM references - akan diisi pada initDOM()
    // Elements
    const dom = {
        userInfo: null,
        currentDate: null,
        currentTime: null,

        // monitoring displays
        monitorSetTemp: null,
        monitorSampling: null,
        monitorKp: null,
        monitorCurrentTemp: null,
        monitorDatetime: null,
        logTableBody: null,
        liquidLevel: null,
        actuatorValidation: null,

        // pressure UI
        gaugeNeedle: null,
        currentPressureDisplay: null,
        sv1StatusElem: null,
        sv2StatusElem: null,
        buzzerStatusElem: null,
        logDataBody: null,
        logDataPressureBody: null,

        // --- BUTTONS (NEW) ---
        btnExportTemp: null,
        btnExportPressure: null
    };


    // Expose some functions later to window for HTML buttons
    function exposeGlobals() {
        window.setControlValue = setControlValue;
        window.showTab = showTab;
        window.logoutUser = logoutUser;
        window.startPressureMonitoring = startPressureMonitoring;
        window.stopPressureMonitoring = stopPressureMonitoring;

        window.downloadLogData = downloadLogData;
        window.toggleSystem = toggleSystem;
        window.toggleRecording = toggleRecording;
        window.confirmLogout = confirmLogout;
        window.cancelLogout = cancelLogout; // EXPOSURE KRITIS

        // Section Control
        window.toggleActuator = toggleActuator;
        window.sendStepperCommand = sendStepperCommand;
        window.toggleStepperMode = toggleStepperMode;
        window.toggleSV1FromTemp = toggleSV1FromTemp;
    }

    // ======================================================================
    // 2) DOM INITIALIZATION
    // ======================================================================
    function initDOM() {
        dom.userInfo = document.getElementById('logged-in-user');
        dom.currentDate = document.getElementById('current-date-display');
        dom.currentTime = document.getElementById('current-time-display');

        dom.monitorSetTemp = document.getElementById('monitor-set-temp');
        dom.monitorSampling = document.getElementById('monitor-sampling');
        dom.monitorKp = document.getElementById('monitor-kp');
        dom.monitorCurrentTemp = document.getElementById('monitor-current-temp');
        dom.monitorDatetime = document.getElementById('monitor-datetime-display');
        dom.logTableBody = document.getElementById('log-table-body');
        dom.liquidLevel = document.getElementById('liquid-level');
        dom.actuatorValidation = document.getElementById('actuator-validation');

        dom.gaugeNeedle = document.getElementById('gauge-needle');
        dom.currentPressureDisplay = document.getElementById('current-pressure-display');
        dom.sv1StatusElem = document.getElementById('sv1-status');
        dom.sv2StatusElem = document.getElementById('sv2-status');
        dom.buzzerStatusElem = document.getElementById('buzzer-status');
        dom.logDataBody = document.getElementById('log-data-body');
        dom.logDataPressureBody = document.getElementById('log-data-pressure-body');
        dom.btnExportTemp = document.getElementById('export-temp-csv');
        dom.btnExportPressure = document.getElementById('export-pressure-csv');


    }

    function bindEvents() {
        // Event Listeners untuk Tombol Export
        if (dom.btnExportTemp) {
            dom.btnExportTemp.addEventListener('click', () => downloadLogData('temperature'));
        }
        if (dom.btnExportPressure) {
            dom.btnExportPressure.addEventListener('click', () => downloadLogData('pressure'));
        }
    }

    // ======================================================================
    // 3) UTILITY / UI FUNCTIONS (global accessible by HTML)
    // ======================================================================
    // frontend.js - GANTI fungsi yang ada di bagian UTILITY/UI FUNCTIONS dengan kode ini.

    // Download log data menggunakan IPC Native Electron (INI ADALAH SOLUSI YANG BENAR)

    async function downloadLogData(dataType) {
        // Ambil state recording yang sesuai
        const rec = recordingState[dataType];

        let queryParams = "";

        // Logika Cek State Recording
        if (rec && rec.startTime && rec.stopTime) {
            // User sudah selesai merekam (Ada Start & Stop)
            queryParams = `?start=${encodeURIComponent(rec.startTime)}&end=${encodeURIComponent(rec.stopTime)}`;
            console.log(`[EXPORT] Mengambil range: ${rec.startTime} s/d ${rec.stopTime}`);
        }
        else if (rec && rec.startTime && rec.isRecording) {
            // Sedang merekam tapi tombol export ditekan
            alert("Peringatan: Recording masih berjalan. Data diambil sampai detik ini.");
            const now = new Date();
            const offset = now.getTimezoneOffset() * 60000;
            const nowStr = (new Date(now - offset)).toISOString().slice(0, 19).replace('T', ' ');
            queryParams = `?start=${encodeURIComponent(rec.startTime)}&end=${encodeURIComponent(nowStr)}`;
        }
        else {
            // Tidak ada recording, konfirmasi ambil 500 data terakhir
            if (!confirm("Anda belum melakukan Recording. Download 500 data terakhir?")) return;
        }

        const endpoint = (dataType === 'temperature')
            ? `${backendUrl}/api/export/temperature-log${queryParams}`
            : `${backendUrl}/api/export/pressure-log${queryParams}`;

        try {
            const response = await fetch(endpoint);
            if (!response.ok) throw new Error(`Backend Error: ${response.statusText}`);

            const csvText = await response.text();
            if (!csvText || csvText.trim().length === 0) {
                alert("Data log kosong pada rentang waktu tersebut.");
                return;
            }

            const fileName = `${dataType}_Rec_${new Date().getTime()}.csv`;

            // Logic Download Browser
            const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", fileName);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (error) {
            console.error(`Export Failed:`, error);
            alert(`Gagal download CSV. Cek Server.\nError: ${error.message}`);
        }
    }

    /**
     * setControlValue(buttonElement)
     * Dipanggil dari HTML (misal <button onclick="setControlValue(this)" data-input-id="set-temp">Set</button>)
     */
    // Ganti seluruh fungsi setControlValue Anda dengan kode ini:

    async function setControlValue(buttonElement) {
        try {
            const inputId = buttonElement.getAttribute('data-input-id');
            const param = inputId.replace('set-', '');
            const valueElem = document.getElementById(inputId);
            if (!valueElem) { alert('Elemen input tidak ditemukan.'); return; }

            const rawInput = valueElem.value.replace(',', '.');  // locale comma → dot
            const value = parseFloat(rawInput);
            if (isNaN(value)) { alert('Input tidak valid.'); return; }

            // --- LOGIC PENENTUAN ENDPOINT BARU (KRITIS) ---
            let endpoint = `/api/control/setpoint/${param}`; // Default untuk Suhu (Menu 1)

            // Cek apakah input adalah untuk kontrol TEKANAN (Menu 2)
            if (param === 'pressure' || param === 'pressure-sampling') {
                // Mengarahkan ke endpoint Batas Tekanan
                endpoint = `/api/control/pressure-limit/${param}`;
            }
            // ----------------------------------------------

            // --- MENGGUNAKAN FETCH (Pengganti Axios) ---
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: value })
            });

            const result = await response.json(); // Hasil respons JSON

            if (!response.ok) {
                throw new Error(`Server Error: ${result.message || response.statusText}`);
            }

            // --- Update config lokal & tampilan Monitoring ---
            if (param === 'temp')              config.setpoint             = value;
            if (param === 'sampling')          config.samplingTime         = value;
            if (param === 'kp')                config.kp                   = value;
            if (param === 'pressure')          config.pressureSetpoint     = value;
            if (param === 'pressure-sampling') config.pressureSamplingTime = value;

            // Update tampilan Setpoint Menu 1 (Temperature tab)
            if (dom.monitorSetTemp)  dom.monitorSetTemp.textContent  = `${config.setpoint} °C`;
            if (dom.monitorSampling) dom.monitorSampling.textContent = `${config.samplingTime} s`;
            if (dom.monitorKp)       dom.monitorKp.textContent       = `${config.kp}`;

            // Update tampilan Setpoint Menu 2 (Pressure tab) — immediate UI feedback
            const elSetPressure   = document.getElementById('monitor-set-pressure');
            const elPressSampling = document.getElementById('monitor-pressure-sampling');
            if (param === 'pressure' && elSetPressure) {
                elSetPressure.textContent = `${value.toFixed(2)} Bar`;
            }
            if (param === 'pressure-sampling' && elPressSampling) {
                elPressSampling.textContent = `${value} s`;
            }

            console.log(`[CONTROL SUCCESS] Setpoint ${param} = ${value}`);
            alert(result.message || `Setpoint ${param} berhasil dikirim.`);

        } catch (err) {
            console.error('Gagal mengirim setpoint:', err);
            alert('Gagal mengubah setpoint. Detail: Cek koneksi backend/endpoint.');
        }
    }

    /**
         * toggleSystem()
         * Dipanggil dari HTML tombol SIS Simulation ON/OFF
         */
    async function toggleSystem() {
        const btn = document.getElementById('btn-system-toggle');
        if (!btn) return;

        // Cek status saat ini dari config global
        // Jika config.isSystemRunning true, berarti mau MEMATIKAN
        const actionText = config.isSystemRunning ? "MEMATIKAN" : "MENYALAKAN";

        // 1. Konfirmasi User
        const userConfirmed = confirm(`Apakah Anda yakin ingin ${actionText} SIS Simulation?`);

        if (userConfirmed) {

            // 2. Ubah Status di Config
            config.isSystemRunning = !config.isSystemRunning;
            const statusString = config.isSystemRunning ? "ON" : "OFF";

            // 3. Update Tampilan Tombol (UI)
            if (config.isSystemRunning) {
                // Kondisi ON (Hijau)
                btn.innerText = "ON";
                btn.classList.remove('bg-red-500', 'hover:bg-red-600');
                btn.classList.add('bg-green-500', 'hover:bg-green-600');
            } else {
                // Kondisi OFF (Merah)
                btn.innerText = "OFF";
                btn.classList.remove('bg-green-500', 'hover:bg-green-600');
                btn.classList.add('bg-red-500', 'hover:bg-red-600');
            }

            console.log(`[SYSTEM] Status changed to ${statusString}`);

            // 4. Kirim ke Backend
            try {
                const response = await fetch(`${backendUrl}/api/sis-control`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        command: "SET_SIS_MODE",
                        status: statusString,
                        timestamp: new Date().toISOString()
                    }),
                });

                if (response.ok) {
                    console.log("[BACKEND] Data SIS diterima.");
                } else {
                    console.warn("[BACKEND] Respon error untuk SIS.");
                }
            } catch (error) {
                console.error('[BACKEND] Gagal konek:', error);
                alert("Warning: Status berubah di layar, tapi gagal lapor ke Backend!");
            }

        } else {
            console.log("[SYSTEM] Dibatalkan user.");
        }
    }

    // ======================================================================
    // SECTION CONTROL: SV Actuator + Stepper manual commands
    // ======================================================================

    // Local state tracking for SV button display
    const actuatorState = { sv1: 'OPEN', sv2: 'OPEN' };
    let stepperManualMode = false;

    /**
     * toggleActuator(type) — called by SV1/SV2 button onclick
     * ON (green) = valve OPEN; clicking → CLOSE (relay energized)
     * OFF (gray) = valve CLOSE; clicking → OPEN
     */
    async function toggleActuator(type) {
        const btn = document.getElementById(`${type}-status`);
        if (!btn) return;

        const isCurrentlyOpen = (actuatorState[type] === 'OPEN');
        const newValue = isCurrentlyOpen ? 1 : 0;    // 1 = CLOSE
        const newLabel = isCurrentlyOpen ? 'CLOSE' : 'OPEN';

        try {
            const res = await fetch(`${backendUrl}/api/sis-control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actuator: type, value: newValue })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message);

            // Optimistic update — confirmed by next poll
            actuatorState[type] = newLabel;
            applyActuatorButtonStyle(btn, newLabel);
            console.log(`[SECTION CTRL] ${type.toUpperCase()} → ${newLabel}`);
        } catch (err) {
            console.error('toggleActuator failed:', err);
            alert(`Gagal kirim perintah ${type.toUpperCase()}. Cek koneksi backend.`);
        }
    }

    /**
     * toggleSV1FromTemp() — called by Temperature "Set" button
     * Sends temperature setpoint to backend API + shows modal
     */
    async function toggleSV1FromTemp() {
        const tempInput = document.getElementById('set-temp');
        const tempValue = parseFloat(tempInput.value);
        
        if (isNaN(tempValue) || tempValue <= 0) {
            alert('Masukkan nilai temperature yang valid (> 0)');
            return;
        }

        try {
            const response = await fetch(`${backendUrl}/api/control/setpoint/temp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: tempValue })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log(`✅ Temperature Setpoint sent: ${tempValue}°C`);
                // Show modal instead of alert
                document.getElementById('modalTempValue').textContent = `${tempValue}°C`;
                showTemperatureModal();
            } else {
                alert(`❌ Error: ${data.message}`);
            }
        } catch (error) {
            console.error('Error sending temperature:', error);
            alert('❌ Failed to send temperature setpoint');
        }
    }

    /** Show temperature modal */
    function showTemperatureModal() {
        const modal = document.getElementById('tempSetModal');
        modal.classList.remove('hidden');
    }

    /** Close temperature modal */
    window.closeTemperatureModal = function() {
        const modal = document.getElementById('tempSetModal');
        modal.classList.add('hidden');
    }

    /** Set button color + text to match valve state */
    function applyActuatorButtonStyle(btn, state) {
        // keep the hover/cursor/transition classes, only swap bg color
        if (state === 'CLOSE') {
            btn.textContent = 'CLOSE';
            btn.classList.remove('bg-green-600', 'bg-gray-500');
            btn.classList.add('bg-red-500');
        } else {
            btn.textContent = 'OPEN';
            btn.classList.remove('bg-red-500', 'bg-gray-500');
            btn.classList.add('bg-green-600');
        }
    }

    /**
     * sendStepperCommand() — sends stepper_manual % to BPCS
     */
    async function sendStepperCommand() {
        const input = document.getElementById('stepper-value');
        if (!input) return;
        const pct = parseFloat(input.value);
        if (isNaN(pct)) { alert('Masukkan nilai % (20-80).'); return; }

        try {
            const res = await fetch(`${backendUrl}/api/control/stepper`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: pct, mode: 'manual' })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message);
            stepperManualMode = true;
            const modeBtn = document.getElementById('btn-stepper-mode');
            if (modeBtn) { modeBtn.textContent = 'AUTO'; modeBtn.classList.replace('bg-blue-600', 'bg-orange-500'); }
            console.log(`[STEPPER] Manual → ${pct}%`);
        } catch (err) {
            console.error('sendStepperCommand failed:', err);
            alert('Gagal kirim perintah stepper.');
        }
    }

    /**
     * toggleStepperMode() — switch between MANUAL and AUTO
     */
    async function toggleStepperMode() {
        const modeBtn = document.getElementById('btn-stepper-mode');
        if (stepperManualMode) {
            try {
                const res = await fetch(`${backendUrl}/api/control/stepper`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'auto' })
                });
                const result = await res.json();
                if (!res.ok) throw new Error(result.message);
                stepperManualMode = false;
                if (modeBtn) { modeBtn.textContent = 'MANUAL'; modeBtn.classList.replace('bg-orange-500', 'bg-blue-600'); }
                console.log('[STEPPER] Mode → AUTO (PID resumed)');
            } catch (err) {
                console.error('toggleStepperMode failed:', err);
                alert('Gagal ubah mode stepper.');
            }
        } else {
            sendStepperCommand();
        }
    }

    function toggleRecording(type) {
        const state = recordingState[type];

        // UPDATE ID: Sesuaikan dengan ID tombol di Footer HTML Anda
        const btnId = type === 'temperature' ? 'btn-footer-rec-temp' : 'btn-footer-rec-pressure';
        const statusId = type === 'temperature' ? 'rec-status-temp' : 'rec-status-pressure';

        const btn = document.getElementById(btnId);
        const statusElem = document.getElementById(statusId);

        if (!state.isRecording) {
            // === MULAI RECORD ===
            state.isRecording = true;

            // Simpan Waktu Lokal (WIB)
            const now = new Date();
            const offset = now.getTimezoneOffset() * 60000;
            state.startTime = (new Date(now - offset)).toISOString().slice(0, 19).replace('T', ' ');
            state.stopTime = null; // Reset stop time

            // Update UI Tombol (Jadi Merah & Berkedip)
            if (btn) {
                btn.textContent = "STOP REC";
                // Hapus class abu-abu, tambah class merah
                btn.classList.remove('bg-gray-500', 'hover:bg-gray-600');
                btn.classList.add('bg-red-600', 'hover:bg-red-700', 'animate-pulse');
            }
            // Update Teks Status Kecil
            if (statusElem) statusElem.textContent = `REC: ${state.startTime.split(' ')[1]}`;

            console.log(`[REC] ${type} STARTED at ${state.startTime}`);

        } else {
            // === STOP RECORD ===
            state.isRecording = false;

            const now = new Date();
            const offset = now.getTimezoneOffset() * 60000;
            state.stopTime = (new Date(now - offset)).toISOString().slice(0, 19).replace('T', ' ');

            // Update UI Tombol (Kembali Abu-abu)
            if (btn) {
                btn.textContent = "START REC";
                btn.classList.remove('bg-red-600', 'hover:bg-red-700', 'animate-pulse');
                btn.classList.add('bg-gray-500', 'hover:bg-gray-600');
            }

            // Bersihkan status
            if (statusElem) statusElem.textContent = "";

            console.log(`[REC] ${type} STOPPED at ${state.stopTime}`);

            // Notifikasi ke User
            alert(`Recording Selesai!\nData terekam dari: ${state.startTime.split(' ')[1]} s/d ${state.stopTime.split(' ')[1]}.\n\nSilakan klik tombol "Export Data" untuk mengunduh.`);
        }
    }

    /**
     * showTab(tabName) - navigasi sederhana antar tab (temperature | pressure)
     */
    function showTab(tabName) {
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
        document.querySelectorAll('nav button').forEach(button => {
            button.classList.remove('tab-active', 'bg-blue-900', 'text-white');
            button.classList.add('bg-blue-800', 'text-gray-300', 'hover:bg-blue-700');
        });

        const tabElem = document.getElementById(`${tabName}-tab`);
        if (tabElem) tabElem.classList.remove('hidden');

        const activeButtonId = `tab-${tabName === 'temperature' ? 'temp' : 'pressure'}`;
        const activeBtn = document.getElementById(activeButtonId);
        if (activeBtn) {
            activeBtn.classList.add('tab-active', 'bg-blue-900', 'text-white');
            activeBtn.classList.remove('bg-blue-800', 'text-gray-300', 'hover:bg-blue-700');
        }

        config.activeTab = tabName;
    }

    function logoutUser() {
        const modal = document.getElementById('logout-modal');
        if (modal) {
            modal.classList.remove('hidden'); // Tampilkan modal
        } else {
            // Fallback jika modal HTML belum dipasang
            if (confirm("Logout?")) confirmLogout();
        }
    }

    function confirmLogout() {
        localStorage.removeItem('currentUser');
        window.location.href = 'auth.html';
    }

    function cancelLogout() {
        const modal = document.getElementById('logout-modal');
        if (modal) {
            modal.classList.add('hidden'); // Sembunyikan modal
        }
    }


    // ======================================================================
    // 4) HEADER CLOCK / TIME DISPLAY
    // ======================================================================
    function updateHeaderTime() {
        const now = new Date();
        const dateOptions = { day: 'numeric', month: 'long', year: 'numeric' };
        const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };

        if (dom.currentDate) dom.currentDate.textContent = now.toLocaleDateString('en-US', dateOptions);
        if (dom.currentTime) dom.currentTime.textContent = now.toLocaleTimeString('en-US', timeOptions);
    }

    // ======================================================================
    // 5) CHARTS: Initialization & helpers
    // ======================================================================
    function initializeCharts() {
        if (chartsInitialized) return;

        // Temperature chart (line)
        const tempCanvas = document.getElementById('tempChartCanvas');
        if (tempCanvas) {
            const ctx = tempCanvas.getContext('2d');
            tempChart = new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Suhu (°C)', data: [], borderColor: '#ef4444', tension: 0.3 }] },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false, 
                    scales: { 
                        y: { 
                            beginAtZero: true,
                            min: 0,
                            max: 150,
                            ticks: { stepSize: 30 }
                        } 
                    } 
                }
            });
        }

        // Pressure + SV charts (line for pressure, bar for SV)
        const pressureElem = document.getElementById('pressureChart');
        if (pressureElem) {
            const ctxP = pressureElem.getContext('2d');
            pressureChart = new Chart(ctxP, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Tekanan (Bar)', data: [], borderColor: '#dc2626', tension: 0.1, pointRadius: 2 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    aspectRatio: 1.5,
                    scales: { x: { title: { display: true, text: 'Time (Seconds)' } }, y: { beginAtZero: true, max: MAX_PRESSURE_BAR + 0.5 } },
                    plugins: { legend: { display: true, position: 'top' } },
                    animation: false
                }
            });
        }

        const sv1Elem = document.getElementById('sv1Chart');
        if (sv1Elem) {
            const ctx1 = sv1Elem.getContext('2d');
            sv1Chart = new Chart(ctx1, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'SV1 Status', data: [], borderColor: '#3b82f6', tension: 0.0, pointRadius: 2 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    aspectRatio: 1.5,
                    scales: { y: { beginAtZero: true, max: 1.2, ticks: { stepSize: 1 }, title: { display: true, text: 'Status (0:CLOSE / 1:OPEN)' } } },
                    plugins: { legend: { display: true, position: 'top' } },
                    animation: false
                }
            });
        }

        const sv2Elem = document.getElementById('sv2Chart');
        if (sv2Elem) {
            const ctx2 = sv2Elem.getContext('2d');
            sv2Chart = new Chart(ctx2, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'SV2 Status', data: [], borderColor: '#10b981', tension: 0.0, pointRadius: 2 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    aspectRatio: 1.5,
                    scales: { y: { beginAtZero: true, max: 1.2, ticks: { stepSize: 1 }, title: { display: true, text: 'Status (0:CLOSE / 1:OPEN)' } } },
                    plugins: { legend: { display: true, position: 'top' } },
                    animation: false
                }
            });
        }

        chartsInitialized = true;
    }

    function updateChart(chartInstance, label, value, maxPoints = MAX_DATA_POINTS) {
        if (!chartInstance) return;
        chartInstance.data.labels.push(label);
        chartInstance.data.datasets[0].data.push(value);
        if (chartInstance.data.labels.length > maxPoints) {
            chartInstance.data.labels.shift();
            chartInstance.data.datasets[0].data.shift();
        }
        chartInstance.update('none');
    }

    // ======================================================================
    // 6) PRESSURE MONITORING: gauge, status, logs, simulation loop
    // ======================================================================

    function updateGauge(pressure) {
        if (!dom.gaugeNeedle) return;

        // Batas Atas Skala (Sesuai request User: 2.4)
        const maxGaugeValue = MAX_PRESSURE_BAR;

        // SUDUT BARU: Setengah Lingkaran
        // -90 derajat = Jam 9 (Kiri Mentok / 0 Bar)
        // +90 derajat = Jam 3 (Kanan Mentok / 2.4 Bar)
        const minAngle = -90;
        const maxAngle = 90;

        // Hitung rasio (0.0 sampai 1.0)
        // Math.min/max menjaga agar jarum tidak bablas kalau pressure > 2.4
        const ratio = Math.min(Math.max(pressure / maxGaugeValue, 0), 1);

        // Hitung sudut jarum
        const angle = minAngle + (ratio * (maxAngle - minAngle));

        // Update Rotasi Jarum
        // translate(100, 90) adalah titik pusat putaran (pivot) sesuai SVG di HTML
        dom.gaugeNeedle.setAttribute('transform', `translate(100, 90) rotate(${angle})`);

        // Update Angka Digital di Tengah
        if (dom.currentPressureDisplay) {
            dom.currentPressureDisplay.textContent = pressure.toFixed(2);

            // Opsional: Ubah warna angka jadi merah jika tekanan tinggi
            if (pressure > 2.0) {
                dom.currentPressureDisplay.setAttribute('fill', '#dc2626'); // Merah
            } else {
                dom.currentPressureDisplay.setAttribute('fill', '#1f2937'); // Hitam Abu
            }
        }
    }

    function updateStatusDisplays(sv1, sv2, buzzer) {
        if (dom.sv1StatusElem) {
            dom.sv1StatusElem.textContent = sv1;
            // FIX: Set full button classes so bg color is correct (strips old bg-* first)
            dom.sv1StatusElem.className = sv1 === 'OPEN'
                ? 'text-white text-xs px-2 py-0.5 rounded bg-green-600 font-bold'
                : 'text-white text-xs px-2 py-0.5 rounded bg-gray-500 font-bold';
        }
        if (dom.sv2StatusElem) {
            dom.sv2StatusElem.textContent = sv2;
            dom.sv2StatusElem.className = sv2 === 'OPEN'
                ? 'text-white text-xs px-2 py-0.5 rounded bg-green-600 font-bold'
                : 'text-white text-xs px-2 py-0.5 rounded bg-gray-500 font-bold';
        }
        if (dom.buzzerStatusElem) {
            dom.buzzerStatusElem.textContent = buzzer;
            dom.buzzerStatusElem.className = `font-bold px-2 rounded ${buzzer === 'ON' ? 'buzzer-on' : 'buzzer-off'}`;
        }
        // FIX: Also update the alarm-status text in the Solenoid Status box
        const alarmElem = document.getElementById('alarm-status');
        if (alarmElem) {
            alarmElem.textContent = buzzer;
            alarmElem.className = `monitor-value font-bold ${buzzer === 'ON' ? 'text-red-600' : 'text-gray-600'}`;
        }
    }

    // frontend.js (Koreksi Aksi B: Menargetkan elemen Log Data Pressure yang benar)

    function addPressureLogEntry(samplingSec, counter, time, pressure, voltage) {

        // --- KOREKSI KRITIS 1: UBAH SELEKTOR DOM ---
        // Pastikan ID 'pressure-log-table-body' sudah diambil ke dalam dom.logDataPressureBody di initDOM
        if (!dom.logDataPressureBody) {
            console.error("Elemen Log Data Pressure Body tidak ditemukan di DOM!");
            return;
        }
        const tbody = dom.logDataPressureBody; // Menggunakan selektor khusus Menu 2
        // --- END KOREKSI 1 ---

        // Perbaikan: Pastikan voltage dikonversi ke number sebelum dikalikan (untuk safety)
        const voltageNum = parseFloat(voltage);

        // Insert on top
        const newRow = tbody.insertRow(0);
        newRow.innerHTML = `
        <td>${counter}</td>
        <td>${samplingSec} Sec.</td>
        <td>${time}</td>
        <td class="${pressure > pressureState.P_LIMIT ? 'text-red-600 font-bold' : 'text-gray-800'}">${pressure.toFixed(2)} Bar</td>
        
        <td>${(voltageNum * 1000).toFixed(0)} mV</td> 
        `;

        // Trim older rows to MAX_DATA_POINTS
        while (tbody.rows.length > MAX_DATA_POINTS) { tbody.deleteRow(MAX_DATA_POINTS); }
    }

    function updatePressureCharts(pressure, sv1, sv2, timeLabel) {
        const t = timeLabel; // current time label

        // convert SV status to numeric
        const sv1Value = sv1 === 'OPEN' ? 1 : 0;
        const sv2Value = sv2 === 'OPEN' ? 1 : 0;

        // push into state arrays
        pressureState.chartData.pressure.labels.push(t); pressureState.chartData.pressure.data.push(pressure);
        pressureState.chartData.sv1.labels.push(t); pressureState.chartData.sv1.data.push(sv1Value);
        pressureState.chartData.sv2.labels.push(t); pressureState.chartData.sv2.data.push(sv2Value);

        if (pressureChart) updateChart(pressureChart, t, pressure);
        if (sv1Chart) updateChart(sv1Chart, t, sv1Value);
        if (sv2Chart) updateChart(sv2Chart, t, sv2Value);

        // trim
        if (pressureState.chartData.pressure.data.length > MAX_DATA_POINTS) {
            pressureState.chartData.pressure.labels.shift(); pressureState.chartData.pressure.data.shift();
            pressureState.chartData.sv1.labels.shift(); pressureState.chartData.sv1.data.shift();
            pressureState.chartData.sv2.labels.shift(); pressureState.chartData.sv2.data.shift();
        }

        // update Chart.js instances
        if (pressureChart) {
            pressureChart.data.labels = [...pressureState.chartData.pressure.labels];
            pressureChart.data.datasets[0].data = [...pressureState.chartData.pressure.data];
            // update x axis max to keep view consistent
            pressureChart.update('none');
        }
        if (sv1Chart) {
            sv1Chart.data.labels = [...pressureState.chartData.sv1.labels];
            sv1Chart.data.datasets[0].data = [...pressureState.chartData.sv1.data];
            sv1Chart.update('none');
        }
        if (sv2Chart) {
            sv2Chart.data.labels = [...pressureState.chartData.sv2.labels];
            sv2Chart.data.datasets[0].data = [...pressureState.chartData.sv2.data];
            sv2Chart.update('none');
        }
    }

    // Pressure monitoring simulation loop (calls itself with setTimeout)
    function pressureMonitoringLoop() {
        // Compute flows based on SV statuses
        const INLET_FLOW = (pressureState.SV1_STATUS === 'OPEN' && pressureState.SV2_STATUS === 'OPEN') ? 0.2 : 0.05;
        const OUTLET_FLOW = 0.1;
        const lastPressure = (pressureState.chartData.pressure.data.length > 0)
            ? pressureState.chartData.pressure.data.slice(-1)[0]
            : 1.0;

        const pressureChange = (INLET_FLOW - OUTLET_FLOW) * (pressureState.T_SAMPLING / 10);
        const noise = (Math.random() - 0.5) * 0.05;
        let currentPressure = lastPressure + pressureChange + noise;
        currentPressure = Math.max(0.0, Math.min(3.0, currentPressure));
        currentPressure = parseFloat(currentPressure.toFixed(2));

        // Update valve statuses and buzzer
        pressureState.SV1_STATUS = (currentPressure > pressureState.P_LIMIT) ? 'CLOSE' : 'OPEN';
        pressureState.SV2_STATUS = (currentPressure > pressureState.P_LIMIT) ? 'CLOSE' : 'OPEN';
        pressureState.BUZZER_STATUS = (currentPressure > pressureState.P_LIMIT * 1.05 || currentPressure < pressureState.A_LIMIT * 0.95) ? 'ON' : 'OFF';

        // Time & voltage conversion (original logic preserved)
        const now = new Date();
        const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        const voltage = (currentPressure * (5000 / pressureState.P_UNIT) / 1000);

        // UI updates
        updateGauge(currentPressure);
        updateStatusDisplays(pressureState.SV1_STATUS, pressureState.SV2_STATUS, pressureState.BUZZER_STATUS);

        // Log entry
        App.pressureLogCounter = (App.pressureLogCounter || 0) + 1;
        addPressureLogEntry(pressureState.T_SAMPLING, App.pressureLogCounter, timeString, currentPressure, voltage);

        // Charts
        updatePressureCharts(currentPressure, pressureState.SV1_STATUS, pressureState.SV2_STATUS);

        // (Optional) Save to Firestore if that function exists globally
        if (typeof window.saveDataToFirestore === 'function') {
            window.saveDataToFirestore({
                menu: 'pressure',
                samplingTime: pressureState.simulationTime,
                pressure: currentPressure,
                voltage: parseFloat(voltage.toFixed(2)),
                sv1: pressureState.SV1_STATUS,
                sv2: pressureState.SV2_STATUS,
                buzzer: pressureState.BUZZER_STATUS
            });
        }

        pressureState.simulationTime += pressureState.T_SAMPLING;
        // schedule next iteration
        monitoringTimerId = setTimeout(pressureMonitoringLoop, pressureState.T_SAMPLING * 1000);
    }

    function startPressureMonitoring() {
        if (monitoringTimerId) return; // already running
        pressureState.simulationTime = 0;
        pressureState.chartData = { pressure: { labels: [], data: [] }, sv1: { labels: [], data: [] }, sv2: { labels: [], data: [] } };
        monitoringTimerId = setTimeout(pressureMonitoringLoop, pressureState.T_SAMPLING * 1000);
    }

    function stopPressureMonitoring() {
        if (monitoringTimerId) {
            clearTimeout(monitoringTimerId);
            monitoringTimerId = null;
        }
    }

    // ======================================================================
    // 7) TEMPERATURE: update from backend, tank visualization, logs, chart update
    // ======================================================================
    function renderLogTable(logData, tableBodyElem) {
        if (!tableBodyElem) return;
        tableBodyElem.innerHTML = '';
        logData.forEach(log => {
            const row = tableBodyElem.insertRow();
            row.innerHTML = `<td class="py-1 px-1">${log.no}</td><td>${log.sampling} Sec</td><td>${log.time}</td><td>${log.temp} °C</td><td>${log.voltage} mV</td>`;
        });
    }

    function updateTempVisualization(currentTemp) {
        // update current temp display
        if (dom.monitorCurrentTemp) dom.monitorCurrentTemp.textContent = `${currentTemp.toFixed(2)} °C`;

        // Update thermometer liquid height (0-150°C scale)
        const MAX_THERMOMETER_TEMP = 150;
        const thermometerHeightPercent = Math.min(100, (currentTemp / MAX_THERMOMETER_TEMP) * 100);
        const thermometerLiquid = document.getElementById('thermometer-liquid');
        if (thermometerLiquid) thermometerLiquid.style.height = `${thermometerHeightPercent}%`;
        
        // Update thermometer value display
        const thermometerValue = document.getElementById('thermometer-display-value');
        if (thermometerValue) thermometerValue.textContent = `${currentTemp.toFixed(2)} °C`;
    }

    // ======================================================================
    // 8) BACKEND POLLING: updateDataFromBackend (VERSI FIXED)
    // ======================================================================
    async function updateDataFromBackend() {
        try {
            const resp = await fetch(`${backendUrl}/api/latest-data`);
            if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
            const data = await resp.json();

            // Guard: ensure data object
            if (!data || Object.keys(data).length === 0) return;

            // --- 1. TEMPERATURE HANDLING ---
            // Cek apakah data ini punya nilai Temperature yang VALID (Tidak Null)
            if (data.temperature !== null && data.temperature !== undefined) {

                const currentTemp = parseFloat(data.temperature);

                // FIXED: Ambil voltage dari kolom 'voltage_temp' (bukan 'voltage')
                const voltageTemp = data.voltage_temp !== null ? parseFloat(data.voltage_temp) : 0;

                const timeLabel = new Date().toLocaleTimeString('id-ID', { hour12: true });

                if (config.activeTab === 'temperature') {
                    // Update UI Angka
                    if (dom.monitorCurrentTemp) dom.monitorCurrentTemp.textContent = `${currentTemp.toFixed(2)} °C`;
                    // Validasi Actuator (Opsional, pakai SV1 status)
                    if (dom.actuatorValidation) dom.actuatorValidation.textContent = `${(data.sv1_status ? 100 : 0)}%`;

                    // Tank Visualization
                    updateTempVisualization(currentTemp);

                    // Log Logic
                    config.tempLogCounter++;
                    config.tempLogData.unshift({
                        no: config.tempLogCounter,
                        sampling: config.samplingTime,
                        time: timeLabel,
                        temp: currentTemp.toFixed(2),
                        voltage: voltageTemp.toFixed(2) // Updated variable
                    });

                    if (config.tempLogData.length > config.tempMaxLogEntries) config.tempLogData.pop();
                    if (dom.logTableBody) renderLogTable(config.tempLogData, dom.logTableBody);

                    // Chart Update
                    if (tempChart) updateChart(tempChart, timeLabel, currentTemp);
                }
            }

            // --- 2. PRESSURE HANDLING ---
            // Cek apakah data ini punya nilai Pressure yang VALID (Tidak Null)
            if (data.pressure !== null && data.pressure !== undefined) {

                const currentPressure = parseFloat(data.pressure);
                // FIX: convert integer 0/1 from DB → 'OPEN'/'CLOSE'
                const sv1Status = data.sv1_status === 1 ? 'OPEN' : 'CLOSE';
                const sv2Status = data.sv2_status === 1 ? 'OPEN' : 'CLOSE';
                const buzzerVal  = data.buzzer_status === 1 ? 'ON' : 'OFF';
                const voltagePress = data.voltage_pressure != null ? parseFloat(data.voltage_pressure) : 0;
                const timeLabel    = new Date().toLocaleTimeString('id-ID', { hour12: false });

                // --- Sync SV button visual state from MC (refresh-safe) ---
                const sv1Btn = document.getElementById('sv1-status');
                const sv2Btn = document.getElementById('sv2-status');
                if (sv1Btn && actuatorState.sv1 !== sv1Status) {
                    actuatorState.sv1 = sv1Status;
                    applyActuatorButtonStyle(sv1Btn, sv1Status);
                }
                if (sv2Btn && actuatorState.sv2 !== sv2Status) {
                    actuatorState.sv2 = sv2Status;
                    applyActuatorButtonStyle(sv2Btn, sv2Status);
                }

                // FIX: Always update the RT sensor readings + solenoid status panel
                // These are shown on the pressure tab regardless of which sub-view is active
                const rtPressElem = document.getElementById('pressure-rt-pressure');
                const rtTempElem  = document.getElementById('pressure-rt-temp');
                if (rtPressElem) rtPressElem.textContent = `${currentPressure.toFixed(2)} Bar`;
                if (rtTempElem && data.temperature != null) {
                    rtTempElem.textContent = `${parseFloat(data.temperature).toFixed(2)} °C`;
                }

                // Always keep SV/Buzzer status current (buttons are always visible on pressure tab)
                updateStatusDisplays(sv1Status, sv2Status, buzzerVal);

                // FIX: use the pressure tab's own sampling input, not the temperature tab's
                const pressSamplingInput = document.getElementById('set-pressure-sampling');
                const currentSamplingTime = pressSamplingInput ? pressSamplingInput.value : 60;

                // Gauge, log table and charts only when on the pressure tab
                if (config.activeTab === 'pressure') {
                    updateGauge(currentPressure);

                    if (chartsInitialized) {
                        pressureState.logCounter++;
                        addPressureLogEntry(
                            currentSamplingTime,
                            pressureState.logCounter,
                            timeLabel,
                            currentPressure,
                            voltagePress
                        );
                        updatePressureCharts(currentPressure, sv1Status, sv2Status, timeLabel);
                    }
                }
            }

        } catch (err) {
            console.error('Gagal mengambil data dari backend:', err);
        }
    }

    // ======================================================================
    // 9) APPLICATION INITIALIZER
    // ======================================================================
    function init() {
        // 1) Fill DOM refs
        initDOM();
        bindEvents();
        // 2) Show user if available
        const storedUser = JSON.parse(localStorage.getItem('currentUser'));
        if (storedUser && dom.userInfo) dom.userInfo.textContent = storedUser.username || '';

        // 3) Setup UI initial values
        if (dom.monitorSetTemp) dom.monitorSetTemp.textContent = `${config.setpoint} °C`;
        if (dom.monitorSampling) dom.monitorSampling.textContent = `${config.samplingTime} s`;
        if (dom.monitorKp) dom.monitorKp.textContent = config.kp;

        // 4) Initialize charts
        initializeCharts();

        // 5) Set default tab (temperature)
        showTab(config.activeTab);

        // 6) Start header clock
        updateHeaderTime();
        clockTimerId = setInterval(updateHeaderTime, 1000);

        // 7) Start backend polling (1s interval as original)
        updateDataFromBackend(); // fire once immediately
        pollingTimerId = setInterval(updateDataFromBackend, 1000);

        // 8) expose functions that may be called by HTML
        exposeGlobals();
    }

    // ======================================================================
    // 10) Cleanup function (if needed)
    // ======================================================================
    function destroy() {
        if (clockTimerId) clearInterval(clockTimerId);
        if (pollingTimerId) clearInterval(pollingTimerId);
        if (monitoringTimerId) clearTimeout(monitoringTimerId);

        // destroy Chart.js instances
        [tempChart, pressureChart, sv1Chart, sv2Chart].forEach(c => { if (c && typeof c.destroy === 'function') c.destroy(); });
    }

    // Public API (internal use)
    return {
        init,
        destroy,
        // expose these for testing or debug
        _internal: { pressureState, config }
    };

})();

// Initialize application when DOM ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

