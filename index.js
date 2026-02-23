// File: index.js (VERSION v20.2 - AUTO SUBSCRIBE WEBHOOK)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');


// 👇👇👇 EM ĐÃ ĐIỀN LINK KOYEB CỦA BÁC TỪ ẢNH TRƯỚC 👇👇👇
const APP_URL = "https://advisory-renie-huuhoan-16f8f8fa.koyeb.app";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz80_RIYwoTmjZd3MLWrrtmO2auM_s-LHLJcPAYb_TrgbCbQbT4bz90eC5gBs24dI0/exec"; 
const APPS_SCRIPT_SECRET = "VNGEN123"; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'vngenmart@gmail.com', pass: 'mat_khau_ung_dung_cua_ban' }
});

const processingUserSet = new Set();

let db;
try {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("✅ Đã kết nối Firestore.");
    seedDefaultGifts(); 
} catch (error) { console.error("❌ LỖI FIRESTORE:", error); process.exit(1); }

async function seedDefaultGifts() {
    try {
        const snapshot = await db.collection('customGifts').get();
        if (snapshot.empty) {
            const defaults = ["Dầu Lạnh", "Cao Dán", "Kẹo Sâm"];
            for (const gift of defaults) await db.collection('customGifts').add({ name: gift, inStock: true });
        }
    } catch (e) {}
}

const app = express();

// 👇 ĐOẠN CẤU HÌNH MỞ CỬA CHO WEBSITE SAMVITA.VN 👇
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); 
// 👆 KẾT THÚC ĐOẠN CORS 👆

app.use(express.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({ secret: 'bot-v20-2-auto-sub', resave: false, saveUninitialized: true, cookie: { maxAge: 3600000 } }));

function checkAuth(req, res, next) { if (req.session.loggedIn) next(); else res.redirect('/login'); }
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) { req.session.loggedIn = true; res.redirect('/admin'); }
    else res.send('<h3>Sai mật khẩu! <a href="/login">Thử lại</a></h3>');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- ADMIN CENTER ---
app.get('/admin', checkAuth, async (req, res) => {
    try {
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        let aiConfig = aiDoc.exists ? aiDoc.data() : { apiKey: '', modelName: 'gemini-2.0-flash' };
        
        let configDoc = await db.collection('settings').doc('systemConfig').get();
        let systemStatus = configDoc.exists ? configDoc.data().isActive : true;
        
        let fbDoc = await db.collection('settings').doc('fbConfig').get();
        let fbConfig = fbDoc.exists ? fbDoc.data() : { appId: '', appSecret: '' };

        let giftsSnap = await db.collection('customGifts').get();
        let customGifts = [];
        giftsSnap.forEach(doc => customGifts.push({ id: doc.id, ...doc.data() }));
        
        let productsSnap = await db.collection('products').get();
        let products = [];
        if (!productsSnap.empty) productsSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        
        let pagesSnap = await db.collection('pages').get();
        let pages = [];
        pagesSnap.forEach(doc => pages.push({ id: doc.id, ...doc.data() }));

        let fetchedPages = req.session.fetchedPages || [];

        res.render('admin', { systemStatus, customGifts, products, aiConfig, fbConfig, pages, fetchedPages, appUrl: APP_URL });
    } catch (e) { res.send("Lỗi: " + e.message); }
});

// --- FACEBOOK LOGIN CONFIG ---
app.post('/admin/save-fb-config', checkAuth, async (req, res) => {
    await db.collection('settings').doc('fbConfig').set({
        appId: req.body.appId.trim(),
        appSecret: req.body.appSecret.trim()
    }, { merge: true });
    res.redirect('/admin');
});

