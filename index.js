// File: index.js (Phiên bản "MULTI-BOT v11.0" - Web Admin Dashboard + AI Vision)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

// ----- CẤU HÌNH ADMIN WEB -----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // Mật khẩu vào web

// ----- CẤU HÌNH EMAIL -----
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'vngenmart@gmail.com', 
        pass: 'mat_khau_ung_dung_cua_ban' 
    }
});

// ----- BỘ CHỐNG LẶP -----
const processingUserSet = new Set();

// 2. KHỞI TẠO FIRESTORE
let db;
try {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Đã kết nối với Bộ nhớ Firestore.");
} catch (error) {
    console.error("LỖI KHI KẾT NỐI FIRESTORE:", error);
    process.exit(1);
}

// 3. Khởi tạo server & Web View
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Để đọc dữ liệu form
app.set('view engine', 'ejs'); // Cài đặt EJS
app.set('views', path.join(__dirname, 'views'));

// Cấu hình Session đăng nhập
app.use(session({
    secret: 'secret-key-bot-admin',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 tiếng
}));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ----- BỘ MAP TOKEN -----
const pageTokenMap = new Map();
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}
const PAGE_ID_TUYEN_SI = "833294496542063";
const TOKEN_TUYEN_SI = "EAAP9uXbATjwBQG27LFeffPcNh2cZCjRebBML7ZAHcMGEvu5ZBws5Xq5BdP6F2qVauF5O1UZAKjch5KVHIb4YsDXQiC7hEeJpsn0btLApL58ohSU8iBmcwXUgEprH55hikpj8sw16QAgKbUzYQxny0vZAWb0lM9SvwQ5SH0k6sTpCHD6J7dbtihUJMsZAEWG0NoHzlyzNDAsROHr8xxycL0g5O4DwZDZD";
pageTokenMap.set(PAGE_ID_TUYEN_SI, TOKEN_TUYEN_SI);

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
} catch(error) { console.error("Lỗi Gemini:", error); }

// =================================================================
// PHẦN 1: WEB ADMIN INTERFACE (GIAO DIỆN QUẢN LÝ)
// =================================================================

// Middleware kiểm tra đăng nhập
function checkAuth(req, res, next) {
    if (req.session.loggedIn) { next(); } else { res.redirect('/login'); }
}

// Trang Đăng nhập
app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.redirect('/admin');
    } else {
        res.send('<h3>Sai mật khẩu! <a href="/login">Thử lại</a></h3>');
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Trang Admin Dashboard
app.get('/admin', checkAuth, async (req, res) => {
    try {
        // Lấy cấu hình từ Firestore
        const doc = await db.collection('settings').doc('botConfig').get();
        let promptData = "";
        
        if (doc.exists) {
            promptData = doc.data().prompt;
        } else {
            // Nếu chưa có trong DB, lấy dữ liệu mặc định (v10.5) lưu vào DB
            promptData = getDefaultKnowledge();
            await db.collection('settings').doc('botConfig').set({ prompt: promptData });
        }
        
        res.render('admin', { promptData: promptData });
    } catch (e) {
        res.send("Lỗi tải dữ liệu: " + e.message);
    }
});

// Lưu cấu hình
app.post('/admin/save', checkAuth, async (req, res) => {
    const newPrompt = req.body.promptData;
    await db.collection('settings').doc('botConfig').set({ prompt: newPrompt }, { merge: true });
    res.redirect('/admin');
});


// =================================================================
// PHẦN 2: WEBHOOK & BOT LOGIC
// =================================================================

app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else { res.sendStatus(403); }
});

app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED');
    body.entry.forEach(async (entry) => {
      const pageId = entry.id;
      if (fs.existsSync('PAUSE_MODE')) return;

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // ADMIN ECHO
        if (webhook_event.message && webhook_event.message.is_echo) {
            if (webhook_event.message.metadata === "FROM_BOT_AUTO") return;
            const adminText = webhook_event.message.text;
            const recipientID = webhook_event.recipient.id; 
            if (adminText && recipientID) {
                const lowerText = adminText.trim().toLowerCase();
                if (lowerText === '.' || lowerText === '!tatbot') await setBotStatus(pageId, recipientID, true);
                else if (lowerText === ',' || lowerText === '!batbot') await setBotStatus(pageId, recipientID, false);
                await saveAdminReply(pageId, recipientID, adminText);
            }
            return;
        }
        
        // USER MESSAGE
        if (webhook_event.message) {
            const sender_psid = webhook_event.sender.id;
            if (webhook_event.message.sticker_id) return;
            
            const userState = await loadState(`${pageId}_${sender_psid}`);
            if (userState.is_paused) {
                await saveState(`${pageId}_${sender_psid}`, webhook_event.message.text || "[Media]", null);
                return;
            }

            // Gọi nhỡ
            if (isMissedCallEvent(webhook_event)) {
                await handleMissedCall(pageId, sender_psid);
                return;
            }

            let userMessage = "";
            let imageUrl = null;
            if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                userMessage = "[Khách gửi hình ảnh]";
                imageUrl = webhook_event.message.attachments[0].payload.url;
            } else if (webhook_event.message.text) {
                userMessage = webhook_event.message.text;
            }

            if (userMessage) {
                processMessage(pageId, sender_psid, userMessage, imageUrl);
            }
        }
      }
    });
  } else { res.sendStatus(404); }
});

