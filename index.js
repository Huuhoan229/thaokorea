// File: index.js (Phiên bản "MULTI-BOT v14.0" - AI Customization: Chon Model & API Key Tren Web)

// =================================================================
// 1. KHAI BÁO THƯ VIỆN & CẤU HÌNH CỐ ĐỊNH
// =================================================================
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;
const DEFAULT_GEMINI_KEY = process.env.GEMINI_API_KEY; // Key mặc định từ ENV
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Cấu hình Email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'vngenmart@gmail.com', pass: 'mat_khau_ung_dung_cua_ban' }
});

const processingUserSet = new Set();

// =================================================================
// 2. KẾT NỐI DATABASE
// =================================================================
let db;
try {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("✅ Đã kết nối Firestore.");
} catch (error) { console.error("❌ LỖI FIRESTORE:", error); process.exit(1); }

// =================================================================
// 3. CẤU HÌNH SERVER WEB
// =================================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({ secret: 'bot-v14-ai-custom', resave: false, saveUninitialized: true, cookie: { maxAge: 3600000 } }));

// =================================================================
// PHẦN A: WEB ADMIN ROUTES (QUẢN TRỊ)
// =================================================================

function checkAuth(req, res, next) { if (req.session.loggedIn) next(); else res.redirect('/login'); }

app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) { req.session.loggedIn = true; res.redirect('/admin'); }
    else res.send('<h3>Sai mật khẩu! <a href="/login">Thử lại</a></h3>');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- DASHBOARD CHÍNH ---
app.get('/admin', checkAuth, async (req, res) => {
    try {
        // 1. Cấu hình AI (MỚI)
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        let aiConfig = aiDoc.exists ? aiDoc.data() : { apiKey: '', modelName: 'gemini-2.0-flash' };

        // 2. Trạng thái Bot
        let configDoc = await db.collection('settings').doc('systemConfig').get();
        let systemStatus = configDoc.exists ? configDoc.data().isActive : true;

        // 3. Luật Chung
        let rulesDoc = await db.collection('settings').doc('generalRules').get();
        let generalRules = rulesDoc.exists ? rulesDoc.data().content : getDefaultRules();

        // 4. Danh sách Page
        let pagesSnap = await db.collection('pages').get();
        let pages = [];
        pagesSnap.forEach(doc => pages.push({ id: doc.id, ...doc.data() }));

        // 5. Sản Phẩm
        let productsSnap = await db.collection('products').get();
        let products = [];
        if (productsSnap.empty) {
            products = getDefaultProducts();
            for (let p of products) await db.collection('products').add(p);
            let newSnap = await db.collection('products').get();
            newSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        } else {
            productsSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        }

        res.render('admin', { systemStatus, generalRules, pages, products, aiConfig });
    } catch (e) { res.send("Lỗi: " + e.message); }
});

// --- LƯU CẤU HÌNH AI (MỚI) ---
app.post('/admin/save-ai', checkAuth, async (req, res) => {
    await db.collection('settings').doc('aiConfig').set({
        apiKey: req.body.apiKey.trim(),
        modelName: req.body.modelName
    }, { merge: true });
    res.redirect('/admin');
});

// --- CÁC CHỨC NĂNG KHÁC ---
app.post('/admin/toggle-system', checkAuth, async (req, res) => {
    await db.collection('settings').doc('systemConfig').set({ isActive: req.body.status === 'true' }, { merge: true });
    res.redirect('/admin');
});
app.post('/admin/save-page', checkAuth, async (req, res) => {
    await db.collection('pages').add({ name: req.body.name, pageId: req.body.pageId, token: req.body.token });
    res.redirect('/admin');
});
app.post('/admin/delete-page', checkAuth, async (req, res) => {
    await db.collection('pages').doc(req.body.id).delete();
    res.redirect('/admin');
});
app.post('/admin/save-rules', checkAuth, async (req, res) => {
    await db.collection('settings').doc('generalRules').set({ content: req.body.generalRules });
    res.redirect('/admin');
});
app.post('/admin/save-product', checkAuth, async (req, res) => {
    const { id, ...data } = req.body;
    if (id) await db.collection('products').doc(id).update(data);
    else await db.collection('products').add(data);
    res.redirect('/admin');
});
app.post('/admin/delete-product', checkAuth, async (req, res) => {
    await db.collection('products').doc(req.body.id).delete();
    res.redirect('/admin');
});

// =================================================================
// PHẦN B: BOT ENGINE (CƠ CHẾ AI ĐỘNG)
// =================================================================

