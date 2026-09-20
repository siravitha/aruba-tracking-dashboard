const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { Server } = require("socket.io");
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');

const CONFIG = {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    pollingInterval: Number(process.env.POLL_INTERVAL_MS || 10000),
    dbFile: path.join(__dirname, process.env.DB_FILE || 'tracker_db.json')
};

const arubaClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000,
    headers: { Accept: 'application/json' }
});

// --- ส่วนจัดการข้อมูล (Database) ---
const DB_FILE = CONFIG.dbFile;

function initData() {
    if (!fs.existsSync(DB_FILE)) {
        // อัปเดตพิกัดจำลองให้เป็นแถว อุดรธานี (โรงพยาบาลอุดรธานี และรอบๆ)
        const initialData = { devices: [
            { id: 'AP-01', name: 'Udon-Controller-AP', type: 'ap', ip: '192.168.1.100' },
            { id: 'BCN-TEST', name: 'Visitor-Badge-A', type: 'beacon', battery: 95 }
        ]};
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
    }
}
initData();

// --- ส่วนของ Report Log ---
let syncHistory = []; 
const MAX_LOGS = 50;

function addReportLog(sourceType, status, deviceCount = 0, detail = "") {
    const entry = {
        time: new Date().toLocaleTimeString(),
        source: sourceType,
        status: status,     
        count: deviceCount,
        detail: detail
    };
    syncHistory.unshift(entry); 
    if (syncHistory.length > MAX_LOGS) syncHistory.pop(); 
    io.emit('system-reports', { logs: syncHistory });
}

// --- เริ่มต้น Server ---
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

function readDB() {
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        if (!raw.trim()) return { devices: [] };
        const parsed = JSON.parse(raw);
        if (!parsed.devices) parsed.devices = [];
        return parsed;
    } catch (error) {
        return { devices: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/api/devices', (req, res) => {
    const data = readDB();
    res.json(data.devices || []);
});

app.post('/api/devices', (req, res) => {
    const { type, name, ip } = req.body || {};
    if (!type || !name) {
        return res.status(400).json({ error: 'Type and name are required' });
    }

    const data = readDB();
    const id = type === 'ap' ? `AP-${Date.now()}` : `BCN-${Date.now()}`;
    const newDevice = {
        id,
        name,
        type,
        ip: type === 'ap' ? (ip || 'DHCP') : undefined,
        status: 'online',
        lat: 17.4099 + (Math.random() - 0.5) * 0.002,
        lng: 102.8026 + (Math.random() - 0.5) * 0.002,
        battery: type === 'beacon' ? 100 : undefined
    };

    if (type === 'beacon' && !newDevice.battery) newDevice.battery = 100;
    data.devices.push(newDevice);
    writeDB(data);
    io.emit('aruba-sync', { timestamp: new Date(), devices: data.devices });
    addReportLog('Manual Add', 'Success', data.devices.length, `Added ${name} (${type})`);
    return res.status(201).json(newDevice);
});

console.log("Starting Aruba Instant Tracking Server...");

// --- ฟังก์ชันดึงข้อมูลจริงจาก Aruba Virtual Controller ---
function extractToken(payload) {
    if (!payload) return null;
    if (payload.access_token) return payload.access_token;
    if (payload.token) return payload.token;
    if (payload.session_token) return payload.session_token;
    if (payload.data) return extractToken(payload.data);
    return null;
}

function normalizeArubaArray(payload, keys) {
    if (!payload) return [];

    const toArray = (value) => {
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') return Object.values(value);
        return value ? [value] : [];
    };

    for (const key of keys) {
        if (payload[key]) return toArray(payload[key]);
        if (payload.data && payload.data[key]) return toArray(payload.data[key]);
    }

    for (const key of Object.keys(payload || {})) {
        if (Array.isArray(payload[key])) return payload[key];
    }

    if (payload.data && typeof payload.data === 'object') {
        for (const key of Object.keys(payload.data)) {
            if (Array.isArray(payload.data[key])) return payload.data[key];
        }
    }

    return [];
}

