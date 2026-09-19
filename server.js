const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');

// --- Database (ไฟล์ JSON เล็กๆ สำหรับเก็บ Name/Type) ---
const DB_FILE = 'tracker_db.json';
function initData() {
    if (!fs.existsSync(DB_FILE)) {
        // สร้างข้อมูลตัวอย่างหากยังไม่มีไฟล์
        const initialData = { devices: [
            { id: 'AP-01', name: 'Virtual-Controller', type: 'ap', ip: '192.168.100.5' },
            { id: 'BCN-TEST', name: 'Visitor-Badge-A', type: 'beacon', battery: 95 }
        ]};
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
    }
}
initData();

// --- เริ่มต้น Server ---
const app = express();
app.use(cors()); // เปิดรับ Connection จาก Browser
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ** จุดสำคัญ:** ส่งไฟล์ index.html กลับไปเมื่อเข้าหน้าหลัก (/) เพื่อแก้ Error "Cannot GET"
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

console.log("Starting Aruba Instant Tracking Server...");

// --- ฟังก์ชันดึงข้อมูลจริงจาก Aruba Virtual Controller (Instant OS API v2) ---
async function syncWithAruba() {
    const baseUrl = process.env.ARUBA_URL;
    
    if (!baseUrl) return null; // ไม่มี IP ให้ใช้โหมดจำลอง

    try {
        console.log(">>> Logging in to Aruba Controller...");
        
        // 1. Login เพื่อเอา Token (Instant OS API)
        const loginRes = await axios.post(`${baseUrl}/api/v2/auth/login`, {
            username: process.env.ARUBA_USER,
            password: process.env.ARUBA_PASS
        });

        const token = loginRes.data.access_token || loginRes.data.token; // รองรับ Token key หลายแบบ
        
        if (!token) throw new Error("Login failed - No token received");

        const headers = { Authorization: `Bearer ${token}` };
        let devicesFromController = [];

        // 2. ดึงข้อมูล AP (Instant OS Endpoint)
        try {
            const apRes = await axios.get(`${baseUrl}/api/v2/wireless/monitor/access_points`, { headers });
            // โครงสร้างข้อมูลอาจแตกต่างกันตามเวอร์ชัน แต่ปกติจะอยู่ใน key 'access_points' หรือ 'data'
            const aps = apRes.data.access_points || apRes.data.wireless_aps || [];
            
            devicesFromController = aps.map(d => ({
                id: d.mac_addr || d.mac,      // ID (MAC Address)
                name: d.name || d.model,      // ชื่อ AP
                type: 'ap',                   // ประเภทคงที่เป็น AP
                ip: d.ip_addr || null,        // IP ของ AP
                status: d.state === 'connected' ? 'online' : d.state, // สถานะ (connected/uplink_down)
                lat: 0, lng: 0               // Instant OS มักไม่ส่ง Lat/Lng มาให้โดยตรงถ้าไม่ได้ Calibrate
            }));
        } catch (e) { console.log(">>> AP Fetch Skipped/Error:", e.message); }

        // 3. ดึงข้อมูล Beacon (IoT Beacons)
        try {
            const beaconRes = await axios.get(`${baseUrl}/api/v2/wireless/monitor/bluetooth_beacons`, { headers });
            const beacons = beaconRes.data.bluetooth_beacons || [];

            const newBeacons = beacons.map(b => ({
                id: b.mac_addr,
                name: b.name || `BCN-${b.mac_addr.slice(-6)}`,
                type: 'beacon',
                battery: b.battery_life || null, // % อายุแบตเตอรี่
                rssi: b.rssi || null,            // ความแรงสัญญาณ
                lat: 0, lng: 0                  // ถ้าไม่มี location จะส่งค่าว่างมา
            }));
            
            devicesFromController = [...devicesFromController, ...newBeacons];
        } catch (e) { console.log(">>> Beacon Fetch Skipped/Error:", e.message); }

        return devicesFromController.length > 0 ? devicesFromController : null;

    } catch (error) {
        console.error(">>> Aruba API Failed:", error.response?.data || error.message);
        return null; // ส่งค่า null กลับไปเพื่อให้ใช้โหมดจำลอง
    }
}

// --- ฟังก์ชันจำลองข้อมูล (Mock Data) - ใช้เมื่อต่อ API ไม่ได้ ---
function runSimulation() {
    let data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    data.devices.forEach(d => {
        // จำลองการขยับตำแหน่งให้ Beacons เสมอ
        if (d.type === 'beacon') {
            // ถ้ายังไม่มีพิกัด เริ่มสุ่มจุดรอบๆ กรุงเทพฯ
            if (!d.lat) { d.lat = 13.7560 + Math.random(); d.lng = 100.5010 + Math.random(); } 
            d.lat += (Math.random() - 0.5) * 0.0002; // เลื่อนนิดหน่อย
            d.lng += (Math.random() - 0.5) * 0.0002;
            
            // สุ่มแบตเตอรี่ลดลงบ้าง
            if(Math.random() > 0.9 && d.battery > 10) d.battery -= 1;
        } else {
            // AP ยืนนิ่งๆ (สมมติว่ามีพิกัดยืนอยู่แล้วใน DB หรือใช้จุดเริ่มต้น)
            if (!d.lat) { d.lat = 13.7563; d.lng = 100.5018; } 
        }
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(data)); // บันทึกตำแหน่งใหม่ลงไฟล์
    return data.devices;
}

// --- Loop ทำงานทุก 10 วินาที ---
setInterval(async () => {
    console.log("Checking Aruba Controller...");
    
    // พยายามดึงจาก Aruba จริงก่อน
    const realData = await syncWithAruba();
    
    let finalDevices = [];

    if (realData && realData.length > 0) {
        // ถ้าได้ข้อมูลจริง ให้ใช้เลย และอัปเดตตำแหน่งจำลองในกรณีที่ไม่มีค่าจริงมา
        finalDevices = realData.map(d => {
            // ถ้าเป็น Beacons และไม่มีการ Calibrate (lat=0) ให้ขยับตามเวลา (Simulation Mode ผสมผสาน)
            if (d.type === 'beacon' && d.lat === 0 && d.lng === 0) {
                d.lat = 13.7560 + Math.random() * 0.001; 
                d.lng = 100.5010 + Math.random() * 0.001;
            }
            return d;
        });
    } else {
        // ถ้าล้มเหลว (เช่น IP ผิด, SSL Error) ให้ใช้โหมดจำลองทั้งหมด (Simulation Mode)
        finalDevices = runSimulation();
    }

    // ส่งข้อมูลไปอัปเดตหน้า Dashboard
    io.emit('aruba-sync', { 
        timestamp: new Date(), 
        devices: finalDevices 
    });

}, 10000); // ทำงานทุก 10 วินาที (อย่าถี่เกินไปเพื่อลดภาระ API ของ Aruba)

server.listen(process.env.PORT || 3000, () => {
    console.log(`Dashboard listening on http://localhost:${process.env.PORT || 3000}`);
});