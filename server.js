const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    proto
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3100;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://agorsoftware.com/berber/api/webhook.php';
const DB_SYNC_URL = process.env.DB_SYNC_URL || 'https://agorsoftware.com/berber/api/wa_session.php';
const DB_SYNC_TOKEN = 'wa_gateway_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Canlı Log Kayıtları (Son 100 logu hafızada tutar ve /logs endpointinde gösterir)
const recentLogs = [];
function addLog(msg) {
    const time = new Date().toLocaleTimeString('tr-TR', { hour12: false });
    const line = `[${time}] ${msg}`;
    console.log(line);
    recentLogs.unshift(line);
    if (recentLogs.length > 100) recentLogs.pop();
}

// Mesaj Tekrar Deneme Sayacı Önbelleği (WhatsApp'ın "Mesaj bekleniyor..." hatasını çözer)
const retryMap = new Map();
const msgRetryCounterCache = {
    get: (key) => retryMap.get(key),
    set: (key, value) => { retryMap.set(key, value); return true; },
    del: (key) => retryMap.delete(key),
    flushAll: () => retryMap.clear()
};

// Son gönderilen ve alınan mesajları hafızada tutan depo (WhatsApp retry/rekey istediğinde sunar)
const messageStore = new Map();
function storeMessage(key, message) {
    if (!key || !key.id) return;
    messageStore.set(key.id, message);
    if (messageStore.size > 2000) {
        const firstKey = messageStore.keys().next().value;
        messageStore.delete(firstKey);
    }
}

// Tenant Oturumları Deposu
// sessions[tenantId] = { sock, qr, qrImage, status, phone }
const sessions = {};

const logger = pino({ level: 'silent' });

/**
 * Mesaj nesnesinden her türlü metni güvenle çıkarır
 */
function extractMessageText(msg) {
    if (!msg || !msg.message) return '';
    const m = msg.message.ephemeralMessage?.message ||
              msg.message.viewOnceMessage?.message ||
              msg.message.viewOnceMessageV2?.message ||
              msg.message.documentWithCaptionMessage?.message ||
              msg.message;

    return m.conversation ||
           m.extendedTextMessage?.text ||
           m.buttonsResponseMessage?.selectedButtonId ||
           m.listResponseMessage?.singleSelectReply?.selectedRowId ||
           m.templateButtonReplyMessage?.selectedId ||
           m.imageMessage?.caption ||
           m.videoMessage?.caption ||
           '';
}

/**
 * MySQL Veritabanından oturum dosyalarını indirip yerel klasöre yazar
 */
async function restoreSessionFromDb(tenantId, sessionDir) {
    try {
        const url = `${DB_SYNC_URL}?action=load&tenant=${tenantId}&token=${DB_SYNC_TOKEN}`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BaileysGateway/1.0' },
            timeout: 10000
        });

        if (res.data && res.data.success && res.data.files && Object.keys(res.data.files).length > 0) {
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }
            let written = 0;
            for (const [fileName, content] of Object.entries(res.data.files)) {
                fs.writeFileSync(path.join(sessionDir, fileName), content, 'utf-8');
                written++;
            }
            addLog(`[Tenant ${tenantId}] 📥 MySQL Veritabanından ${written} oturum dosyası geri yüklendi!`);
            return true;
        }
    } catch (e) {
        addLog(`[Tenant ${tenantId}] ⚠️ Veritabanından oturum yüklenemedi: ${e.message}`);
    }
    return false;
}

/**
 * Yerel oturum dosyalarını MySQL veritabanına otomatik yedekler (Debounced)
 */
const backupTimeouts = {};
function scheduleBackupToDb(tenantId, sessionDir, delayMs = 4000) {
    if (backupTimeouts[tenantId]) {
        clearTimeout(backupTimeouts[tenantId]);
    }
    backupTimeouts[tenantId] = setTimeout(async () => {
        try {
            if (!fs.existsSync(sessionDir)) return;
            const fileNames = fs.readdirSync(sessionDir);
            if (fileNames.length === 0) return;

            const filesObj = {};
            for (const f of fileNames) {
                const fullPath = path.join(sessionDir, f);
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    filesObj[f] = fs.readFileSync(fullPath, 'utf-8');
                }
            }

            const url = `${DB_SYNC_URL}?action=save&tenant=${tenantId}&token=${DB_SYNC_TOKEN}`;
            await axios.post(url, { files: filesObj }, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BaileysGateway/1.0'
                },
                timeout: 15000
            });
            addLog(`[Tenant ${tenantId}] 💾 Oturum MySQL veritabanına yedeklendi (${Object.keys(filesObj).length} dosya)`);
        } catch (e) {
            addLog(`[Tenant ${tenantId}] ⚠️ MySQL yedekleme hatası: ${e.message}`);
        }
    }, delayMs);
}