async function loginToAruba(baseUrl) {
    const loginCandidates = [
        `${baseUrl}/api/v2/auth/login`,
        `${baseUrl}/api/v2/login`,
        `${baseUrl}/api/login`,
        `${baseUrl}/api/auth/login`,
        `${baseUrl}/api/v1/login`
    ];

    const payloadVariants = [
        { username: process.env.ARUBA_USER, password: process.env.ARUBA_PASS },
        { user: process.env.ARUBA_USER, password: process.env.ARUBA_PASS },
        { username: process.env.ARUBA_USER, passwd: process.env.ARUBA_PASS },
    ];

    for (const loginUrl of loginCandidates) {
        for (const body of payloadVariants) {
            try {
                const loginRes = await arubaClient.post(loginUrl, body, {
                    headers: { 'Content-Type': 'application/json' }
                });
                const token = extractToken(loginRes.data);
                if (token) {
                    return { token, url: loginUrl, data: loginRes.data };
                }
            } catch (error) {
                const msg = error.response?.data || error.message;
                console.log(`>>> Login attempt failed for ${loginUrl}: ${msg}`);
            }
        }

        try {
            const formPayload = new URLSearchParams({
                username: process.env.ARUBA_USER,
                password: process.env.ARUBA_PASS
            });
            const loginRes = await arubaClient.post(loginUrl, formPayload, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const token = extractToken(loginRes.data);
            if (token) {
                return { token, url: loginUrl, data: loginRes.data };
            }
        } catch (error) {
            console.log(`>>> Form-login attempt failed for ${loginUrl}: ${error.response?.data || error.message}`);
        }
    }

    return null;
}

async function syncWithAruba() {
    const baseUrl = process.env.ARUBA_URL;
    if (!baseUrl) return null;

    try {
        console.log(">>> Syncing with Aruba API...");

        const loginResult = await loginToAruba(baseUrl);
        if (!loginResult) {
            throw new Error("No compatible Aruba login endpoint responded successfully");
        }

        const { token, url: loginUrl } = loginResult;
        console.log(`>>> Aruba login success via ${loginUrl}`);

        if (!token) throw new Error("Login failed - No token received");

        const headers = { Authorization: `Bearer ${token}` };
        const liveDevices = [];
        let foundAPs = 0, foundBeacons = 0;

        const apEndpoints = [
            `${baseUrl}/api/v2/wireless/monitor/access_points`,
            `${baseUrl}/api/v1/access_points`,
            `${baseUrl}/api/v2/access_points`
        ];

        for (const apUrl of apEndpoints) {
            try {
                const apRes = await arubaClient.get(apUrl, { headers });
                const aps = normalizeArubaArray(apRes.data, ['access_points', 'wireless_aps', 'aps']);
                foundAPs = aps.length;

                aps.forEach(d => {
                    liveDevices.push({
                        id: d.mac_addr || d.mac || d.id || `AP-${Date.now()}-${Math.random()}`,
                        name: d.name || d.model || 'AP-Unknown',
                        type: 'ap',
                        ip: d.ip_addr || d.ip || 'DHCP',
                        status: 'online',
                        lat: d.lat || 17.4099 + (Math.random() * 0.002),
                        lng: d.lng || 102.8026 + (Math.random() * 0.002)
                    });
                });
                break;
            } catch (e) {
                console.log(`>>> AP endpoint failed for ${apUrl}: ${e.message}`);
            }
        }

        const beaconEndpoints = [
            `${baseUrl}/api/v2/wireless/monitor/bluetooth_beacons`,
            `${baseUrl}/api/v1/bluetooth_beacons`,
            `${baseUrl}/api/v2/bluetooth_beacons`
        ];

        for (const beaconUrl of beaconEndpoints) {
            try {
                const beaconRes = await arubaClient.get(beaconUrl, { headers });
                const beacons = normalizeArubaArray(beaconRes.data, ['bluetooth_beacons', 'beacons', 'clients']);
                foundBeacons = beacons.length;

                beacons.forEach(b => {
                    liveDevices.push({
                        id: b.mac_addr || b.mac || b.id || `BCN-${Date.now()}-${Math.random()}`,
                        name: b.name || `BCN-${(b.mac_addr || b.mac || 'unknown').slice(-6)}`,
                        type: 'beacon',
                        battery: b.battery_life || b.battery || 100,
                        status: 'online',
                        lat: b.lat || 17.4099 + (Math.random() * 0.002),
                        lng: b.lng || 102.8026 + (Math.random() * 0.002)
                    });
                });
                break;
            } catch (e) {
                console.log(`>>> Beacon endpoint failed for ${beaconUrl}: ${e.message}`);
            }
        }

        addReportLog('Aruba API', 'Success', liveDevices.length, `Found: ${foundAPs} APs, ${foundBeacons} Beacons`);
        return liveDevices;

    } catch (error) {
        console.error(">>> Aruba API Failed:", error.response?.data || error.message);
        addReportLog('Aruba API', 'Error', 0, "Authentication Failed or Connection Refused");
        return null;
    }
}

// --- ฟังก์ชันจำลองข้อมูล (Mock Data - ปรับเป็น อุดรธานี) ---
function runSimulation() {
    let data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    
    // พิกัดประมาณ โรงพยาบาลอุดรธานี (17.409, 102.802)
    const baseLat = 17.4099; 
    const baseLng = 102.8026;

    data.devices.forEach(d => {
        if (d.type === 'beacon') {
            // ถ้ายังไม่มีพิกัด ให้เริ่มสุ่มเดินเล่นรอบโรงพยาบาล
            if (!d.lat) { d.lat = baseLat + Math.random() * 0.001; d.lng = baseLng + Math.random() * 0.001; } 
            d.lat += (Math.random() - 0.5) * 0.0002;
            d.lng += (Math.random() - 0.5) * 0.0002;
            
            if(Math.random() > 0.9 && d.battery > 10) d.battery -= 1;
        } else {
            // AP ยืนนิ่งๆ แถวโรงพยาบาล
            if (!d.lat) { d.lat = baseLat + 0.0005; d.lng = baseLng + 0.0002; } 
        }
    });

    fs.writeFileSync(DB_FILE, JSON.stringify(data));
    
    addReportLog('Simulation Mode', 'Info', data.devices.length, "Using local mock data (Aruna offline?)");
    
    return data.devices;
}

// --- Loop ทำงานหลัก (10 วินาที) ---
setInterval(async () => {
    addReportLog('Polling', 'Pending', 0, "Checking connection..."); 

    const realData = await syncWithAruba();
    let finalDevices = [];

    if (realData === null) {
        finalDevices = runSimulation();
    } else {
        finalDevices = realData.map(d => {
            if (d.type === 'ap' && (!d.lat || !d.lng || d.lat === 0 || d.lng === 0)) {
                d.lat = 17.4099 + Math.random() * 0.001;
                d.lng = 102.8026 + Math.random() * 0.001;
            }
            return d;
        });
    }

    io.emit('aruba-sync', { timestamp: new Date(), devices: finalDevices });
}, CONFIG.pollingInterval);

server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`Dashboard listening on http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`Local access: http://localhost:${CONFIG.port}`);
});