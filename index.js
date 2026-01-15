// File: index.js (FULL VERSION v18.0 - SMART INVENTORY & GIFT MANAGER)

// =================================================================
// 1. KHAI BÁO THƯ VIỆN & CẤU HÌNH
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

// 👇👇👇 LINK APPS SCRIPT CỦA BÁC 👇👇👇
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
app.use(session({ secret: 'bot-v18-inventory', resave: false, saveUninitialized: true, cookie: { maxAge: 3600000 } }));

// =================================================================
// PHẦN A: WEB ADMIN ROUTES
// =================================================================
function checkAuth(req, res, next) { if (req.session.loggedIn) next(); else res.redirect('/login'); }
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) { req.session.loggedIn = true; res.redirect('/admin'); }
    else res.send('<h3>Sai mật khẩu! <a href="/login">Thử lại</a></h3>');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/admin', checkAuth, async (req, res) => {
    try {
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        let aiConfig = aiDoc.exists ? aiDoc.data() : { apiKey: '', modelName: 'gemini-2.0-flash' };
        
        let configDoc = await db.collection('settings').doc('systemConfig').get();
        let systemStatus = configDoc.exists ? configDoc.data().isActive : true;
        
        // Lấy cấu hình Quà Tặng
        let giftDoc = await db.collection('settings').doc('giftConfig').get();
        let giftConfig = giftDoc.exists ? giftDoc.data() : { dauLanh: true, caoDan: true, keoSam: true };

        let rulesDoc = await db.collection('settings').doc('generalRules').get();
        let generalRules = rulesDoc.exists ? rulesDoc.data().content : "Luật chung...";
        
        let pagesSnap = await db.collection('pages').get();
        let pages = []; pagesSnap.forEach(doc => pages.push({ id: doc.id, ...doc.data() }));
        
        let productsSnap = await db.collection('products').get();
        let products = [];
        if (!productsSnap.empty) productsSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        
        res.render('admin', { systemStatus, generalRules, pages, products, aiConfig, giftConfig });
    } catch (e) { res.send("Lỗi: " + e.message); }
});

app.post('/admin/save-ai', checkAuth, async (req, res) => { await db.collection('settings').doc('aiConfig').set({ apiKey: req.body.apiKey.trim(), modelName: req.body.modelName }, { merge: true }); res.redirect('/admin'); });
app.post('/admin/toggle-system', checkAuth, async (req, res) => { await db.collection('settings').doc('systemConfig').set({ isActive: req.body.status === 'true' }, { merge: true }); res.redirect('/admin'); });
app.post('/admin/save-page', checkAuth, async (req, res) => { await db.collection('pages').add({ name: req.body.name, pageId: req.body.pageId, token: req.body.token }); res.redirect('/admin'); });
app.post('/admin/delete-page', checkAuth, async (req, res) => { await db.collection('pages').doc(req.body.id).delete(); res.redirect('/admin'); });
app.post('/admin/save-rules', checkAuth, async (req, res) => { await db.collection('settings').doc('generalRules').set({ content: req.body.generalRules }); res.redirect('/admin'); });

// --- LƯU TRẠNG THÁI QUÀ TẶNG ---
app.post('/admin/save-gifts', checkAuth, async (req, res) => {
    let config = {
        dauLanh: req.body.dauLanh === 'true',
        caoDan: req.body.caoDan === 'true',
        keoSam: req.body.keoSam === 'true'
    };
    await db.collection('settings').doc('giftConfig').set(config, { merge: true });
    res.redirect('/admin');
});

// --- LƯU SẢN PHẨM (KÈM TRẠNG THÁI KHO) ---
app.post('/admin/save-product', checkAuth, async (req, res) => { 
    const { id, inStock, ...data } = req.body; 
    // Chuyển string 'true'/'false' thành boolean
    data.inStock = (inStock === 'true');
    
    if (id) await db.collection('products').doc(id).update(data); 
    else await db.collection('products').add(data); 
    res.redirect('/admin'); 
});
app.post('/admin/delete-product', checkAuth, async (req, res) => { await db.collection('products').doc(req.body.id).delete(); res.redirect('/admin'); });

// =================================================================
// PHẦN B: BOT ENGINE
// =================================================================