/**
 * Veritabanındaki oturum kaydını temizler
 */
async function deleteSessionFromDb(tenantId) {
    try {
        const url = `${DB_SYNC_URL}?action=delete&tenant=${tenantId}&token=${DB_SYNC_TOKEN}`;
        await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BaileysGateway/1.0' },
            timeout: 10000
        });
        addLog(`[Tenant ${tenantId}] 🗑️ Oturum MySQL veritabanından silindi`);
    } catch (e) {
        addLog(`[Tenant ${tenantId}] ⚠️ MySQL oturum silme hatası: ${e.message}`);
    }
}

/**
 * Tenant için WhatsApp Baileys bağlantısını başlatır
 */
async function initSession(tenantId) {
    if (sessions[tenantId] && sessions[tenantId].sock) {
        return sessions[tenantId];
    }

    const sessionDir = path.join(__dirname, 'sessions', `tenant_${tenantId}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Yerel diskte creds.json yoksa, MySQL veritabanından geri yükle
    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
        addLog(`[Tenant ${tenantId}] Yerel oturum bulunamadı, MySQL veritabanından aranıyor...`);
        await restoreSessionFromDb(tenantId, sessionDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: true,
        shouldSyncHistoryMessage: (msg) => {
            return msg.syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
                   msg.syncType === proto.HistorySync.HistorySyncType.PUSH_NAME ||
                   msg.syncType === proto.HistorySync.HistorySyncType.RECENT;
        },
        msgRetryCounterCache,
        getMessage: async (key) => {
            if (messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return {
                conversation: 'BerberRandevu Bot'
            };
        }
    });

    sessions[tenantId] = {
        sock,
        qr: null,
        qrImage: null,
        status: 'connecting',
        phone: null
    };

    // Kimlik bilgilerini güncelle ve veritabanına yedekle
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        scheduleBackupToDb(tenantId, sessionDir, 4000);
    });

    // Bağlantı durumu değişiklikleri
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessions[tenantId].qr = qr;
            sessions[tenantId].status = 'qr_ready';
            try {
                sessions[tenantId].qrImage = await qrcode.toDataURL(qr);
            } catch (err) {
                addLog(`[Tenant ${tenantId}] QR hatası: ${err.message}`);
            }
            addLog(`[Tenant ${tenantId}] Yeni Karekod oluşturuldu. Okutulmayı bekliyor...`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            addLog(`[Tenant ${tenantId}] Bağlantı kapandı. Sebep: ${statusCode}. Yeniden bağlanılsın mı: ${shouldReconnect}`);
            sessions[tenantId].status = 'disconnected';
            sessions[tenantId].sock = null;

            if (shouldReconnect) {
                setTimeout(() => initSession(tenantId), 3000);
            } else {
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {}
                await deleteSessionFromDb(tenantId);
                delete sessions[tenantId];
            }
        } else if (connection === 'open') {
            const userPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Bilinmiyor';
            sessions[tenantId].status = 'connected';
            sessions[tenantId].phone = userPhone;
            sessions[tenantId].qr = null;
            sessions[tenantId].qrImage = null;

            addLog(`[Tenant ${tenantId}] 🟢 WHATSAPP BAĞLANDI! Numara: +${userPhone}`);
            scheduleBackupToDb(tenantId, sessionDir, 1000);
        }
    });

    // Mesaj işleme fonksiyonu (upsert ve update için ortak)
    async function handleIncomingMessage(msg) {
        if (!msg || !msg.key) return;

        if (msg.message) {
            storeMessage(msg.key, msg.message);
        }

        const remoteJid = msg.key.remoteJid || '';

        // Grupları ve durum bildirimlerini yoksay
        if (remoteJid.endsWith('@g.us') || remoteJid.includes('broadcast')) return;

        const text = extractMessageText(msg);

        // Kendi attığımız mesaj kontrolü
        if (msg.key.fromMe) {
            if (text) addLog(`[Tenant ${tenantId}] (Kendi mesajımız yok sayıldı): "${text.substring(0, 30)}"`);
            return;
        }

        const isLid = remoteJid.endsWith('@lid');
        const senderPnRaw = msg.key.senderPn || msg.key.participantPn || '';
        const realPhone = senderPnRaw ? senderPnRaw.split('@')[0] : (isLid ? remoteJid : remoteJid.split('@')[0]);

        if (!text || text.trim() === '') {
            const stubParams = msg.messageStubParameters ? JSON.stringify(msg.messageStubParameters) : '';
            addLog(`[Tenant ${tenantId}] ℹ️ Metinsiz/Stub: ${realPhone} (Stub: ${msg.messageStubType || 'yok'}${stubParams ? ' - ' + stubParams : ''})`);
            return;
        }

        addLog(`[Tenant ${tenantId}] 📩 Gelen Mesaj: ${realPhone} -> "${text}"`);

        // Yeni oturum / ratchet anahtarlarını veritabanına yedekle (debounce 5 sn)
        scheduleBackupToDb(tenantId, sessionDir, 5000);

        // PHP Webhook'a ilet
        const webhookUrl = `${WEBHOOK_BASE_URL}?tenant=${tenantId}&provider=baileys`;
        const payload = {
            event_type: 'message_received',
            provider: 'baileys',
            tenant_id: tenantId,
            data: {
                from: realPhone,
                jid: remoteJid,
                body: text.trim(),
                fromMe: false
            }
        };

        axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 12000
        })
        .then(res => {
            addLog(`[Tenant ${tenantId}] 🚀 Webhook Yanıtı: HTTP ${res.status}`);
        })
        .catch(err => {
            addLog(`[Tenant ${tenantId}] ⚠️ Webhook Hatası: ${err.message}`);
        });
    }

    // Gelen mesajları dinle
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            if (!chatUpdate.messages || chatUpdate.messages.length === 0) return;
            for (const msg of chatUpdate.messages) {
                await handleIncomingMessage(msg);
            }
        } catch (e) {
            addLog(`[Tenant ${tenantId}] Mesaj işleme hatası: ${e.message}`);
        }
    });

    // Yeniden deneme (retry) sonrası gecikmeli çözülen mesajları dinle
    sock.ev.on('messages.update', async (messageUpdates) => {
        try {
            if (!messageUpdates || messageUpdates.length === 0) return;
            for (const { key, update } of messageUpdates) {
                if (update && update.message && !key.fromMe) {
                    addLog(`[Tenant ${tenantId}] 🔓 Gecikmeli Şifresi Çözülen Mesaj: ${key.remoteJid}`);
                    await handleIncomingMessage({ key, message: update.message });
                }
            }
        } catch (e) {
            addLog(`[Tenant ${tenantId}] messages.update hatası: ${e.message}`);
        }
    });

    return sessions[tenantId];
}

// ========================================================
// API ENDPOINTLARI
// ========================================================

// 1. Ana Durum Sayfası
app.get('/', (req, res) => {
    res.json({
        service: 'BerberRandevu WhatsApp Gateway (Baileys)',
        status: 'online',
        activeSessions: Object.keys(sessions).length,
        time: new Date().toISOString()
    });
});

// 2. Canlı Loglar (Hata tespiti için)
app.get('/logs', (req, res) => {
    res.json({
        success: true,
        count: recentLogs.length,
        logs: recentLogs
    });
});

// 3. Webhook Test Endpointi (Render -> PHP sunucu bağlantısını test eder)
app.get('/test-webhook', async (req, res) => {
    const tenantId = req.query.tenant || '5';
    const testPhone = req.query.phone || '905542822751';
    const webhookUrl = `${WEBHOOK_BASE_URL}?tenant=${tenantId}&provider=baileys`;

    addLog(`[Test] Webhook test isteği gönderiliyor: ${webhookUrl}`);

    try {
        const payload = {
            event_type: 'message_received',
            provider: 'baileys',
            tenant_id: tenantId,
            data: {
                from: testPhone,
                body: '1',
                fromMe: false
            }
        };

        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 12000
        });

        addLog(`[Test] Webhook başarılı: HTTP ${response.status}`);
        res.json({
            success: true,
            status: response.status,
            data: response.data
        });
    } catch (err) {
        addLog(`[Test] Webhook BAŞARISIZ: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message,
            response: err.response?.data || null,
            status: err.response?.status || null
        });
    }
});

