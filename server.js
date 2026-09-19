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
        const initialData = { devices: [
            { id: 'AP-01', name: 'Virtual-Controller', type: 'ap', ip: '192.168.100.5' },
            { id: 'BCN-TEST', name: 'Visitor-Badge-A', type: 'beacon', battery: 95 }
        ]};
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
    }
}
initData();

// --- ส่วนของ Report Log (ส่วนใหม่) ---
let syncHistory = []; // เก็บประวัติการเชื่อมต่อสูงสุด 50 รายการล่าสุด
const MAX_LOGS = 50;

function addReportLog(sourceType, status, deviceCount = 0, detail = "") {
    const entry = {
        time: new Date().toLocaleTimeString(),
        source: sourceType, // 'API' หรือ 'Simulation'
        status: status,     // 'Success', 'Error', 'Pending'
        count: deviceCount,
        detail: detail
    };
    syncHistory.unshift(entry); // เพิ่มข้อมูลใหม่ไปข้างหน้าสุด
    if (syncHistory.length > MAX_LOGS) syncHistory.pop(); // เก็บแค่ 50 รายการล่าสุด
    
    // ส่งรายงานไปยังหน้าเว็บทันทีที่มีการ Update
    io.emit('system-reports', { logs: syncHistory });
}

// --- เริ่มต้น Server ---
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
console.log("Starting Aruba Instant Tracking Server with Reporting...");

// --- ฟังก์ชันดึงข้อมูลจริงจาก Aruba Virtual Controller ---
async function syncWithAruba() {
    const baseUrl = process.env.ARUBA_URL;
    
    if (!baseUrl) return null; 

    try {
        console.log(">>> Syncing with Aruba API...");
        
        // 1. Login (Instant OS API)
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

            // อัปเดตข้อมูล AP ลงใน DB ของเรา (Merge กับข้อมูลเก่า)
            const currentDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            const dbApsIds = new Set(currentDB.devices.filter(d => d.type === 'ap').map(d => d.id));
            
            // เพิ่ม/อัปเดต AP ใหม่
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

            // อัปเดตข้อมูล Beacon ลงใน DB
            const currentDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            for (const b of beacons) {
                // เพิ่มหากยังไม่มีใน DB ของเรา
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

        // บันทึก Report สำเร็จ
        addReportLog('Aruba API', 'Success', deviceCount, `Found: ${foundAPs} APs, ${foundBeacons} Beacons`);
        
        return []; // Return empty to trigger Simulation mode merge logic in main loop if needed, or just return success

    } catch (error) {
        console.error(">>> Aruba API Failed:", error.response?.data || error.message);
        // บันทึก Report ล้มเหลว
        addReportLog('Aruba API', 'Error', 0, "Authentication Failed or Connection Refused");
        return null;
    }
}

// --- ฟังก์ชันจำลองข้อมูล (Mock Data) ---
function runSimulation() {
    let data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    
    // อัปเดตสถานะให้ Beacons เคลื่อนที่
    data.devices.forEach(d => {
        if (d.type === 'beacon') {
            if (!d.lat) { d.lat = 13.7560 + Math.random(); d.lng = 100.5010 + Math.random(); } 
            d.lat += (Math.random() - 0.5) * 0.0002;
            d.lng += (Math.random() - 0.5) * 0.0002;
            if(Math.random() > 0.9 && d.battery > 10) d.battery -= 1;
        } else {
            if (!d.lat) { d.lat = 13.7563; d.lng = 100.5018; } 
        }
    });

    fs.writeFileSync(DB_FILE, JSON.stringify(data));
    
    // บันทึก Report เป็น Simulation Mode
    addReportLog('Simulation Mode', 'Info', data.devices.length, "Using local mock data (Aruna offline?)");
    
    return data.devices;
}

// --- Loop ทำงานหลัก (10 วินาที) ---
setInterval(async () => {
    addReportLog('Polling', 'Pending', 0, "Checking connection..."); // แจ้งเริ่มเช็ค
    
    const realData = await syncWithAruba();
    
    let finalDevices = [];

    if (realData && realData.length > 0) {
        finalDevices = realData.map(d => {
            if (d.type === 'beacon' && d.lat === 0 && d.lng === 0) {
                d.lat = 13.7560 + Math.random() * 0.001; 
                d.lng = 100.5010 + Math.random() * 0.001;
            }
            return d;
        });
    } else {
        // ถ้า API ล้มเหลว ให้ใช้ Simulation Mode
        finalDevices = runSimulation();
    }

    // ส่งข้อมูลอุปกรณ์ไปหน้าเว็บ
    io.emit('aruba-sync', { 
        timestamp: new Date(), 
        devices: finalDevices 
    });

}, 10000);

server.listen(process.env.PORT || 3000, () => {
    console.log(`Dashboard listening on http://localhost:${process.env.PORT || 3000}`);
});