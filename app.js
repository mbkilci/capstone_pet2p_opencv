let video = document.getElementById('kamera');
let canvas = document.getElementById('islemEkrani');
let ctx = canvas.getContext('2d');
let kalinlikText = document.getElementById('kalinlik-deger');
let mqttDurum = document.getElementById('mqtt-durum');

let opencvHazir = false;
let streaming = false;

// OpenCV Değişkenleri (Bellek sızıntısını önlemek için global tanımlanıp tekrar kullanılır)
let src, dst, gray, blur, edges, M, contours, hierarchy;

// ---- 1. MQTT WEBSOCKET KURULUMU ----
// HiveMQ'nun WebSocket portu 8884'tür. (ESP32 standart TCP 1883 kullanır, broker ikisini birleştirir)
let client = new Paho.MQTT.Client("broker.hivemq.com", 8884, "pet2print_edge_phone_" + parseInt(Math.random() * 100, 10));

client.onConnectionLost = onConnectionLost;

function mqttBaglan() {
    client.connect({
        onSuccess: onConnect,
        useSSL: true // WebApp HTTPS üzerinden çalışacağı için SSL şart
    });
}

function onConnect() {
    mqttDurum.innerHTML = "Bağlı";
    mqttDurum.className = "connected";
    console.log("MQTT Broker'a bağlanıldı!");
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        mqttDurum.innerHTML = "Bağlantı Koptu";
        mqttDurum.className = "disconnected";
        console.log("Bağlantı koptu: " + responseObject.errorMessage);
        setTimeout(mqttBaglan, 3000); // 3 saniye sonra tekrar dene
    }
}

// MQTT Veri Gönderme Fonksiyonu (Motoru Güçlendirecek/Yavaşlatacak Veri)
function veriGonder(kalinlik) {
    if (client.isConnected()) {
        // ESP32'nin beklediği JSON formatı
        let payload = JSON.stringify({ 
            "kalinlik": kalinlik,
            "kaynak": "Edge_Phone"
        });
        let message = new Paho.MQTT.Message(payload);
        message.destinationName = "pet2print/telemetry"; // ESP32'nin dinlediği Topic
        client.send(message);
    }
}

// Başlangıçta MQTT'ye bağlan
mqttBaglan();


// ---- 2. OPENCV.JS VE KAMERA İŞLEMLERİ ----
function onOpenCvReady() {
    opencvHazir = true;
    console.log("OpenCV.js yüklendi.");
}

document.getElementById('baslatBtn').addEventListener('click', () => {
    if (!opencvHazir) {
        alert("OpenCV yükleniyor, lütfen bekleyin...");
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: 640, height: 480 }, audio: false })
        .then(function(stream) {
            video.srcObject = stream;
            video.play();
            streaming = true;
            
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                
                // Matrisleri bellekte başlat
                src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
                dst = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
                gray = new cv.Mat();
                blur = new cv.Mat();
                edges = new cv.Mat();
                contours = new cv.MatVector();
                hierarchy = new cv.Mat();
                M = cv.Mat.ones(5, 5, cv.CV_8U);

                requestAnimationFrame(goruntuIsle);
            };
        })
        .catch(function(err) {
            alert("Kamera izni reddedildi!");
        });
});

let sonGonderimZamani = Date.now();

function goruntuIsle() {
    if (!streaming) return;

    // 1. Videoyu Matrise al
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    src.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);

    // 2. Griye Çevir ve Bulanıklaştır (Şeffaf filament kırılmaları için)
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    let ksize = new cv.Size(7, 7);
    cv.GaussianBlur(gray, blur, ksize, 0, 0, cv.BORDER_DEFAULT);

    // 3. Canny Edge Detection (Kenar Bulma)
    cv.Canny(blur, edges, 30, 100, 3, false);

    // 4. Kenarları Genişlet (Dilate) - Kesik ışık kırılmalarını birleştirmek için
    let anchor = new cv.Point(-1, -1);
    cv.dilate(edges, edges, M, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    // 5. Konturları Bul
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let enBuyukAlan = 0;
    let secilenKonturIndex = -1;

    for (let i = 0; i < contours.size(); ++i) {
        let alan = cv.contourArea(contours.get(i));
        if (alan > enBuyukAlan && alan > 500) { // Tozları/Gürültüyü yoksay
            enBuyukAlan = alan;
            secilenKonturIndex = i;
        }
    }

    // Orijinal görüntüyü ekrana basmak için src'yi dst'ye kopyala
    src.copyTo(dst);

    if (secilenKonturIndex !== -1) {
        let rect = cv.boundingRect(contours.get(secilenKonturIndex));
        
        // NESNENİN EN İNCE YÖNÜNÜ BUL (Kalınlık her zaman kısa kenardır)
        let kalinlikPiksel = Math.min(rect.width, rect.height);
        let isHorizontal = rect.width > rect.height; // Nesne yatay mı duruyor?
        
        let color = new cv.Scalar(0, 230, 118, 255); // Yeşil renk
        
        // Kutu yerine Dijital Kumpas çizgileri çekiyoruz
        if (isHorizontal) {
            // Nesne yataysa (filament gibi), üstüne ve altına yatay çizgi çek
            let ustSol = new cv.Point(rect.x, rect.y);
            let ustSag = new cv.Point(rect.x + rect.width, rect.y);
            let altSol = new cv.Point(rect.x, rect.y + rect.height);
            let altSag = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.line(dst, ustSol, ustSag, color, 3);
            cv.line(dst, altSol, altSag, color, 3);
        } else {
            // Nesne dikeyse, sağına ve soluna dikey çizgi çek
            let solUst = new cv.Point(rect.x, rect.y);
            let solAlt = new cv.Point(rect.x, rect.y + rect.height);
            let sagUst = new cv.Point(rect.x + rect.width, rect.y);
            let sagAlt = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.line(dst, solUst, solAlt, color, 3);
            cv.line(dst, sagUst, sagAlt, color, 3);
        }
        
        // KALİBRASYON (Şimdilik 1.75mm için temsili oran)
        // İleride gerçek filament makineye takıldığında bu 50 değerini değiştireceğiz
        let mmHesabi = (kalinlikPiksel * (1.75 / 50)).toFixed(2);
        kalinlikText.innerHTML = mmHesabi + " mm";

        // ESP32'ye Motoru Güçlendir/Yavaşlat Verisini Gönder
        if (Date.now() - sonGonderimZamani > 1000) {
            veriGonder(parseFloat(mmHesabi));
            sonGonderimZamani = Date.now();
        }
    }

    // İşlenmiş görüntüyü canvas'a yaz
    cv.imshow('islemEkrani', dst);

    // Döngüyü tekrarla
    requestAnimationFrame(goruntuIsle);
}