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
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3100;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://agorsoftware.com/berber/api/webhook.php';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Tenant Oturumlari Deposu
// sessions[tenantId] = { sock, qr, qrImage, status, phone }
const sessions = {};

const logger = pino({ level: 'silent' });

/**
 * Tenant icin WhatsApp Baileys baglantisini baslatir
 */
async function initSession(tenantId) {
    if (sessions[tenantId] && sessions[tenantId].sock) {
        return sessions[tenantId];
    }

    const sessionDir = path.join(__dirname, 'sessions', `tenant_${tenantId}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['BerberRandevu Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sessions[tenantId] = {
        sock,
        qr: null,
        qrImage: null,
        status: 'connecting',
        phone: null
    };

    // Kimlik bilgilerini guncelle
    sock.ev.on('creds.update', saveCreds);

    // Baglanti durumu degisiklikleri
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessions[tenantId].qr = qr;
            sessions[tenantId].status = 'qr_ready';
            try {
                sessions[tenantId].qrImage = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error(`QR olusturulamadi (Tenant ${tenantId}):`, err.message);
            }
            console.log(`[Tenant ${tenantId}] Yeni Karekod Olusturuldu. Okutulmayi bekliyor...`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[Tenant ${tenantId}] Baglanti kapandi. Sebep: ${statusCode}. Yeniden baglanilsin mi: ${shouldReconnect}`);
            sessions[tenantId].status = 'disconnected';
            sessions[tenantId].sock = null;

            if (shouldReconnect) {
                setTimeout(() => initSession(tenantId), 3000);
            } else {
                // Oturum sonlandiysa dosyalari temizle
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {}
                delete sessions[tenantId];
            }
        } else if (connection === 'open') {
            const userPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Bilinmiyor';
            sessions[tenantId].status = 'connected';
            sessions[tenantId].phone = userPhone;
            sessions[tenantId].qr = null;
            sessions[tenantId].qrImage = null;

            console.log(`[Tenant ${tenantId}] 🟢 WHATSAPP BAGLANDI! Telefon: +${userPhone}`);
        }
    });

    // Gelen mesajlari dinle
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            if (chatUpdate.type !== 'notify') return;

            for (const msg of chatUpdate.messages) {
                // Kendi attigimiz mesajlari yok say
                if (msg.key.fromMe) continue;

                // Grup mesajlarini yok say (yalnizca kisisel sohbetler)
                const remoteJid = msg.key.remoteJid || '';
                if (!remoteJid.endsWith('@s.whatsapp.net')) continue;

                // Mesaj metnini ayikla
                const text = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.buttonsResponseMessage?.selectedButtonId ||
                    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                    '';

                if (!text || text.trim() === '') continue;

                const fromPhone = remoteJid.replace('@s.whatsapp.net', '');
                console.log(`[Tenant ${tenantId}] 📩 Gelen Mesaj: ${fromPhone} -> "${text}"`);

                // PHP Webhook'a ilet
                const webhookUrl = `${WEBHOOK_BASE_URL}?tenant=${tenantId}&provider=baileys`;
                const payload = {
                    event_type: 'message_received',
                    provider: 'baileys',
                    tenant_id: tenantId,
                    data: {
                        from: fromPhone,
                        body: text.trim(),
                        fromMe: false
                    }
                };

                axios.post(webhookUrl, payload, { timeout: 10000 })
                    .then(res => {
                        console.log(`[Tenant ${tenantId}] 🚀 Webhook Yaniti: HTTP ${res.status}`);
                    })
                    .catch(err => {
                        console.error(`[Tenant ${tenantId}] ⚠️ Webhook Hatasi:`, err.message);
                    });
            }
        } catch (e) {
            console.error(`[Tenant ${tenantId}] Mesaj isleme hatasi:`, e.message);
        }
    });

    return sessions[tenantId];
}

// ========================================================
// API ENDPOINTLARI
// ========================================================

// 1. Ana Durum Sayfasi
app.get('/', (req, res) => {
    res.json({
        service: 'BerberRandevu WhatsApp Gateway (Baileys)',
        status: 'online',
        activeSessions: Object.keys(sessions).length,
        time: new Date().toISOString()
    });
});

// 2. Canli Durum Sorgulama
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

// 3. QR Kod Getir (Resim / Data URL)
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

    // QR kod uretilene kadar maksimum 3 saniye bekle
    let attempts = 0;
    while (!sess.qrImage && attempts < 15) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
    }

    if (sess.qrImage) {
        // format query kontrolu (raw image mi data url mi)
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

// 4. Mesaj Gonder (Outbound)
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

        // Telefonu temizle
        let cleanPhone = to.toString().replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) {
            cleanPhone = '90' + cleanPhone.substring(1);
        } else if (!cleanPhone.startsWith('90') && cleanPhone.length === 10) {
            cleanPhone = '90' + cleanPhone;
        }

        const jid = `${cleanPhone}@s.whatsapp.net`;
        await sess.sock.sendMessage(jid, { text: message });

        console.log(`[Tenant ${tenantId}] 📤 Giden Mesaj: ${cleanPhone} -> "${message.substring(0, 40)}..."`);
        res.json({ success: true, to: cleanPhone, status: 'sent' });
    } catch (err) {
        console.error('Mesaj gonderme hatasi:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Cikis Yap / Baglantiyi Kes
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

        delete sessions[tenantId];
        res.json({ success: true, message: 'Oturum kapatildi ve veriler temizlendi' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Sunucuyu Baslat
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 BerberRandevu Baileys WhatsApp Gateway Calisiyor!`);
    console.log(`🌐 Port: ${PORT}`);
    console.log(`📡 Webhook Hedefi: ${WEBHOOK_BASE_URL}`);
    console.log(`=======================================================`);

    // Varsayilan olarak tenant 5'i otomatik baslat
    initSession('5').catch(err => {
        console.error('Tenant 5 baslatma hatasi:', err.message);
    });
});
