// PWA Installation and Service Worker Registration
let deferredPrompt;
let isOnline = navigator.onLine;

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('ServiceWorker registered successfully:', registration.scope);
      
      // Handle updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Update tersedia! Refresh halaman untuk mendapatkan versi terbaru.');
          }
        });
      });
    } catch (error) {
      console.error('ServiceWorker registration failed:', error);
    }
  });
}

// PWA Install Prompt
window.addEventListener('beforeinstallprompt', (e) => {
  console.log('PWA install prompt triggered');
  e.preventDefault();
  deferredPrompt = e;
  showInstallPrompt();
});

function showInstallPrompt() {
  const installPrompt = document.getElementById('install-prompt');
  installPrompt.classList.add('show');
}

document.getElementById('install-btn').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    hideInstallPrompt();
    deferredPrompt = null;
  }
});

document.getElementById('dismiss-install').addEventListener('click', () => {
  hideInstallPrompt();
});

function hideInstallPrompt() {
  const installPrompt = document.getElementById('install-prompt');
  installPrompt.classList.remove('show');
}

// Online/Offline Status
window.addEventListener('online', () => {
  isOnline = true;
  document.getElementById('offline-indicator').classList.add('hidden');
  showToast('Kembali online!');
  if (client && !client.isConnected()) {
    startConnection();
  }
});

window.addEventListener('offline', () => {
  isOnline = false;
  document.getElementById('offline-indicator').classList.remove('hidden');
  showToast('Mode offline - koneksi internet terputus');
});

// MQTT Configuration and Variables
const MQTT_BROKER = "fd7fb73c3b724a0eb77bcdf746b08749.s1.eu.hivemq.cloud";
const MQTT_PORT = 8884;
const MQTT_USER = "irone1";
const MQTT_PASS = "*Alexis01311803";
const MQTT_CLIENT_ID = "web-client-" + Math.random().toString(16).substr(2, 8);

const TOPICS = {
    CMD_12: "device/irone/gpio12/cmd", STATE_12: "device/irone/gpio12/state",
    CMD_13: "device/irone/gpio13/cmd", STATE_13: "device/irone/gpio13/state",
    CMD_14: "device/irone/gpio14/cmd", STATE_14: "device/irone/gpio14/state",
    HEARTBEAT: "device/irone/heartbeat",
    SCHEDULE_ADD: "device/irone/schedule/add",
    SCHEDULE_CLEAR: "device/irone/schedule/clear",
    SCHEDULE_REQUEST: "device/irone/schedule/request",
    SCHEDULE_ITEM: "device/irone/schedule/item",
    SCHEDULE_SYNC_STATUS: "device/irone/schedule/sync_status"
};

let client;
let schedules = [];
let lastHeartbeat = null;
let deviceStatusChecker = null;
let initialScheduleRequested = false;

// Toast notification function
function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => { toast.classList.remove("show"); }, 3000);
}

// MQTT Connection Functions
function startConnection() {
    if (!isOnline) {
        showToast("Tidak ada koneksi internet");
        return;
    }
    
    try {
        client = new Paho.MQTT.Client(MQTT_BROKER, MQTT_PORT, "/mqtt", MQTT_CLIENT_ID);
        client.onConnectionLost = onConnectionLost;
        client.onMessageArrived = onMessageArrived;
        const options = {
            onSuccess: onConnect, onFailure: onFailure,
            userName: MQTT_USER, password: MQTT_PASS, useSSL: true,
            cleanSession: true, timeout: 10, keepAliveInterval: 60, mqttVersion: 4
        };
        updateBrokerStatus('Connecting...', 'bg-yellow-500');
        client.connect(options);
    } catch (error) {
        console.error("Error creating MQTT client:", error);
        showToast("Error: " + error.message);
    }
}

function onConnect() {
    console.log("MQTT Connected successfully!");
    updateBrokerStatus('Connected', 'bg-green-500');
    const subscriptions = [
        TOPICS.STATE_12, TOPICS.STATE_13, TOPICS.STATE_14,
        TOPICS.HEARTBEAT, TOPICS.SCHEDULE_ITEM, TOPICS.SCHEDULE_SYNC_STATUS
    ];
    subscriptions.forEach(sub => client.subscribe(sub));
    if (!initialScheduleRequested) {
        showToast("Terhubung! Meminta daftar jadwal...");
        requestSchedules(); 
    } else {
        showToast("Berhasil terhubung kembali!");
    }
    startDeviceStatusMonitor();
}