// 4. Canlı Durum Sorgulama
app.get('/status', async (req, res) => {
    const tenantId = req.query.tenant || '5';
    let sess = sessions[tenantId];

    if (!sess) {
        sess = await initSession(tenantId);
    }

    res.json({
        success: true,
        tenant_id: tenantId,
        status: sess.status,
        phone: sess.phone,
        has_qr: !!sess.qrImage
    });
});

// 5. QR Kod Getir (Resim / Data URL)
app.get('/qr', async (req, res) => {
    const tenantId = req.query.tenant || '5';
    let sess = sessions[tenantId];

    if (!sess || (!sess.qrImage && sess.status !== 'connected')) {
        sess = await initSession(tenantId);
    }

    if (sess.status === 'connected') {
        return res.json({
            success: true,
            status: 'connected',
            phone: sess.phone,
            message: 'WhatsApp zaten bagli'
        });
    }

    let attempts = 0;
    while (!sess.qrImage && attempts < 15) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
    }

    if (sess.qrImage) {
        if (req.query.format === 'img') {
            const base64Data = sess.qrImage.replace(/^data:image\/png;base64,/, '');
            const imgBuffer = Buffer.from(base64Data, 'base64');
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': imgBuffer.length
            });
            return res.end(imgBuffer);
        }

        return res.json({
            success: true,
            status: 'qr_ready',
            qr_data_url: sess.qrImage
        });
    }

    res.json({
        success: false,
        status: sess.status || 'waiting',
        message: 'Karekod hazirlaniyor, lutfen 2 saniye sonra yenileyin'
    });
});

