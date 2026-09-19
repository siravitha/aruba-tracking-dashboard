const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'tracker_db.json');

// ฟังก์ชันเริ่มทำงานเมื่อเปิดโปรแกรม (หากไม่มีไฟล์หรือว่าง ให้สร้างข้อมูลตัวอย่าง)
function initDB() {
    if (!fs.existsSync(DB_FILE)) {
        console.log("Creating default database...");
        const initialData = {
            devices: [
                { id: 'AP-01', type: 'ap', name: 'Floor-1-Lobby', lat: 13.7563, lng: 100.5018 },
                { id: 'BCN-001', type: 'beacon', name: 'Visitor-Badge-A', lat: 13.7564, lng: 100.5020, battery: 98 },
                { id: 'AP-02', type: 'ap', name: 'Floor-2-Office', lat: 13.7565, lng: 100.5015 },
            ]
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    } else {
        // ตรวจสอบว่าไฟล์ว่างไหม ถ้าว่างก็เขียนใหม่
        const content = fs.readFileSync(DB_FILE, 'utf-8');
        if (!content.trim()) {
            fs.writeFileSync(DB_FILE, '[]');
        }
    }
}

// เริ่มต้นสร้าง DB
initDB();

module.exports = {
    getDevices: () => JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')),
    
    addDevice: (device) => {
        const data = getDevices();
        device.id = device.type === 'ap' ? `AP-${Date.now()}` : `BCN-${Date.now()}`; // สร้าง ID อัตโนมัติ
        data.devices.push(device);
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return device;
    },

    deleteDevice: (id) => {
        const data = getDevices();
        const filtered = data.devices.filter(d => d.id !== id);
        fs.writeFileSync(DB_FILE, JSON.stringify({ devices: filtered }, null, 2));
        return true;
    },
    
    updateLocation: (id, lat, lng) => {
        const data = getDevices();
        const devIndex = data.devices.findIndex(d => d.id === id);
        if (devIndex > -1) {
            data.devices[devIndex].lat = lat;
            data.devices[devIndex].lng = lng;
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        }
    }
};