function requestSchedules() {
    sendMessage(TOPICS.SCHEDULE_REQUEST, "GET");
    initialScheduleRequested = true; 
}

function onMessageArrived(message) {
    const topic = message.destinationName;
    const payload = message.payloadString;

    if (topic === TOPICS.HEARTBEAT) {
        lastHeartbeat = new Date().getTime();
        updateDeviceStatus('Online', 'bg-green-500 pulse-animation');
        return;
    }
    let pin;
    if (topic === TOPICS.STATE_12) pin = 12;
    else if (topic === TOPICS.STATE_13) pin = 13;
    else if (topic === TOPICS.STATE_14) pin = 14;
    if (pin) updateToggleUI(pin, payload === 'ON');
    
    // Schedule synchronization handling
    if (topic === TOPICS.SCHEDULE_SYNC_STATUS) {
        if (payload === 'START') {
            schedules = [];
            renderScheduleList();
            showToast("Menerima daftar jadwal...");
        } else if (payload === 'END') {
            showToast("Sinkronisasi jadwal selesai.");
        }
    }
    
    if (topic === TOPICS.SCHEDULE_ITEM) {
        try {
            const newSched = JSON.parse(payload);
            if (!newSched.id) {
                newSched.id = new Date().getTime() + Math.random();
            }
            schedules.push(newSched);
            renderScheduleList();
        } catch (e) { 
            console.error("Gagal parse jadwal individual:", payload, e); 
            showToast("Error: Menerima format jadwal yang salah.");
        }
    }
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        console.warn("MQTT Connection lost:", responseObject);
        updateBrokerStatus('Connection Lost', 'bg-red-500');
        updateDeviceStatus('Unknown', 'bg-gray-400');
        if (deviceStatusChecker) clearInterval(deviceStatusChecker);
        showToast("Koneksi terputus. Menyambung kembali...");
        setTimeout(startConnection, 3000);
    }
}

function renderScheduleList() {
    const listContainer = document.getElementById('schedule-list');
    listContainer.innerHTML = '';
    if (schedules.length === 0) {
         listContainer.innerHTML = '<p class="text-gray-400 text-center mt-4">Tidak ada jadwal.</p>';
         return;
    }
    schedules.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    schedules.forEach((sched) => {
        const timeStr = String(sched.time).padStart(4, '0');
        const hour = timeStr.substring(0, 2);
        const minute = timeStr.substring(2, 4);
        const state = sched.state === 1 ? 'ON' : 'OFF';
        const gpioText = {12: "Lampu Teras", 13: "Pompa Air", 14: "Lampu Taman"}[sched.gpio] || `GPIO ${sched.gpio}`;
        
        const schedDiv = document.createElement('div');
        schedDiv.className = 'flex justify-between items-center bg-gray-50 p-2 rounded-md mb-2 shadow-sm text-sm hover:bg-lime-50';
        schedDiv.dataset.id = sched.id;
        schedDiv.innerHTML = `
            <span><strong>${gpioText}</strong> at <strong>${hour}:${minute}</strong> &rarr; <strong>${state}</strong></span>
            <button class="delete-sched-btn text-red-500 hover:text-red-700 font-bold text-xl px-2">&times;</button>
        `;
        listContainer.appendChild(schedDiv);
    });
}

function sendMessage(topic, payload, qos = 0, retained = false) {
     if (client && client.isConnected()) {
        try {
            const message = new Paho.MQTT.Message(payload);
            message.destinationName = topic;
            message.qos = qos;
            message.retained = retained;
            client.send(message);
        } catch (error) { 
            console.error(`Error sending to ${topic}:`, error); 
        }
    } else if (!isOnline) {
        showToast("Tidak ada koneksi internet");
    } else {
        showToast("MQTT tidak terhubung");
    }
}

// Utility Functions
function onFailure(response) { 
    console.error("MQTT Connection failed:", response); 
    updateBrokerStatus('Connection Failed', 'bg-red-500');
}

function startDeviceStatusMonitor() { 
    if (deviceStatusChecker) clearInterval(deviceStatusChecker); 
    deviceStatusChecker = setInterval(() => { 
        if (!lastHeartbeat || (new Date().getTime() - lastHeartbeat > 30000)) 
            updateDeviceStatus('Offline', 'bg-red-500'); 
    }, 5000); 
}

