const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const axios = require('axios'); // ใช้เรียก Aruba API
require('dotenv').config();     // ดึงค่าจาก .env
const fs = require('fs');       // สำหรับอ่านไฟล์ Static Location

// --- ส่วนการเชื่อมต่อฐานข้อมูล (ใช้ JSON แบบเดิม) ---
const DB_FILE = 'tracker_db.json';
const LOCATIONS_FILE = 'static_locations.json'; // ไฟล์เก็บพิกัดยืนของ AP

// ฟังก์ชันเริ่มต้นระบบ (Load ข้อมูล)
function initData() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ devices: [] }));
    
    // ถ้ายังไม่มีไฟล์กำหนดตำแหน่งบนแผนที่ ให้สร้างตัวอย่างไว้
    if (!fs.existsSync(LOCATIONS_FILE)) {
        const defaultLocations = [
            { name: "AP-Floor1-Lobby", lat: 13.7563, lng: 100.5018 },
            { name: "AP-Floor2-Office", lat: 13.7564, lng: 100.5020 },
            { name: "BCN-Vendor-Area", lat: 13.7565, lng: 100.5015 }
        ];
        fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(defaultLocations));
    }
}

// ฟังก์ชันอ่านตำแหน่งคงที่ (Static Location) จากไฟล์
function getStaticLocations() {
    const data = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf-8'));
    let map = {};
    data.forEach(l => map[l.name] = { lat: l.lat, lng: l.lng });
    return map;
}

// --- ส่วนหลักของ Server (Aruba Integration) ---
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let currentDevices = []; // เก็บข้อมูลล่าสุดที่ดึงมาจาก Aruba

// 1. ดึง Token เพื่อเข้า API ของ Aruba
async function getArubaToken() {
    try {
        const url = `${process.env.ARUBA_URL}/rest/auth`;
        const res = await axios.post(url, {
            username: process.env.ARUBA_USER,
            password: process.env.ARUBA_PASS
        });
        return res.data.token;
    } catch (error) {
        console.error("Auth Error:", error.response?.data || error.message);
        return null;
    }
}

// 2. ดึงข้อมูล AP/Beacon ทั้งหมดจาก Controller
async function fetchArubaDevices() {
    const token = await getArubaToken();
    if (!token) {
        console.log("Failed to login to Aruba, using default data.");
        return [];
    }

    try {
        // API Endpoint สำหรับดูสถานะ AP (Mobility REST API)
        const url = `${process.env.ARUBA_URL}/rest/v1/wireless/monitor/access-points`;
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // แปลงข้อมูลดิบเป็นรูปแบบที่ Dashboard ของเราเข้าใจ
        const devicesFromController = res.data.map(dev => {
            // หาพิกัดยืนของ AP จากไฟล์ static_locations.json (เพราะ API ไม่ได้ให้มา)
            let coords = getStaticLocations()[dev.name] || null; 

            return {
                id: dev.id, // หรือ dev.mac
                name: dev.name,
                type: dev.capabilities?.includes('beacon') ? 'beacon' : 'ap', 
                status: dev.status === 'UP' ? 'online' : 'offline',
                rssi: -60, // (ตัวอย่างค่า RSSI)
                lat: coords ? coords.lat : null, // ถ้าไม่มีพิกัดเก็บไว้ จะเป็น null
                lng: coords ? coords.lng : null
            };
        });

        currentDevices = devicesFromController;
        return devicesFromController;

    } catch (error) {
        console.error("Fetch Error:", error.response?.data || error.message);
        return [];
    }
}

// 3. จำลองการขยับตำแหน่ง Beacon (กรณีนี้สมมติว่า Beacon เคลื่อนที่ ถ้าเป็น AP จะอยู่นิ่ง)
function simulateBeaconMovement(devices) {
    return devices.map(d => {
        // ถ้าเป็น Beacons และไม่มีพิกัดยืน ให้สุ่มเดินเล่นรอบๆ
        if (d.type === 'beacon' && !d.lat) {
            d.lat = 13.7560 + Math.random() * 0.001; 
            d.lng = 100.5010 + Math.random() * 0.001;
        } else if (d.lat) {
             // ถ้ามีพิกัดยืน (เช่น AP) ให้ขยับนิดหน่อยเพื่อให้เห็นว่า Live Data ทำงาน
             d.lat += (Math.random() - 0.5) * 0.0001;
             d.lng += (Math.random() - 0.5) * 0.0001;
        }
        return d;
    });
}

// --- เริ่มต้นทำงาน ---
initData(); // เริ่มโหลดไฟล์ข้อมูล

setInterval(async () => {
    console.log("Fetching Aruba Controller Data...");
    
    let devices = await fetchArubaDevices();
    
    if (devices.length > 0) {
        // ถ้าดึงได้ ให้ทำการจำลองตำแหน่งสำหรับ Beacons
        devices = simulateBeaconMovement(devices);
        
        // ส่งข้อมูลไปให้หน้าเว็บ
        io.emit('aruba-sync', {
            timestamp: new Date(),
            devices: devices
        });
    } else {
        console.log("No data from Aruba. Reverting to mock simulation for demo.");
        // (ส่วนนี้จะกลับไปใช้ logic เดิมถ้าต่อ API ไม่ได้ เพื่อให้เห็นภาพ)
    }
}, 30000); // ดึงข้อมูลทุก 30 วินาที (Aruba API อาจจำกัดการดึงถี่เกินไป)

// API สำหรับหน้าเว็บเรียกข้อมูลปัจจุบัน
app.get('/api/status', (req, res) => {
    res.json({ devices: currentDevices });
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Aruba Gateway Server listening on port ${process.env.PORT || 3000}`);
});