let video = document.getElementById('kamera');
let canvas = document.getElementById('islemEkrani');
let ctx = canvas.getContext('2d');
let kalinlikText = document.getElementById('kalinlik-deger');
let mqttDurum = document.getElementById('mqtt-durum');
let telemetriBtn = document.getElementById('telemetriBtn');

let opencvHazir = false;
let streaming = false;
let telemetriAktif = false; 

// --- Frame AYARLARI ---
const CROP_X = 0.30; 
const CROP_Y_TOP = 0.375;     
const CROP_Y_BOTTOM = 0.405; 
const CROP_W = 1.0 - (CROP_X * 2);
const CROP_H = 1.0 - CROP_Y_TOP - CROP_Y_BOTTOM;

// OpenCV Değişkenleri
let src, dst, gray, blur, edges, M, contours, hierarchy;

// Amortisör Filtre Hafızası
let olcumGecmisi = []; 

// ---- 1. MQTT WEBSOCKET KURULUMU ----
const MQTT_BROKER = "21358b8f9c1d42fdbbe8a62a8b522da4.s1.eu.hivemq.cloud";
const MQTT_PORT = 8884; // Web uygulamaları için zorunlu WebSocket Portu
const MQTT_USER = "pet2print-admin";
const MQTT_PASS = "BahcesehirCapstone2026";
const TOPIC_TELEMETRY = "pet2print/telemetry";

let client = new Paho.MQTT.Client(MQTT_BROKER, MQTT_PORT, "pet2print_edge_phone_" + parseInt(Math.random() * 100, 10));

client.onConnectionLost = onConnectionLost;

function mqttBaglan() {
    console.log("HiveMQ sunucusuna bağlanılıyor...");
    client.connect({ 
        userName: MQTT_USER,
        password: MQTT_PASS,
        useSSL: true,
        onSuccess: onConnect, 
        onFailure: onConnectFail
    });
}

function onConnect() {
    mqttDurum.innerHTML = "Bağlı";
    mqttDurum.style.color = "#00E676";
    console.log("MQTT Broker'ına başarıyla kilitlenildi!");
}

function onConnectFail(err) {
    mqttDurum.innerHTML = "Yetki/Bağlantı Hatası";
    mqttDurum.style.color = "#ff5252";
    console.error("MQTT Bağlantı Hatası:", err.errorMessage);
    setTimeout(mqttBaglan, 5000);
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        mqttDurum.innerHTML = "Bağlantı Koptu";
        mqttDurum.style.color = "#ff5252";
        telemetriAktif = false;
        telemetriBtn.innerText = "Veri Akışını Başlat";
        telemetriBtn.style.backgroundColor = "#2196F3";
        setTimeout(mqttBaglan, 3000); 
    }
}

function veriGonder(kalinlik, durum) {
    if (client.isConnected() && telemetriAktif) { 
        let payload = JSON.stringify({ 
            "kalinlik": kalinlik,
            "motor_aksiyonu": durum,
            "kaynak": "Edge_Phone"
        });
        let message = new Paho.MQTT.Message(payload);
        message.destinationName = TOPIC_TELEMETRY; 
        client.send(message);
    }
}

mqttBaglan();

// ---- VERİ AKIŞINI BAŞLAT / DURDUR ----
telemetriBtn.addEventListener('click', () => {
    if (!telemetriAktif) {
        if (!client.isConnected()) {
            alert("HATA: MQTT sunucusuna bağlanılamadı! Lütfen internetinizi veya broker durumunu kontrol edin.");
            return;
        }
        telemetriAktif = true;
        telemetriBtn.innerText = "Durdur";
        telemetriBtn.style.backgroundColor = "#ff5252"; 
    } else {
        telemetriAktif = false;
        telemetriBtn.innerText = "Veri Akışını Başlat";
        telemetriBtn.style.backgroundColor = "#2196F3"; 
    }
});

// ---- OPENCV.JS VE KAMERA İŞLEMLERİ ----
let currentStream = null;
let isTorchOn = false;

function onOpenCvReady() {
    opencvHazir = true;
    console.log("OpenCV.js yüklendi.");
}

async function kamerayiBaslat(deviceId = null) {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }

    let constraints = {
        video: deviceId ? { deviceId: { exact: deviceId }, width: 640, height: 480 } : { facingMode: "environment", width: 640, height: 480 },
        audio: false
    };

    try {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;
        video.play();
        streaming = true;

        flasiAcKapat(true);

        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth * CROP_W;
            canvas.height = video.videoHeight * CROP_H; 
            
            if (!src) {
                src = new cv.Mat(canvas.height, canvas.width, cv.CV_8UC4);
                dst = new cv.Mat(canvas.height, canvas.width, cv.CV_8UC4);
                gray = new cv.Mat();
                blur = new cv.Mat();
                edges = new cv.Mat();
                contours = new cv.MatVector();
                hierarchy = new cv.Mat();
                M = cv.Mat.ones(5, 5, cv.CV_8U);
                requestAnimationFrame(goruntuIsle);
            }
        };

        if (!deviceId) {
            kameralariListele();
            document.getElementById('baslatBtn').style.display = "none"; 
            telemetriBtn.style.display = "block"; 
        }

    } catch (err) {
        alert("Kamera başlatılamadı: " + err.message);
    }
}