function updateBrokerStatus(text, lightClass) { 
    document.getElementById('broker-status-text').textContent = `Broker: ${text}`; 
    document.getElementById('broker-status-light').className = `w-3 h-3 rounded-full ${lightClass}`; 
}

function updateDeviceStatus(text, lightClass) { 
    document.getElementById('device-status-text').textContent = `Device: ${text}`; 
    document.getElementById('device-status-light').className = `w-3 h-3 rounded-full ${lightClass}`; 
}

function updateToggleUI(pin, isChecked) { 
    const toggle = document.getElementById(`toggle-${pin}`); 
    const statusText = document.getElementById(`status-${pin}`); 
    if (toggle && statusText) { 
        toggle.checked = isChecked; 
        statusText.textContent = isChecked ? 'ON' : 'OFF'; 
        statusText.className = isChecked ? 'text-green-600 font-bold text-lg' : 'text-gray-500 font-medium text-lg'; 
    } 
}

// Event Listeners
document.getElementById('addSchedBtn').addEventListener('click', () => {
    const gpio = parseInt(document.getElementById('sched-gpio').value);
    const time = document.getElementById('sched-time').value;
    const state = parseInt(document.getElementById('sched-state').value);
    if (!time) {
        alert("Harap tentukan waktu.");
        return;
    }
    const newSchedule = { id: new Date().getTime(), gpio, time: time.replace(':', ''), state };
    schedules.push(newSchedule);
    renderScheduleList();
    showToast("Jadwal ditambahkan ke daftar lokal.");
    document.getElementById('sched-time').value = '';
});

document.getElementById('schedule-list').addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('delete-sched-btn')) {
        const schedDiv = e.target.closest('div[data-id]');
        if (schedDiv) {
            const idToRemove = Number(schedDiv.dataset.id);
            schedules = schedules.filter(s => s.id !== idToRemove);
            renderScheduleList();
            showToast("Jadwal dihapus dari daftar lokal.");
        }
    }
});

document.getElementById('refreshSchedBtn').addEventListener('click', () => {
    if (!client || !client.isConnected()) {
        showToast("Tidak terhubung ke broker.");
        return;
    }
    showToast("Meminta jadwal tersimpan dari perangkat...");
    requestSchedules();
});

document.getElementById('sendSchedBtn').addEventListener('click', () => {
    if (!client || !client.isConnected()) {
        showToast("Tidak terhubung ke broker."); 
        return;
    }
    showToast("Memulai sinkronisasi ke perangkat...");
    sendMessage(TOPICS.SCHEDULE_CLEAR, "1");

    setTimeout(() => {
        if (schedules.length === 0) {
            showToast("Daftar jadwal kosong telah dikirim!");
            return;
        }
        schedules.forEach((sched, index) => {
            const schedToSend = {
                gpio: sched.gpio,
                time: sched.time,
                state: sched.state
            };
            setTimeout(() => {
                sendMessage(TOPICS.SCHEDULE_ADD, JSON.stringify(schedToSend));
                if (index === schedules.length - 1) showToast("Semua jadwal telah terkirim!");
            }, index * 100); 
        });
    }, 250);
});

// GPIO Toggle Event Listeners
[12, 13, 14].forEach(pin => {
    document.getElementById(`toggle-${pin}`).addEventListener('change', (event) => {
        if (!client || !client.isConnected()) {
            showToast("Tidak terhubung ke broker!");
            event.target.checked = !event.target.checked;
            return;
        }
        const command = event.target.checked ? 'ON' : 'OFF';
        const topic = {12: TOPICS.CMD_12, 13: TOPICS.CMD_13, 14: TOPICS.CMD_14}[pin];
        if (topic) sendMessage(topic, command);
    });
});

// Handle URL shortcuts for PWA
function handleShortcuts() {
    const urlParams = new URLSearchParams(window.location.search);
    const shortcut = urlParams.get('shortcut');
    
    if (shortcut === 'light12') {
        setTimeout(() => {
            document.getElementById('toggle-12').focus();
            showToast('Shortcut: Kontrol Lampu Teras');
        }, 1000);
    } else if (shortcut === 'pump13') {
        setTimeout(() => {
            document.getElementById('toggle-13').focus();
            showToast('Shortcut: Kontrol Pompa Air');
        }, 1000);
    }
}

// Initialize App
window.addEventListener('load', () => {
    startConnection();
    handleShortcuts();
});

document.addEventListener('visibilitychange', () => { 
    if (document.visibilityState === 'visible' && client && !client.isConnected() && isOnline) {
        startConnection(); 
    }
});