app.get('/auth/facebook', async (req, res) => {
    let fbDoc = await db.collection('settings').doc('fbConfig').get();
    if (!fbDoc.exists || !fbDoc.data().appId) return res.send('Chưa cấu hình App ID!');
    
    const appId = fbDoc.data().appId;
    const redirectUri = `${APP_URL}/auth/facebook/callback`;
    const scope = 'pages_show_list,pages_messaging,pages_read_engagement';
    
    const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}`;
    res.redirect(authUrl);
});

app.get('/auth/facebook/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('Không nhận được code từ Facebook.');

    let fbDoc = await db.collection('settings').doc('fbConfig').get();
    const { appId, appSecret } = fbDoc.data();
    const redirectUri = `${APP_URL}/auth/facebook/callback`;

    try {
        const tokenRes = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${redirectUri}&code=${code}`);
        const userToken = tokenRes.data.access_token;
        const pagesRes = await axios.get(`https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`);
        
        req.session.fetchedPages = pagesRes.data.data;
        req.session.save(() => res.redirect('/admin'));
    } catch (e) {
        console.error(e);
        res.send('Lỗi xác thực Facebook: ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    }
});

// ⚠️⚠️⚠️ UPDATE QUAN TRỌNG: KẾT NỐI + TỰ ĐỘNG SUBSCRIBE ⚠️⚠️⚠️
app.post('/admin/connect-page', checkAuth, async (req, res) => {
    const { name, pageId, accessToken } = req.body;
    
    try {
        // 1. Lưu vào Database
        const check = await db.collection('pages').where('pageId', '==', pageId).get();
        if (!check.empty) await db.collection('pages').doc(check.docs[0].id).update({ token: accessToken });
        else await db.collection('pages').add({ name, pageId, token: accessToken });

        // 2. 🔥 GỌI LỆNH KÍCH HOẠT WEBHOOK (SUBSCRIBE APP) 🔥
        // Đây là bước quan trọng để Bot bắt đầu nhận tin nhắn
        console.log(`🔄 Đang kích hoạt Webhook cho Page: ${name} (${pageId})...`);
        await axios.post(`https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`, {
            subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_optins', 'message_deliveries', 'message_reads']
        }, {
            params: { access_token: accessToken }
        });
        console.log(`✅ Đã kích hoạt thành công cho Page: ${name}`);

        req.session.fetchedPages = null;
        res.redirect('/admin');
    } catch (e) {
        console.error("❌ Lỗi kích hoạt Webhook:", e.response ? e.response.data : e.message);
        res.send(`<h3>Lỗi kích hoạt Page: ${name}</h3><p>Nguyên nhân: ${e.response ? JSON.stringify(e.response.data) : e.message}</p><a href="/admin">Quay lại</a>`);
    }
});

app.post('/admin/delete-page', checkAuth, async (req, res) => { await db.collection('pages').doc(req.body.id).delete(); res.redirect('/admin'); });

