const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');

// --- ส่วนจัดการข้อมูล (Database) ---
const DB_FILE = 'tracker_db.json';

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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
console.log("Starting Aruba Instant Tracking Server...");

// --- ฟังก์ชันดึงข้อมูลจริงจาก Aruba Virtual Controller ---
async function syncWithAruba() {
    const baseUrl = process.env.ARUBA_URL;
    
    if (!baseUrl) return null; 

    try {
        console.log(">>> Syncing with Aruba API...");
        
        // 1. Login (Instant OS API v2)
        const loginRes = await axios.post(`${baseUrl}/api/v2/auth/login`, {
            username: process.env.ARUBA_USER,
            password: process.env.ARUBA_PASS
        });

        const token = loginRes.data.access_token || loginRes.data.token;
        if (!token) throw new Error("Login failed - No token received");

        const headers = { Authorization: `Bearer ${token}` };
        let deviceCount = 0;
        let foundAPs = 0, foundBeacons = 0;

        // 2. ดึงข้อมูล AP
        try {
            const apRes = await axios.get(`${baseUrl}/api/v2/wireless/monitor/access_points`, { headers });
            const aps = apRes.data.access_points || apRes.data.wireless_aps || [];
            
            deviceCount += aps.length;
            foundAPs = aps.length;

            const currentDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            const dbApsIds = new Set(currentDB.devices.filter(d => d.type === 'ap').map(d => d.id));
            
            for (const d of aps) {
                if (!dbApsIds.has(d.mac_addr || d.mac)) {
                    currentDB.devices.push({
                        id: d.mac_addr || d.mac,
                        name: d.name || d.model,
                        type: 'ap',
                        ip: d.ip_addr || null
                    });
                }
            }
        } catch (e) { console.log(">>> AP Fetch Skipped:", e.message); }

        // 3. ดึงข้อมูล Beacon
        try {
            const beaconRes = await axios.get(`${baseUrl}/api/v2/wireless/monitor/bluetooth_beacons`, { headers });
            const beacons = beaconRes.data.bluetooth_beacons || [];
            
            deviceCount += beacons.length;
            foundBeacons = beacons.length;

            const currentDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            for (const b of beacons) {
                if (!currentDB.devices.find(dev => dev.id === b.mac_addr)) {
                    currentDB.devices.push({
                        id: b.mac_addr,
                        name: b.name || `BCN-${b.mac_addr.slice(-6)}`,
                        type: 'beacon',
                        battery: b.battery_life
                    });
                }
            }
            fs.writeFileSync(DB_FILE, JSON.stringify(currentDB));
        } catch (e) { console.log(">>> Beacon Fetch Skipped:", e.message); }

        addReportLog('Aruba API', 'Success', deviceCount, `Found: ${foundAPs} APs, ${foundBeacons} Beacons`);
        return []; 

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

    if (realData && realData.length > 0) {
        finalDevices = realData.map(d => {
            // ถ้าไม่ได้ Calibrate AP ไว้ ให้ใช้จุดยืนของโรงพยาบาลชั่วคราว
            if (d.type === 'ap' && d.lat === 0 && d.lng === 0) {
                d.lat = 17.4099 + Math.random() * 0.001; 
                d.lng = 102.8026 + Math.random() * 0.001;
            }
            return d;
        });
    } else {
        finalDevices = runSimulation();
    }

    io.emit('aruba-sync', { timestamp: new Date(), devices: finalDevices });
}, 10000);

server.listen(process.env.PORT || 3000, () => {
    console.log(`Dashboard listening on http://localhost:${process.env.PORT || 3000}`);
});