// 6. Mesaj Gönder (Outbound)
app.post('/send', async (req, res) => {
    try {
        const tenantId = req.body.tenant || req.query.tenant || '5';
        const to = req.body.to;
        const message = req.body.message;

        if (!to || !message) {
            return res.status(400).json({ success: false, error: 'to ve message alanlari zorunludur' });
        }

        let sess = sessions[tenantId];
        if (!sess || !sess.sock || sess.status !== 'connected') {
            return res.status(503).json({ success: false, error: 'Bu dukkanin WhatsApp oturumu bagli degil' });
        }

        let targetJid;
        const toStr = to.toString().trim();
        if (toStr.includes('@')) {
            targetJid = toStr;
        } else if (toStr.length >= 14 && !toStr.startsWith('90')) {
            // WhatsApp LID formatı (örn: 190151154237634)
            targetJid = `${toStr}@lid`;
        } else {
            let cleanPhone = toStr.replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('0')) {
                cleanPhone = '90' + cleanPhone.substring(1);
            } else if (!cleanPhone.startsWith('90') && cleanPhone.length === 10) {
                cleanPhone = '90' + cleanPhone;
            }
            targetJid = `${cleanPhone}@s.whatsapp.net`;
        }

        const sent = await sess.sock.sendMessage(targetJid, { text: message });
        if (sent?.key && sent?.message) {
            storeMessage(sent.key, sent.message);
        }

        const sessionDir = path.join(__dirname, 'sessions', `tenant_${tenantId}`);
        scheduleBackupToDb(tenantId, sessionDir, 5000);

        addLog(`[Tenant ${tenantId}] 📤 Giden Mesaj: ${targetJid} -> "${message.substring(0, 35)}..."`);
        res.json({ success: true, to: targetJid, status: 'sent' });
    } catch (err) {
        addLog(`[Tenant ${tenantId}] ⚠️ Mesaj gönderme hatası: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Çıkış Yap / Bağlantıyı Kes
app.post('/disconnect', async (req, res) => {
    try {
        const tenantId = req.body.tenant || req.query.tenant || '5';
        const sess = sessions[tenantId];

        if (sess && sess.sock) {
            await sess.sock.logout();
        }

        const sessionDir = path.join(__dirname, 'sessions', `tenant_${tenantId}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        await deleteSessionFromDb(tenantId);
        delete sessions[tenantId];
        addLog(`[Tenant ${tenantId}] 🔴 Oturum kapatıldı ve temizlendi`);
        res.json({ success: true, message: 'Oturum kapatildi ve veriler temizlendi' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Sunucuyu Başlat
app.listen(PORT, () => {
    addLog(`🚀 BerberRandevu Baileys WhatsApp Gateway Port ${PORT} üzerinde hazır!`);
    addLog(`📡 Webhook Hedefi: ${WEBHOOK_BASE_URL}`);

    // Otomatik tenant 5 başlat
    initSession('5').catch(err => {
        addLog(`Tenant 5 baslatma hatasi: ${err.message}`);
    });

    // 5 Dakikalık Canlılık (Keep-Alive) Döngüsü
    // Render Free sunucusunun uyku moduna geçmesini önlemek için her 5 dakikada bir PHP cron'a ping atar
    setInterval(async () => {
        try {
            const keepAliveUrl = 'https://agorsoftware.com/berber/api/cron_keepalive.php?token=berber_cron_2026';
            await axios.get(keepAliveUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BaileysGateway/1.0' },
                timeout: 8000
            });
            addLog(`[KeepAlive] 💓 5 dakikalık canlılık kontrolü tamamlandı.`);
        } catch (e) {
            addLog(`[KeepAlive] ⚠️ Ping notu: ${e.message}`);
        }
    }, 5 * 60 * 1000);
});