// -------------------------------------------------------------------
// XỬ LÝ CHÍNH
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage, imageUrl = null) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    if (processingUserSet.has(uniqueStorageId)) return;
    processingUserSet.add(uniqueStorageId);

    try {
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      const userState = await loadState(uniqueStorageId);

      // Check Hủy Đơn
      if (userMessage.toLowerCase().includes("hủy đơn") || userMessage.toLowerCase().includes("bom hàng")) {
          sendAlertEmail(userName, userMessage);
          // ... logic giữ chân ...
      }

      let geminiResult;
      
      // LẤY DỮ LIỆU TỪ DATABASE
      let productKnowledge = "";
      if (pageId === PAGE_ID_TUYEN_SI) {
          productKnowledge = "**KHỐI KIẾN THỨC (TUYỂN SỈ):** Mục tiêu: Xin SĐT Zalo. Không báo giá.";
          geminiResult = await callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge);
      } else {
          // Lấy kiến thức bán lẻ từ DB
          const doc = await db.collection('settings').doc('botConfig').get();
          if (doc.exists) {
              productKnowledge = doc.data().prompt;
          } else {
              productKnowledge = getDefaultKnowledge(); // Fallback nếu DB trống
          }
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge, imageUrl);
      }

      console.log(`[Gemini]: ${geminiResult.response_message}`);
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      // Gửi Ảnh
      if (geminiResult.image_url_to_send) {
          const imgs = geminiResult.image_url_to_send.split(',');
          for (const img of imgs) {
              if (img.trim()) await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, img.trim());
          }
      }
      
      // Gửi Text
      const msgs = geminiResult.response_message.split('|');
      for (const msg of msgs) {
          if (msg.trim()) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(r => setTimeout(r, 1000));
              await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, msg.trim());
          }
      }

    } catch (error) {
      console.error("Lỗi:", error);
    } finally {
      processingUserSet.delete(uniqueStorageId);
    }
}

// -------------------------------------------------------------------
// HÀM GEMINI (SỬ DỤNG KNOWLEDGE ĐỘNG TỪ DB)
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge, imageUrl = null) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const timeContext = (now.getHours() >= 8 && now.getHours() < 17) ? "GIỜ HÀNH CHÍNH" : "NGOÀI GIỜ";

    // PROMPT KẾT HỢP DỮ LIỆU TỪ WEB ADMIN
    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn Shop Thảo Korea. Gọi khách là '${greetingName}'.
    
**DỮ LIỆU SẢN PHẨM & LUẬT LỆ (QUAN TRỌNG - TUÂN THỦ 100%):**
${productKnowledge}

**NGỮ CẢNH:** ${timeContext}

**Lịch sử chat:**
${historyString}

**Khách nhắn:** "${userMessage}"
${imageUrl ? "[Khách gửi ảnh]" : ""}

**Yêu cầu JSON:** { "response_message": "...", "image_url_to_send": "" }`;

    let parts = [{ text: prompt }];
    if (imageUrl) {
        try {
            const imageResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            parts.push({ inlineData: { data: Buffer.from(imageResp.data).toString('base64'), mimeType: "image/jpeg" } });
        } catch (e) {}
    }

    const result = await model.generateContent(parts);
    const text = result.response.text();
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ mạng lag, Bác chờ xíu ạ.", image_url_to_send: "" }; }
}

// ... (Giữ nguyên các hàm Tuyển Sỉ, LoadState, SaveState, SendMessage...)
async function callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge) {
    // ... Copy nội dung cũ ...
    if (!model) return { response_message: "..." };
    let prompt = `Nhiệm vụ: Trợ lý tuyển sỉ.\n${productKnowledge}\nKhách: "${userMessage}"\nJSON: { "response_message": "...", "image_url_to_send": "" }`;
    const result = await model.generateContent(prompt);
    const json = JSON.parse(result.response.text().match(/\{[\s\S]*\}/)[0]);
    return json;
}

// ... (Các hàm hỗ trợ không đổi: loadState, saveState, sendFacebookMessage, v.v...)
async function loadState(uniqueStorageId) { 
  if (!db) return { history: [], is_paused: false }; 
  try {
      const doc = await db.collection('users').doc(uniqueStorageId).get();
      if (doc.exists) {
          const data = doc.data();
          return { history: data.history ? data.history.slice(-20) : [], is_paused: data.is_paused || false };
      }
      return { history: [], is_paused: false };
  } catch (error) { return { history: [], is_paused: false }; }
}

async function saveState(uniqueStorageId, userMessage, botMessage) { 
  if (!db) return;
  const newUserMsg = { role: 'user', content: userMessage };
  const historyUpdates = botMessage ? [newUserMsg, { role: 'model', content: botMessage }] : [newUserMsg];
  try {
      await db.collection('users').doc(uniqueStorageId).set({
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (e) {}
}

async function saveAdminReply(pageId, customerId, text) {
    if (!db) return;
    try {
        await db.collection('users').doc(`${pageId}_${customerId}`).set({
            history: admin.firestore.FieldValue.arrayUnion({ role: 'model', content: text }),
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
}

async function getFacebookUserName(FB_PAGE_TOKEN, sender_psid) { 
  try {
    const res = await axios.get(`https://graph.facebook.com/${sender_psid}?fields=first_name,last_name&access_token=${FB_PAGE_TOKEN}`);
    return res.data ? (res.data.first_name + ' ' + res.data.last_name) : null;
  } catch (e) { return null; }
}