// --- CÁC ROUTE CŨ (GIỮ NGUYÊN) ---
app.post('/admin/save-all-bulk', checkAuth, async (req, res) => {
    try {
        const products = req.body.products;
        if (!products) return res.status(400).json({ error: "No Data" });
        const batch = db.batch();
        products.forEach(p => {
            const docRef = db.collection('products').doc(p.id);
            batch.update(docRef, { inStock: p.inStock, isFreeship: p.isFreeship, allowedGifts: p.allowedGifts });
        });
        await batch.commit();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/add-gift', checkAuth, async (req, res) => { await db.collection('customGifts').add({ name: req.body.name, inStock: true }); res.redirect('/admin'); });
app.post('/admin/toggle-gift', checkAuth, async (req, res) => { let giftRef = db.collection('customGifts').doc(req.body.id); let doc = await giftRef.get(); if(doc.exists) await giftRef.update({ inStock: !doc.data().inStock }); res.redirect('/admin'); });
app.post('/admin/delete-gift', checkAuth, async (req, res) => { await db.collection('customGifts').doc(req.body.id).delete(); res.redirect('/admin'); });
app.post('/admin/add-product', checkAuth, async (req, res) => { await db.collection('products').add({ name: req.body.name, price: req.body.price, image: req.body.image, desc: "", inStock: true, allowedGifts: [], isFreeship: false }); res.redirect('/admin'); });
app.post('/admin/save-product-info', checkAuth, async (req, res) => { const { id, inStock, ...data } = req.body; data.inStock = (inStock === 'true'); await db.collection('products').doc(id).update(data); res.redirect('/admin'); });
app.post('/admin/delete-product', checkAuth, async (req, res) => { await db.collection('products').doc(req.body.id).delete(); res.redirect('/admin'); });
app.post('/admin/save-ai', checkAuth, async (req, res) => { let updateData = { apiKey: req.body.apiKey.trim(), modelName: "gemini-2.0-flash" }; await db.collection('settings').doc('aiConfig').set(updateData, { merge: true }); res.redirect('/admin'); });
app.post('/admin/toggle-system', checkAuth, async (req, res) => { const newStatus = (req.body.status === 'true'); await db.collection('settings').doc('systemConfig').set({ isActive: newStatus }, { merge: true }); res.redirect('/admin'); });

// --- BOT ENGINE (GIỮ NGUYÊN) ---
async function getPageToken(pageId) {
    let pageSnap = await db.collection('pages').where('pageId', '==', pageId).get();
    if (!pageSnap.empty) return pageSnap.docs[0].data().token;
    const map = new Map();
    if (process.env.PAGE_ID_THAO_KOREA) map.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    if (process.env.PAGE_ID_TRANG_MOI) map.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    return map.get(pageId);
}

async function getGeminiModel() {
    let apiKey = process.env.GEMINI_API_KEY;
    let modelName = "gemini-2.0-flash";
    try {
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        if (aiDoc.exists) {
            const data = aiDoc.data();
            if (data.apiKey) apiKey = data.apiKey;
            if (data.modelName) modelName = data.modelName;
        }
        if (!apiKey) return null;
        const genAI = new GoogleGenerativeAI(apiKey);
        return genAI.getGenerativeModel({ model: modelName });
    } catch (e) { return null; }
}

app.get('/webhook', (req, res) => { if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']); else res.sendStatus(403); });

app.post('/webhook', (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    let body = req.body;
    if (body.object === 'page' && body.entry) {
        body.entry.forEach(async (entry) => {
            const pageId = entry.id;
            if (fs.existsSync('PAUSE_MODE')) return;
            let configDoc = await db.collection('settings').doc('systemConfig').get();
            if (configDoc.exists && configDoc.data().isActive === false) return; 
            if (entry.messaging && entry.messaging.length > 0) {
                const webhook_event = entry.messaging[0];
                if (webhook_event.message && webhook_event.message.is_echo) return;
                if (webhook_event.message) {
                    const senderId = webhook_event.sender.id;
                    const uid = `${pageId}_${senderId}`;
                    const userState = await loadState(uid);
                    if (userState.is_paused) { await saveHistory(uid, 'Khách', webhook_event.message.text || "[Media]"); return; }
                    if (isMissedCall(webhook_event)) { await handleMissedCall(pageId, senderId); return; }
                    let userMessage = webhook_event.message.text || "";
                    let imageUrl = null;
                    if (webhook_event.message.attachments) {
                        const att = webhook_event.message.attachments[0];
                        if (att.type === 'image') { imageUrl = att.payload.url; if (!userMessage) userMessage = "[Khách gửi ảnh]"; }
                        else if (att.type === 'sticker' || webhook_event.message.sticker_id) { if (att.payload) imageUrl = att.payload.url; if (!userMessage) userMessage = "[Khách gửi Sticker]"; }
                    }
                    if (userMessage || imageUrl) await processMessage(pageId, senderId, userMessage, imageUrl, userState);
                }
            }
        });
    } else { res.sendStatus(404); }
});

async function processMessage(pageId, senderId, userMessage, imageUrl, userState) {
    const token = await getPageToken(pageId);
    if (!token) return;
    const uid = `${pageId}_${senderId}`;
    if (processingUserSet.has(uid)) return;
    processingUserSet.add(uid);
    try {
        await sendTyping(token, senderId, true);
        let userName = await getFacebookUserName(token, senderId);
        if (userMessage.toLowerCase().includes("hủy đơn") || userMessage.toLowerCase().includes("bom hàng")) sendAlertEmail(userName, userMessage);
        
        const phoneRegex = /0\d{9}/; 
        const cleanMsg = userMessage.replace(/\s+/g, '').replace(/\./g, '').replace(/-/g, '');
        let hasPhoneNow = phoneRegex.test(cleanMsg);
        let hasPhoneInHistory = userState.history.some(h => h.role === 'Khách' && phoneRegex.test(h.content.replace(/\s+/g, '').replace(/\./g, '')));
        let customerHasProvidedPhone = hasPhoneNow || hasPhoneInHistory;

        if (hasPhoneNow) {
            const matchedPhone = cleanMsg.match(phoneRegex)[0];
            let recentHistory = userState.history.slice(-10);
            let historyText = recentHistory.map(h => `[${h.role}]: ${h.content}`).join('\n');
            let fullConversation = `... (Lược bỏ tin cũ) ...\n${historyText}\n----------------\n[KHÁCH CHỐT]: ${userMessage}`;
            sendPhoneToSheet(matchedPhone, userName, fullConversation);
        }

        let knowledgeBase = await buildKnowledgeBaseFromDB();
        let geminiResult = await callGeminiRetail(userMessage, userName, userState.history, knowledgeBase, imageUrl, customerHasProvidedPhone);
        
        console.log(`[Bot Reply]: ${geminiResult.response_message}`);
        await saveHistory(uid, 'Khách', userMessage);
        await saveHistory(uid, 'Bot', geminiResult.response_message);
        let cleanTextMessage = geminiResult.response_message.replace(/(https?:\/\/[^\s]+)/g, "").trim();
        if (geminiResult.video_url_to_send && geminiResult.video_url_to_send.length > 5) {
            let vids = geminiResult.video_url_to_send.split(',');
            for (let vid of vids) {
                let cleanVid = vid.trim();
                if (cleanVid.endsWith('.mp4') || cleanVid.includes('.mp4?')) await sendVideo(token, senderId, cleanVid);
                else if (cleanVid.startsWith('http')) await sendMessage(token, senderId, `📺 Dạ mời Bác xem video chi tiết tại đây ạ: ${cleanVid}`);
            }
        }
        if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 5) {
            let imgs = geminiResult.image_url_to_send.split(',');
            for (let img of imgs) if(img.trim().startsWith('http')) await sendImage(token, senderId, img.trim());
        }
        let msgs = cleanTextMessage.split('|');
        await sendTyping(token, senderId, false);
        for (let msg of msgs) {
            if (msg.trim()) {
                await sendTyping(token, senderId, true);
                await new Promise(r => setTimeout(r, 1000));
                await sendMessage(token, senderId, msg.trim());
            }
        }
    } catch (e) { console.error("Lỗi:", e); } finally { processingUserSet.delete(uid); }
}

async function sendPhoneToSheet(phone, name, message) {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("xxxxxxxxx")) return;
    try {
        console.log(`[SHEET] Đang gửi thông tin khách: ${name}...`);
        let res = await axios.post(APPS_SCRIPT_URL, { secret: APPS_SCRIPT_SECRET, phone: phone, name: name, message: message });
        if (res.data.ok) console.log(`[SHEET] ✅ OK.`);
    } catch (e) { console.error("[SHEET ERROR]", e.message); }
}

async function buildKnowledgeBaseFromDB() {
    let rulesDoc = await db.collection('settings').doc('generalRules').get();
    let rules = rulesDoc.exists ? rulesDoc.data().content : "Luật chung...";
    let productsSnap = await db.collection('products').get();
    let productFull = "";
    let productSummary = "DANH SÁCH RÚT GỌN:\n";
    
    let shippingRules = "=== QUY ĐỊNH PHÍ SHIP (QUAN TRỌNG) ===\n";
    shippingRules += "1. NẾU tổng giá trị đơn hàng > 500k -> FREESHIP.\n";
    shippingRules += "2. NẾU tổng giá trị đơn hàng <= 500k -> Phí ship là 20k.\n";
    shippingRules += "3. TRỪ KHI sản phẩm đó có ghi chú '[Đặc biệt: FREESHIP]' thì dù giá thấp cũng được Freeship.\n";

    if (productsSnap.empty) { productFull = "Chưa có SP"; } else {
        productsSnap.forEach(doc => {
            let p = doc.data();
            let stockStatus = (p.inStock === false) ? " (❌ TẠM HẾT HÀNG)" : " (✅ CÒN HÀNG)";
            let nameWithStock = p.name + stockStatus;
            let shipNote = (p.isFreeship) ? " [Đặc biệt: FREESHIP]" : " [Tính ship theo tổng đơn]";
            let giftInfo = "KHÔNG tặng kèm quà";
            if (p.allowedGifts && p.allowedGifts.length > 0) { giftInfo = `Tặng 1 trong các món: [${p.allowedGifts.join(" HOẶC ")}]`; } else { giftInfo = "KHÔNG tặng quà khác."; }
            let cleanDesc = p.desc || "";
            if (p.name.toLowerCase().includes("kwangdong")) cleanDesc += " (Thành phần: Có chứa trầm hương tự nhiên)";
            productFull += `- Tên: ${nameWithStock}\n  + Giá: ${p.price}${shipNote}\n  + Quà Tặng: ${giftInfo}\n  + Thông tin: ${cleanDesc}\n  + Ảnh (URL): "${p.image}"\n`;
            let priceVal = parseInt(p.price.replace(/\D/g, '')) || 0;
            let isMainProduct = priceVal >= 500 || p.name.includes("An Cung") || p.name.includes("Thông Đỏ");
            if (isMainProduct) productSummary += `- ${nameWithStock}: ${p.price}\n`;
        });
    }
    return `=== LUẬT CHUNG ===\n${rules}\n\n${shippingRules}\n\n=== DANH SÁCH SẢN PHẨM ===\n${productFull}\n=== DATA RÚT GỌN ===\n${productSummary}`;
}

async function callGeminiRetail(userMessage, userName, history, knowledgeBase, imageUrl = null, hasPhone = false) {
    const model = await getGeminiModel();
    if (!model) return { response_message: "Dạ Bác chờ Shop xíu nha." };
    try {
        const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');
        const greetingName = userName ? "Bác " + userName : "Bác";
        const VIDEO_CHECK_SAMSUNG = "https://www.facebook.com/share/v/1Su33dR62T/"; 
        const VIDEO_INTRO_KWANGDONG = "https://www.facebook.com/share/v/1aX41A7wCY/"; 
        
        let prompt = `**VAI TRÒ:** Chuyên viên tư vấn Shop Thảo Korea. Khách: '${greetingName}'.
**DỮ LIỆU SẢN PHẨM (ĐỌC KỸ):**
${knowledgeBase}

**QUY TẮC SHIP & QUÀ (TUÂN THỦ 100%):**
1. **Phí Ship:** Nếu Tổng Tiền > 500k -> Freeship. Nếu <= 500k -> Phí 20k (Trừ khi món đó ghi [Đặc biệt: FREESHIP]).
2. **Quà Tặng:** Chỉ tặng những món trong ngoặc vuông [ ].

**QUY TẮC CHỐNG NHẦM SẢN PHẨM (CAO HỒNG SÂM):**
- Hộp **2 lọ**: Giá **470k**.
- Hộp **4 lọ**: Giá **850k**.
- Khách hỏi "2 lọ" -> Báo giá 470k (Và tính ship 20k vì < 500k).

**LUẬT GIÁ AN CUNG SAMSUNG:**
- Giá 780k -> Có quà.
- Giá 750k -> CẮT HẾT QUÀ.

**TRẠNG THÁI SĐT:** ${hasPhone ? "✅ ĐÃ CÓ" : "❌ CHƯA CÓ"}. (Đã có thì KHÔNG xin lại).

**LỊCH SỬ:**
${historyText}
**INPUT:** "${userMessage}"
${imageUrl ? "[Khách gửi ảnh]" : ""}
**JSON:** { "response_message": "...", "image_url_to_send": "", "video_url_to_send": "" }`;

        let parts = [{ text: prompt }];
        if (imageUrl) {
            let imgData = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            parts.push({ inlineData: { data: Buffer.from(imgData.data).toString('base64'), mimeType: "image/jpeg" }});
        }
        let result = await model.generateContent(parts);
        let jsonStr = result.response.text().match(/\{[\s\S]*\}/)[0];
        return JSON.parse(jsonStr);
    } catch (e) { console.error("Gemini Error:", e); return { response_message: "Dạ Bác chờ Shop xíu nha." }; }
}

async function setBotStatus(uid, status) { try { await db.collection('users').doc(uid).set({ is_paused: status }, { merge: true }); } catch(e){} }
async function loadState(uid) { try { let d = await db.collection('users').doc(uid).get(); return d.exists ? d.data() : { history: [], is_paused: false }; } catch(e){ return { history: [], is_paused: false }; } }
async function saveHistory(uid, role, content) { try { await db.collection('users').doc(uid).set({ history: admin.firestore.FieldValue.arrayUnion({ role, content }), last_updated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch(e){} }
function isMissedCall(event) { return (event.message.text && event.message.text.toLowerCase().includes("bỏ lỡ cuộc gọi")) || (event.message.attachments && event.message.attachments[0].type === 'fallback'); }
async function handleMissedCall(pageId, senderId) { const token = await getPageToken(pageId); if(token) await sendMessage(token, senderId, "Dạ Shop thấy Bác gọi nhỡ. Bác cần gấp vui lòng gọi Hotline 0986.646.845 ạ!"); }
async function sendAlertEmail(name, msg) { try { await transporter.sendMail({ from: 'vngenmart@gmail.com', to: 'vngenmart@gmail.com', subject: `KHÁCH ${name} HỦY ĐƠN`, text: msg }); } catch(e){} }
async function sendTyping(token, id, status) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, sender_action: status ? "typing_on" : "typing_off" }); } catch(e){} }
async function sendMessage(token, id, text) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { text, metadata: "FROM_BOT_AUTO" } }); } catch(e){} }
async function sendImage(token, id, url) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { attachment: { type: "image", payload: { url, is_reusable: true } }, metadata: "FROM_BOT_AUTO" } }); } catch(e){} }
async function sendVideo(token, id, url) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { attachment: { type: "video", payload: { url, is_reusable: true } }, metadata: "FROM_BOT_AUTO" } }); } catch(e){} }
async function getFacebookUserName(token, id) { try { const res = await axios.get(`https://graph.facebook.com/${id}?fields=first_name,last_name&access_token=${token}`); return res.data ? res.data.last_name : "Bác"; } catch(e){ return "Bác"; } }