// Helper: Lấy Gemini Model Động (Từ DB hoặc ENV)
async function getGeminiModel() {
    let apiKey = DEFAULT_GEMINI_KEY;
    let modelName = "gemini-2.0-flash";

    // Check DB xem có config riêng không
    try {
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        if (aiDoc.exists) {
            const data = aiDoc.data();
            if (data.apiKey && data.apiKey.length > 10) apiKey = data.apiKey;
            if (data.modelName) modelName = data.modelName;
        }
    } catch (e) { console.error("Lỗi đọc AI Config:", e); }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        return genAI.getGenerativeModel({ model: modelName });
    } catch (e) {
        console.error("Lỗi Khởi tạo Gemini:", e);
        return null;
    }
}

// Helper: Lấy Access Token
async function getPageToken(pageId) {
    let pageSnap = await db.collection('pages').where('pageId', '==', pageId).get();
    if (!pageSnap.empty) return pageSnap.docs[0].data().token;

    // Fallback ENV
    const map = new Map();
    if (process.env.PAGE_ID_THAO_KOREA) map.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    if (process.env.PAGE_ID_TRANG_MOI) map.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    return map.get(pageId);
}

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    let body = req.body;
    if (body.object === 'page' && body.entry) {
        body.entry.forEach(async (entry) => {
            const pageId = entry.id;
            if (fs.existsSync('PAUSE_MODE')) return;

            let configDoc = await db.collection('settings').doc('systemConfig').get();
            if (configDoc.exists && !configDoc.data().isActive) return;

            if (entry.messaging && entry.messaging.length > 0) {
                const webhook_event = entry.messaging[0];
                
                // ADMIN COMMANDS
                if (webhook_event.message && webhook_event.message.is_echo) {
                    if (webhook_event.message.metadata === "FROM_BOT_AUTO") return;
                    const adminText = webhook_event.message.text;
                    const uid = `${pageId}_${webhook_event.recipient.id}`;
                    if (adminText) {
                        const lower = adminText.toLowerCase().trim();
                        if (lower === '.' || lower === '!tatbot') await setBotStatus(uid, true);
                        if (lower === ',' || lower === '!batbot') await setBotStatus(uid, false);
                        await saveHistory(uid, 'Shop', adminText);
                    }
                    return;
                }

                // USER MESSAGE
                if (webhook_event.message) {
                    const senderId = webhook_event.sender.id;
                    const uid = `${pageId}_${senderId}`;
                    if (webhook_event.message.sticker_id) return;

                    const userState = await loadState(uid);
                    if (userState.is_paused) {
                        await saveHistory(uid, 'Khách', webhook_event.message.text || "[Media]");
                        return;
                    }

                    if (isMissedCall(webhook_event)) {
                        await handleMissedCall(pageId, senderId);
                        return;
                    }

                    let userMessage = webhook_event.message.text || "[Khách gửi hình ảnh]";
                    let imageUrl = null;
                    if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                        imageUrl = webhook_event.message.attachments[0].payload.url;
                    } else if (webhook_event.message.text) userMessage = webhook_event.message.text;

                    if (userMessage) await processMessage(pageId, senderId, userMessage, imageUrl, userState);
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

        if (userMessage.toLowerCase().includes("hủy đơn") || userMessage.toLowerCase().includes("bom hàng")) {
            sendAlertEmail(userName, userMessage);
        }

        let knowledgeBase = await buildKnowledgeBaseFromDB();
        let geminiResult = await callGeminiRetail(userMessage, userName, userState.history, knowledgeBase, imageUrl);

        console.log(`[Bot Reply]: ${geminiResult.response_message}`);
        await saveHistory(uid, 'Khách', userMessage);
        await saveHistory(uid, 'Bot', geminiResult.response_message);

        if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 5) {
            let imgs = geminiResult.image_url_to_send.split(',');
            for (let img of imgs) if(img.trim().startsWith('http')) await sendImage(token, senderId, img.trim());
        }

        let msgs = geminiResult.response_message.split('|');
        await sendTyping(token, senderId, false);
        for (let msg of msgs) {
            if (msg.trim()) {
                await sendTyping(token, senderId, true);
                await new Promise(r => setTimeout(r, 1000));
                await sendMessage(token, senderId, msg.trim());
            }
        }
    } catch (e) { console.error("Lỗi:", e); } 
    finally { processingUserSet.delete(uid); }
}

async function buildKnowledgeBaseFromDB() {
    let rulesDoc = await db.collection('settings').doc('generalRules').get();
    let rules = rulesDoc.exists ? rulesDoc.data().content : getDefaultRules();
    let productsSnap = await db.collection('products').get();
    let productText = "\n=== 🛒 DANH SÁCH SẢN PHẨM & QUÀ TẶNG ===\n";
    if (productsSnap.empty) {
        getDefaultProducts().forEach(p => productText += `- ${p.name} | Giá: ${p.price} | Quà: ${p.gift} | Info: ${p.desc}\n`);
    } else {
        productsSnap.forEach(doc => {
            let p = doc.data();
            productText += `- Tên: ${p.name}\n  + Giá: ${p.price}\n  + Quà Tặng: ${p.gift}\n  + Thông tin: ${p.desc}\n  + Ảnh (URL): "${p.image}"\n`;
        });
    }
    return rules + "\n" + productText;
}

// --- HÀM GỌI GEMINI (DÙNG MODEL ĐỘNG) ---
async function callGeminiRetail(userMessage, userName, history, knowledgeBase, imageUrl = null) {
    // 1. Lấy Model mới nhất mỗi lần gọi
    const model = await getGeminiModel();
    if (!model) return { response_message: "Dạ hệ thống đang bảo trì một chút, Bác chờ xíu nha." };

    try {
        const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');
        const greetingName = userName ? "Bác " + userName : "Bác";
        const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
        const timeContext = (now.getHours() >= 8 && now.getHours() < 17) ? "GIỜ HÀNH CHÍNH" : "NGOÀI GIỜ";

        let prompt = `**VAI TRÒ:** Bạn là chuyên viên tư vấn Shop Thảo Korea. Khách hàng: '${greetingName}'.

**DỮ LIỆU SHOP:**
${knowledgeBase}

**NGỮ CẢNH:**
- Giờ: ${timeContext}
- Nếu khách gửi ảnh lạ -> Báo chờ kiểm tra kho.

**LỊCH SỬ:**
${historyText}

**INPUT:** "${userMessage}"
${imageUrl ? "[Khách gửi ảnh]" : ""}

**QUY ĐỊNH OUTPUT (BẮT BUỘC):**
1. **response_message:** Chỉ chứa text tư vấn. **KHÔNG** chứa link (https://...).
2. **image_url_to_send:** Link ảnh (nếu cần).

**JSON:** { "response_message": "...", "image_url_to_send": "" }`;

        let parts = [{ text: prompt }];
        if (imageUrl) {
            let imgData = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            parts.push({ inlineData: { data: Buffer.from(imgData.data).toString('base64'), mimeType: "image/jpeg" }});
        }

        let result = await model.generateContent(parts);
        let jsonStr = result.response.text().match(/\{[\s\S]*\}/)[0];
        return JSON.parse(jsonStr);
    } catch (e) { 
        console.error("Gemini Error:", e);
        return { response_message: "Dạ Bác chờ Shop xíu nha.", image_url_to_send: "" }; 
    }
}

// --- HELPER FUNCTIONS ---
function getDefaultRules() { return `**LUẬT CẤM:** CẤM bịa giá. CẤM tự tặng quà thêm.\n**CHỐT ĐƠN:** Xin SĐT và Địa chỉ.\n**SHIP:** SP Chính Freeship. Dầu lẻ 20k.`; }
function getDefaultProducts() { return [{ name: "An Cung Samsung", price: "780k", gift: "Tặng 1 Dầu", image: "", desc: "Freeship" }]; }

async function setBotStatus(uid, status) { try { await db.collection('users').doc(uid).set({ is_paused: status }, { merge: true }); } catch(e){} }
async function loadState(uid) { try { let d = await db.collection('users').doc(uid).get(); return d.exists ? d.data() : { history: [], is_paused: false }; } catch(e){ return { history: [], is_paused: false }; } }
async function saveHistory(uid, role, content) { try { await db.collection('users').doc(uid).set({ history: admin.firestore.FieldValue.arrayUnion({ role, content }), last_updated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch(e){} }
function isMissedCall(event) { return (event.message.text && event.message.text.toLowerCase().includes("bỏ lỡ cuộc gọi")) || (event.message.attachments && event.message.attachments[0].type === 'fallback'); }
async function handleMissedCall(pageId, senderId) { const token = await getPageToken(pageId); if(token) await sendMessage(token, senderId, "Dạ Shop thấy Bác gọi nhỡ. Bác cần gấp vui lòng gọi Hotline 0986.646.845 ạ!"); }
async function sendAlertEmail(name, msg) { try { await transporter.sendMail({ from: 'vngenmart@gmail.com', to: 'vngenmart@gmail.com', subject: `KHÁCH ${name} HỦY ĐƠN`, text: msg }); } catch(e){} }

async function sendTyping(token, id, status) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, sender_action: status ? "typing_on" : "typing_off" }); } catch(e){} }
async function sendMessage(token, id, text) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { text, metadata: "FROM_BOT_AUTO" } }); } catch(e){} }
async function sendImage(token, id, url) { try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { attachment: { type: "image", payload: { url, is_reusable: true } }, metadata: "FROM_BOT_AUTO" } }); } catch(e){} }
async function getFacebookUserName(token, id) { try { const res = await axios.get(`https://graph.facebook.com/${id}?fields=first_name,last_name&access_token=${token}`); return res.data ? res.data.last_name : "Bác"; } catch(e){ return "Bác"; } }

app.listen(PORT, () => console.log(`🚀 Bot v14.0 (AI Custom) chạy tại port ${PORT}`));