async function kameralariListele() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    const secici = document.getElementById('kameraSecici');
    
    secici.innerHTML = '';
    videoDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Kamera Lens ${index + 1}`;
        secici.appendChild(option);
    });
    document.getElementById('ekstraKontroller').style.display = "flex";
}

document.getElementById('kameraSecici').addEventListener('change', (e) => {
    kamerayiBaslat(e.target.value);
});

async function flasiAcKapat(zorunluDurum = null) {
    if (!currentStream) return;
    const track = currentStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities();

    if (capabilities.torch) {
        isTorchOn = zorunluDurum !== null ? zorunluDurum : !isTorchOn;
        try {
            await track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
            document.getElementById('flasBtn').innerText = isTorchOn ? "Flaşı Kapat" : "Flaş Aç";
            document.getElementById('flasBtn').style.backgroundColor = isTorchOn ? "#ffffff" : "#FFC107";
        } catch (err) {
            console.error(err);
        }
    }
}

document.getElementById('flasBtn').addEventListener('click', () => flasiAcKapat());

document.getElementById('baslatBtn').addEventListener('click', () => {
    if (!opencvHazir) {
        alert("OpenCV yükleniyor, lütfen bekleyin...");
        return;
    }
    kamerayiBaslat(); 
});

// ---- EKRANA DOKUNARAK ODAKLAMA ----
let odakX = -1, odakY = -1;
let odakZamani = 0;

canvas.addEventListener('click', async (e) => {
    if (!currentStream) return;
    const track = currentStream.getVideoTracks()[0];
    
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    const normX = clickX / rect.width;
    const normY = clickY / rect.height;

    odakX = normX * canvas.width;
    odakY = normY * canvas.height;
    odakZamani = Date.now();

    const sensorNormX = CROP_X + (normX * CROP_W);
    const sensorNormY = CROP_Y_TOP + (normY * CROP_H);

    try {
        await track.applyConstraints({
            advanced: [{ pointsOfInterest: [{ x: sensorNormX, y: sensorNormY }] }]
        });
    } catch (err) {
        console.log("Manuel odaklama desteklenmiyor.");
    }
});

// ---- GÖRÜNTÜ İŞLEME DÖNGÜSÜ ----
let sonGonderimZamani = Date.now();

function goruntuIsle() {
    if (!streaming) return;

    let sx = video.videoWidth * CROP_X;
    let sy = video.videoHeight * CROP_Y_TOP; 
    let sWidth = video.videoWidth * CROP_W;
    let sHeight = video.videoHeight * CROP_H;
    
    ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
    src.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blur, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 30, 100, 3, false);

    let anchor = new cv.Point(-1, -1);
    cv.dilate(edges, edges, M, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let enBuyukAlan = 0;
    let secilenKonturIndex = -1;

    for (let i = 0; i < contours.size(); ++i) {
        let alan = cv.contourArea(contours.get(i));
        if (alan > enBuyukAlan && alan > 500) { 
            enBuyukAlan = alan;
            secilenKonturIndex = i;
        }
    }

    src.copyTo(dst);

    if (secilenKonturIndex !== -1) {
        let rect = cv.boundingRect(contours.get(secilenKonturIndex));
        let anlikKalinlikPiksel = Math.min(rect.width, rect.height);
        let isHorizontal = rect.width > rect.height; 
        
        olcumGecmisi.push(anlikKalinlikPiksel);
        if (olcumGecmisi.length > 45) {
            olcumGecmisi.shift();
        }
        
        let toplamPiksel = olcumGecmisi.reduce((a, b) => a + b, 0);
        let ortalamaKalinlikPiksel = toplamPiksel / olcumGecmisi.length;
        
        let color = new cv.Scalar(0, 230, 118, 255); 
        
        if (isHorizontal) {
            let ustSol = new cv.Point(rect.x, rect.y);
            let ustSag = new cv.Point(rect.x + rect.width, rect.y);
            let altSol = new cv.Point(rect.x, rect.y + rect.height);
            let altSag = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.line(dst, ustSol, ustSag, color, 3);
            cv.line(dst, altSol, altSag, color, 3);
        } else {
            let solUst = new cv.Point(rect.x, rect.y);
            let solAlt = new cv.Point(rect.x, rect.y + rect.height);
            let sagUst = new cv.Point(rect.x + rect.width, rect.y);
            let sagAlt = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.line(dst, solUst, solAlt, color, 3);
            cv.line(dst, sagUst, sagAlt, color, 3);
        }

        // --- Kalibrasyon ---
        const PIKSEL_CAPPAN = 0.0795; 
        
        let kalinlikFloat = ortalamaKalinlikPiksel * PIKSEL_CAPPAN;
        let mmHesabi = kalinlikFloat.toFixed(2);
        
        let motorDurumu = "SABIT";

        if (kalinlikFloat > 1.80) {
            motorDurumu = "HIZLANDIR"; 
            kalinlikText.style.color = "#ff5252"; 
        } else if (kalinlikFloat < 1.70) {
            motorDurumu = "YAVASLAT"; 
            kalinlikText.style.color = "#2196F3"; 
        } else {
            motorDurumu = "SABIT"; 
            kalinlikText.style.color = "#00E676"; 
        }

        let ekYazi = telemetriAktif ? " | Yayın Açık" : " | Yayın Durduruldu";
        kalinlikText.innerHTML = mmHesabi + " mm (" + motorDurumu + ")" + ekYazi;

        if (Date.now() - sonGonderimZamani > 1000) {
            if (telemetriAktif) {
                veriGonder(parseFloat(mmHesabi), motorDurumu);
            }
            sonGonderimZamani = Date.now();
        }
    } else {
        olcumGecmisi = [];
    }

    if (Date.now() - odakZamani < 1000) {
        let center = new cv.Point(odakX, odakY);
        let sari = new cv.Scalar(255, 193, 7, 255);
        cv.circle(dst, center, 30, sari, 3); 
        cv.circle(dst, center, 4, sari, -1); 
    }

    cv.imshow('islemEkrani', dst);
    requestAnimationFrame(goruntuIsle);
}