// ==========================================
// API DÀNH RIÊNG CHO WEBSITE CHAT WIDGET
// ==========================================
// API DÀNH RIÊNG CHO WEBSITE
app.post('/api/webchat', async (req, res) => {
    try {
        const { message } = req.body;
        let knowledgeBase = await buildKnowledgeBaseFromDB();
        let prompt = `**VAI TRÒ:** Chuyên viên tư vấn Shop Thảo Korea trực trên Website.\n**DỮ LIỆU:**\n${knowledgeBase}\n**KHÁCH HỎI:** "${message}"\n**NHIỆM VỤ:** Trả lời trực tiếp bằng văn bản thuần, không dùng markdown rườm rà. Xin SĐT nếu chốt đơn.`;

        const model = await getGeminiModel();
        if (!model) return res.json({ success: false, reply: "Hệ thống AI đang khởi động, Bác chờ xíu nhé!" });

        let result = await model.generateContent(prompt);
        let replyText = result.response.text().trim();
        res.json({ success: true, reply: replyText });
    } catch (e) {
        console.error("Lỗi Webchat:", e);
        res.json({ success: false, reply: "Dạ mạng đang nghẽn, Bác thử lại giúp Shop nha!" });
    }
});

app.listen(PORT, () => console.log(`🚀 Bot v20.2 (Auto Subscribe) chạy tại port ${PORT}`));