async function getPageToken(pageId) {
    let pageSnap = await db.collection('pages').where('pageId', '==', pageId).get();
    if (!pageSnap.empty) return pageSnap.docs[0].data().token;
    const map = new Map();
    if (process.env.PAGE_ID_THAO_KOREA) map.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    if (process.env.PAGE_ID_TRANG_MOI) map.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    map.set("833294496542063", "EAAP9uXbATjwBQG27LFeffPcNh2cZCjRebBML7ZAHcMGEvu5ZBws5Xq5BdP6F2qVauF5O1UZAKjch5KVHIb4YsDXQiC7hEeJpsn0btLApL58ohSU8iBmcwXUgEprH55hikpj8sw16QAgKbUzYQxny0vZAWb0lM9SvwQ5SH0k6sTpCHD6J7dbtihUJMsZAEWG0NoHzlyzNDAsROHr8xxycL0g5O4DwZDZD");
    return map.get(pageId);
}

async function getGeminiModel() {
    let apiKey = process.env.GEMINI_API_KEY;
    let modelName = "gemini-2.0-flash";
    try {
        let aiDoc = await db.collection('settings').doc('aiConfig').get();
        if (aiDoc.exists) {
            const data = aiDoc.data();
            if (data.apiKey && data.apiKey.length > 10) apiKey = data.apiKey;
            if (data.modelName) modelName = data.modelName;
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        return genAI.getGenerativeModel({ model: modelName });
    } catch (e) { return null; }
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
                        if (att.type === 'image') {
                            imageUrl = att.payload.url;
                            if (!userMessage) userMessage = "[Khách gửi ảnh]";
                        } else if (att.type === 'sticker' || webhook_event.message.sticker_id) {
                            if (att.payload) imageUrl = att.payload.url;
                            if (!userMessage) userMessage = "[Khách gửi Sticker]";
                        }
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
        if (userMessage.toLowerCase().includes("hủy đơn") || userMessage.toLowerCase().includes("bom hàng")) {
            sendAlertEmail(userName, userMessage);
        }

        const phoneRegex = /0\d{9}/; 
        const cleanMsg = userMessage.replace(/\s+/g, '').replace(/\./g, '').replace(/-/g, '');
        const hasPhone = phoneRegex.test(cleanMsg);

        if (hasPhone) {
            const matchedPhone = cleanMsg.match(phoneRegex)[0];
            let recentHistory = userState.history.slice(-10);
            let historyText = recentHistory.map(h => `[${h.role}]: ${h.content}`).join('\n');
            let fullConversation = `... (Lược bỏ tin cũ) ...\n${historyText}\n----------------\n[KHÁCH CHỐT]: ${userMessage}`;
            sendPhoneToSheet(matchedPhone, userName, fullConversation);
        }

        let knowledgeBase = await buildKnowledgeBaseFromDB();
        let geminiResult = await callGeminiRetail(userMessage, userName, userState.history, knowledgeBase, imageUrl, hasPhone);

        console.log(`[Bot Reply]: ${geminiResult.response_message}`);
        await saveHistory(uid, 'Khách', userMessage);
        await saveHistory(uid, 'Bot', geminiResult.response_message);

        let cleanTextMessage = geminiResult.response_message.replace(/(https?:\/\/[^\s]+)/g, "").trim();

        if (geminiResult.video_url_to_send && geminiResult.video_url_to_send.length > 5) {
            let vids = geminiResult.video_url_to_send.split(',');
            for (let vid of vids) {
                let cleanVid = vid.trim();
                if (cleanVid.endsWith('.mp4') || cleanVid.includes('.mp4?')) {
                     await sendVideo(token, senderId, cleanVid);
                } else if (cleanVid.startsWith('http')) {
                    await sendMessage(token, senderId, `📺 Dạ mời Bác xem video chi tiết tại đây ạ: ${cleanVid}`);
                }
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
    } catch (e) { console.error("Lỗi:", e); } 
    finally { processingUserSet.delete(uid); }
}

async function sendPhoneToSheet(phone, name, message) {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("xxxxxxxxx")) return;
    try {
        let res = await axios.post(APPS_SCRIPT_URL, {
            secret: APPS_SCRIPT_SECRET,
            phone: phone,
            name: name,      
            message: message 
        });
    } catch (e) { console.error("[SHEET ERROR]", e.message); }
}

async function buildKnowledgeBaseFromDB() {
    let rulesDoc = await db.collection('settings').doc('generalRules').get();
    let rules = rulesDoc.exists ? rulesDoc.data().content : "Luật chung...";
    let productsSnap = await db.collection('products').get();
    
    // --- 1. LẤY TRẠNG THÁI QUÀ TẶNG TỪ DB ---
    let giftDoc = await db.collection('settings').doc('giftConfig').get();
    let giftConfig = giftDoc.exists ? giftDoc.data() : { dauLanh: true, caoDan: true, keoSam: true };
    
    // Tạo danh sách quà CÒN HÀNG
    let activeGifts = [];
    if (giftConfig.dauLanh) activeGifts.push("Dầu Lạnh");
    if (giftConfig.caoDan) activeGifts.push("Cao Dán");
    if (giftConfig.keoSam) activeGifts.push("Kẹo Sâm");
    
    let giftString = activeGifts.length > 0 ? activeGifts.join(" HOẶC ") : "Hiện tại đã hết quà tặng";

    // --- 2. LẤY DANH SÁCH SẢN PHẨM & TRẠNG THÁI ---
    let productFull = "";
    let productSummary = "DANH SÁCH RÚT GỌN:\n";
    
    if (productsSnap.empty) { productFull = "Chưa có SP"; } else {
        productsSnap.forEach(doc => {
            let p = doc.data();
            let cleanDesc = p.desc;
            if (p.name.toLowerCase().includes("kwangdong")) {
                cleanDesc = cleanDesc.replace(/15%/g, "").replace(/15 phần trăm/g, ""); 
                cleanDesc += " (Thành phần: Có chứa trầm hương tự nhiên)"; 
            }
            
            // LOGIC KHO HÀNG: Nếu inStock = false -> Ghi chú rõ
            let stockStatus = (p.inStock === false) ? " (❌ TẠM HẾT HÀNG - HÃY TƯ VẤN SANG LOẠI KHÁC)" : " (✅ CÒN HÀNG)";
            let nameWithStock = p.name + stockStatus;

            productFull += `- Tên: ${nameWithStock}\n  + Giá CHUẨN: ${p.price}\n  + Quà Tặng: ${p.gift}\n  + Thông tin: ${cleanDesc}\n  + Ảnh (URL): "${p.image}"\n`;
            
            let priceVal = parseInt(p.price.replace(/\D/g, '')) || 0;
            let isMainProduct = priceVal >= 500 || p.name.includes("An Cung") || p.name.includes("Thông Đỏ") || p.name.includes("Nghệ") || p.name.includes("Hắc Sâm");
            if (isMainProduct) productSummary += `- ${nameWithStock}: ${p.price}\n`;
        });
    }
    
    // Trả về Prompt đã được nhúng trạng thái Quà & Hàng
    return `=== LUẬT CHUNG ===\n${rules}\n\n=== TÌNH TRẠNG QUÀ TẶNG HIỆN TẠI ===\nChỉ được tặng: ${giftString}.\nNếu khách đòi quà đã hết (ví dụ Dầu Nóng hoặc món đã tắt), hãy bảo là hết hàng và mời chọn ${giftString}.\n\n=== DANH SÁCH SẢN PHẨM ===\n${productFull}\n=== DATA RÚT GỌN ===\n${productSummary}`;
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

**DỮ LIỆU KHO & QUÀ TẶNG:**
${knowledgeBase}

**NHIỆM VỤ THÔNG MINH (AI):**
1. **Kiểm tra tồn kho:** Nếu khách hỏi sản phẩm có ghi "(❌ TẠM HẾT HÀNG)", hãy khéo léo nói: "Dạ mẫu này bên em vừa hết hàng ạ, Bác tham khảo sang mẫu [Gợi ý món khác tương tự] dùng cũng tốt lắm ạ...".
2. **Quà tặng:** Chỉ được mời chào những món quà có trong danh sách "TÌNH TRẠNG QUÀ TẶNG HIỆN TẠI". Tuyệt đối không hứa tặng món đã hết.
3. **AI Vision (Nhìn ảnh):**
   - Ảnh SP: Tư vấn, báo giá.
   - Ảnh Sticker/Vui vẻ: Cười "Hihi" hoặc xã giao.
   - Ảnh SP Lạ: Lái về hàng mình bán.

**QUY TẮC KHÁC:**
- CẤM Tặng Dầu Nóng Antiphlamine (Luôn từ chối khéo).
- Video: Hỏi check Samsung -> Gửi "${VIDEO_CHECK_SAMSUNG}". Hỏi Kwangdong -> Gửi "${VIDEO_INTRO_KWANGDONG}".
- SĐT: ${hasPhone ? "ĐÃ CÓ (XÁC NHẬN)" : "CHƯA CÓ"}.

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

app.listen(PORT, () => console.log(`🚀 Bot v18.0 (Inventory Manager) chạy tại port ${PORT}`));