async function sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, responseText) { 
  if (!sender_psid || !responseText) return;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
        "recipient": { "id": sender_psid },
        "messaging_type": "RESPONSE",
        "message": { "text": responseText, "metadata": "FROM_BOT_AUTO" }
    });
  } catch (e) {}
}

async function sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl) {
  if (!sender_psid || !imageUrl) return;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
        "recipient": { "id": sender_psid },
        "messaging_type": "RESPONSE",
        "message": {
            "attachment": { "type": "image", "payload": { "url": imageUrl.replace(/&amp;/g, '&'), "is_reusable": true } },
            "metadata": "FROM_BOT_AUTO"
        }
    });
  } catch (e) {}
}

async function sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, isTyping) { 
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
        "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off"
    });
  } catch (e) {}
}

function isMissedCallEvent(webhook_event) {
    if (webhook_event.message.text) {
        const textLower = webhook_event.message.text.toLowerCase();
        if (textLower.includes("bỏ lỡ cuộc gọi") || textLower.includes("missed call") || textLower.includes("gọi lại")) return true;
    }
    if (webhook_event.message.attachments) {
        const att = webhook_event.message.attachments[0];
        if (att.type === 'fallback' || att.type === 'call') return true;
    }
    return false;
}

// -------------------------------------------------------------------
// DỮ LIỆU MẶC ĐỊNH (Sẽ được nạp vào DB lần đầu tiên)
// -------------------------------------------------------------------
function getDefaultKnowledge() {
    return `
**LUẬT CẤM (TUÂN THỦ TUYỆT ĐỐI):**
1. CẤM dùng từ 'Admin', 'Bot'.
2. CẤM tự bịa số liệu.
3. CẤM TẶNG THÊM QUÀ nếu khách xin.

**QUY TRÌNH CHỐT ĐƠN (CHECK SĐT):**
- Bước 1: Soi tin nhắn khách xem có Số Điện Thoại (SĐT) chưa.
- Bước 2: **Chưa có SĐT:** Hỏi xin "Dạ vâng, Bác ưng mã này rồi thì cho Shop xin **Số Điện Thoại** và **Địa Chỉ** để nhân viên lên đơn Freeship cho Bác nhé ạ!".
- Bước 3: **Đã có SĐT:** Xác nhận đã nhận số và báo nhân viên gọi lại (Giờ HC hoặc Ngoài giờ).

**LUẬT SHIP:** - SP Chính: FREESHIP.
- Dầu Nóng/Lạnh mua lẻ: Ship 20k.

**CHÍNH SÁCH SẢN PHẨM & QUÀ TẶNG:**
1. AN CUNG SAMSUNG (780k) - Freeship - Tặng 1 Dầu/Cao. (Date 10/2027).
2. KWANGDONG (1.290k) - Tặng 1 Dầu/Cao. (15% Trầm).
3. THÔNG ĐỎ (1.150k) - Tặng 1 Cao/Dầu.
4. HẮC SÂM (690k) - Tặng 1 Cao Dán.
5. NGHỆ NANO (990k) - Tặng 1 Kẹo Sâm.
6. CAO SÂM 365, SÂM NƯỚC, MÁT GAN, ROYAL...: **KHÔNG QUÀ**.

**LUẬT XỬ LÝ ẢNH (VISION):**
- Nếu khách gửi ảnh hàng lạ -> Báo chờ kiểm tra kho. Không tư vấn bừa.
`;
}

// 5. Khởi động
app.listen(PORT, () => {
  console.log(`Bot v11.0 (Web Admin) chạy tại port ${PORT}`);
});