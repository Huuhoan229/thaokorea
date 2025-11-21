// File: index.js (Phiên bản "ĐA NHÂN CÁCH v2.50" - Bot Đọc Được Tin Nhắn Của Chủ Shop)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// ----- BỘ CHỐNG LẶP (XỬ LÝ SONG SONG) -----
const processingUserSet = new Set();
// ---------------------------------------------

// 2. KHỞI TẠO BỘ NHỚ (FIRESTORE)
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

// 3. Khởi tạo các biến
const app = express();
app.use(express.json());

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
if (process.env.PAGE_ID_MAY_TINH && process.env.FB_PAGE_TOKEN_MAY_TINH) {
    pageTokenMap.set(process.env.PAGE_ID_MAY_TINH, process.env.FB_PAGE_TOKEN_MAY_TINH);
}
console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Khuyên dùng 2.0 flash cho nhanh và khôn hơn
    console.log("Đã kết nối với Gemini API.");
} catch(error) {
    console.error("LỖI KHI KHỞI TẠO GEMINI:", error);
    process.exit(1);
}

// -------------------------------------------------------------------
// Endpoint 1: Xác thực Webhook
// -------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// -------------------------------------------------------------------
// Endpoint 2: Nhận tin nhắn (ĐÃ SỬA LOGIC ĐỌC TIN CỦA CHỦ SHOP)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach(async (entry) => { // Thêm async
      const pageId = entry.id; 

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === [PHẦN QUAN TRỌNG MỚI SỬA] XỬ LÝ ECHO (TIN NHẮN TỪ PAGE) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            // Kiểm tra xem tin này có phải do Bot tự gửi không (thông qua metadata)
            const metadata = webhook_event.message.metadata;
            
            if (metadata === "FROM_BOT_AUTO") {
                // Đây là tin bot gửi -> Bỏ qua vì hàm processMessage đã lưu rồi
                return;
            } else {
                // KHÔNG CÓ metadata -> Đây là CHỦ SHOP (ADMIN) chat tay
                const adminText = webhook_event.message.text;
                const recipientID = webhook_event.recipient.id; // ID khách hàng (vì Page gửi cho Khách)
                
                if (adminText && recipientID) {
                    console.log(`[ADMIN CHAT TAY]: "${adminText}" -> Đang lưu vào bộ nhớ...`);
                    // Gọi hàm lưu tin nhắn của Admin
                    await saveAdminReply(pageId, recipientID, adminText);
                }
                return;
            }
        }
        // ==============================================================

        const sender_psid = webhook_event.sender.id; // ID Khách hàng

        let userMessage = null;
        if (webhook_event.message && webhook_event.message.text) {
            userMessage = webhook_event.message.text;
        } else if (webhook_event.message && webhook_event.message.quick_reply) {
            userMessage = webhook_event.message.quick_reply.payload;
        }

        if (userMessage && sender_psid) {
          processMessage(pageId, sender_psid, userMessage);
        }
      }
    });
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM LƯU TIN NHẮN CỦA ADMIN CHAT TAY (MỚI)
// -------------------------------------------------------------------
async function saveAdminReply(pageId, customerId, text) {
    if (!db) return;
    // ID lưu trữ phải khớp logic: PAGEID_CUSTOMERID
    const uniqueStorageId = `${pageId}_${customerId}`; 
    const userRef = db.collection('users').doc(uniqueStorageId);

    try {
        // Lưu với role là 'bot' (hoặc 'model') để Gemini hiểu đây là lời của Shop
        await userRef.set({
            history: admin.firestore.FieldValue.arrayUnion({ 
                role: 'model', // Gemini coi đây là lời nói của AI/Shop
                content: text 
            }),
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`-> Đã lưu tin nhắn Admin vào lịch sử chat của khách ${customerId}`);
    } catch (error) {
        console.error("Lỗi khi lưu tin nhắn Admin:", error);
    }
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ CHÍNH
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    
    if (processingUserSet.has(uniqueStorageId)) {
        console.log(`[CHỐNG LẶP]: Đang xử lý cho ${uniqueStorageId}. Bỏ qua.`);
        return;
    }
    processingUserSet.add(uniqueStorageId);

    try {
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      const userState = await loadState(uniqueStorageId);
      
      // *** KIỂM TRA QUAN TRỌNG ***
      // Nếu tin nhắn cuối cùng trong lịch sử là của 'model' (tức là Admin vừa chat tay xong),
      // Thì Bot cần biết điều đó để không trả lời lặp hoặc trả lời sai ý.
      
      let productKnowledge;
      let geminiResult;

      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge);
      } else if (pageId === process.env.PAGE_ID_MAY_TINH) {
          productKnowledge = getProductKnowledge_MayTinh();
          geminiResult = await callGemini_MayTinh(userMessage, userName, userState, productKnowledge);
      } else {
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      console.log(`[Gemini Response]: ${geminiResult.response_message}`);
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      // Lưu tin nhắn người dùng và tin bot trả lời
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      // Gửi ảnh (nếu có)
      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, geminiResult.image_url_to_send);
          } catch (imgError) {}
      }
      
      // Gửi text (Tách câu)
      const messages = geminiResult.response_message.split('|');
      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i].trim();
          if (msg) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              const typingTime = 1000 + (msg.length / 20 * 500); // Gõ nhanh hơn chút
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
              
              await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, msg);
          }
      }

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ Shop đang kiểm tra lại đơn, Bác/Bạn chờ xíu nhé.");
    } finally {
      processingUserSet.delete(uniqueStorageId);
    }
}

// ... (Giữ nguyên các hàm getProductKnowledge_ThaoKorea và getProductKnowledge_MayTinh) ...
// BẠN HÃY GIỮ NGUYÊN CÁC KHỐI KIẾN THỨC CŨ CỦA BẠN Ở ĐÂY
function getProductKnowledge_ThaoKorea() {
    // ... (Code cũ của bạn) ...
    // Để tiết kiệm không gian tôi không paste lại phần text dài dòng này
    // Logic vẫn như cũ
    return `**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**
    - Nếu khách hỏi 'mát gan', 'giải độc gan': Tư vấn Nước Mát Gan Đông Trùng Nghệ Samsung (390k).
    - Nếu khách hỏi 'nhung hươu': Tư vấn Nước Hồng Sâm Nhung Hươu (Hộp 30 gói 420k).
    - Nếu khách hỏi 'an cung': Phân loại Samsung (780k), Kwangdong (1290k), Royal (690k).
    ... (Phần còn lại giữ nguyên như file cũ) ...`;
}

function getProductKnowledge_MayTinh() {
    // ... (Code cũ của bạn) ...
    return `**KHỐI KIẾN THỨC SẢN PHẨM (ĐỒ CHƠI MÁY TÍNH):**
    ... (Giữ nguyên như file cũ) ...`;
}
// ........................................................................


// -------------------------------------------------------------------
// QUẢN LÝ BỘ NHỚ (Giữ nguyên)
// -------------------------------------------------------------------
async function loadState(uniqueStorageId) {
  if (!db) return { history: [] };
  const userRef = db.collection('users').doc(uniqueStorageId);
  try {
      const doc = await userRef.get();
      if (!doc.exists) return { history: [] };
      const data = doc.data();
      return { history: data.history ? data.history.slice(-15) : [] }; // Tăng lên 15 tin để nhớ dai hơn
  } catch (error) {
      return { history: [] };
  }
}

async function saveState(uniqueStorageId, userMessage, botMessage) {
  if (!db) return;
  const userRef = db.collection('users').doc(uniqueStorageId);
  const newUserMsg = { role: 'user', content: userMessage };
  const shouldSaveBotMsg = botMessage && !botMessage.includes("chưa trực tuyến");
  // Bot lưu tin nhắn của nó với role 'model'
  const historyUpdates = shouldSaveBotMsg ? [newUserMsg, { role: 'model', content: botMessage }] : [newUserMsg];

  try {
      await userRef.set({
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (error) {
      console.error("Lỗi saveState:", error);
  }
}

// -------------------------------------------------------------------
// GỌI GEMINI (THẢO KOREA) - CẬP NHẬT PROMPT ĐỂ HIỂU LỊCH SỬ
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  
  try {
    // History bây giờ đã chứa cả tin nhắn Admin chat tay (role: model)
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";
    
    // ... (Lấy giờ VN giữ nguyên) ...
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const currentHour = new Date(utc + (3600000 * 7)).getHours();

    let prompt = `Bạn là chủ Shop Thảo Korea. Khách hàng là "${userName}".
**NHIỆM VỤ QUAN TRỌNG:**
1. Đọc kỹ "Lịch sử chat" bên dưới.
2. Nếu thấy "Shop" (tức là Admin) vừa nói gì (ví dụ: tư vấn Mát Gan), bạn PHẢI NƯƠNG THEO ĐÓ mà nói tiếp. KHÔNG ĐƯỢC quay lại tư vấn sản phẩm khác nếu Shop đã chốt vấn đề.
3. Nếu Shop đã chốt giá/quà khác với quy định, hãy nghe theo Shop.

${productKnowledge}

**Lịch sử chat (Cực kỳ quan trọng - Hãy xem Shop vừa nói gì):**
${historyString || "(Chưa có lịch sử)"}

**Khách hàng vừa nhắn:** "${userMessage}"

**Yêu cầu trả lời:**
- Trả về JSON: { "response_message": "...", "image_url_to_send": "..." }
- Ngắn gọn, tách câu bằng dấu |
`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const geminiJson = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ Bác chờ xíu ạ." };

    return {
        response_message: geminiJson.response_message || "Dạ.",
        image_url_to_send: geminiJson.image_url_to_send || ""
    };

  } catch (error) {
    console.error("Lỗi Gemini Thao Korea:", error);
    return { response_message: "Dạ Shop đang kiểm tra, Bác chờ lát nhé.", image_url_to_send: "" };
  }
}

// -------------------------------------------------------------------
// GỌI GEMINI (MÁY TÍNH)
// -------------------------------------------------------------------
async function callGemini_MayTinh(userMessage, userName, userState, productKnowledge) {
    // Logic tương tự Thao Korea, chỉ khác Prompt
    if (!model) return { response_message: "..." };
    try {
        const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
        
        let prompt = `Bạn là nhân viên Shop Đồ Chơi Máy Tính. Khách là ${userName || 'bạn'}.
**LƯU Ý QUAN TRỌNG:** Đọc "Lịch sử chat". Nếu thấy "Shop" (Admin) đã tư vấn gì thì phải nói tiếp theo ý đó. Đừng tư vấn lại từ đầu.

${productKnowledge}

**Lịch sử chat:**
${historyString}

**Khách vừa nhắn:** "${userMessage}"

**Trả về JSON:** { "response_message": "...", "image_url_to_send": "..." }
`;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        const geminiJson = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Ok chờ tí." };

        return {
            response_message: geminiJson.response_message || "Ok.",
            image_url_to_send: geminiJson.image_url_to_send || ""
        };
    } catch (e) { return { response_message: "Lỗi tí, chờ xíu nhé.", image_url_to_send: "" }; }
}

// -------------------------------------------------------------------
// HÀM LẤY TÊN (Giữ nguyên)
// -------------------------------------------------------------------
async function getFacebookUserName(FB_PAGE_TOKEN, sender_psid) {
  if (!sender_psid) return null;
  try {
    const response = await axios.get(`https://graph.facebook.com/${sender_psid}?fields=first_name,last_name&access_token=${FB_PAGE_TOKEN}`);
    return response.data ? (response.data.first_name + ' ' + response.data.last_name) : null;
  } catch (e) { return null; }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN - [ĐÃ SỬA: THÊM METADATA]
// -------------------------------------------------------------------
async function sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, responseText) {
  if (!sender_psid || !responseText) return;
  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": {
        "text": responseText,
        "metadata": "FROM_BOT_AUTO" // <--- QUAN TRỌNG: Đánh dấu tin này là của Bot
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body);
  } catch (error) { console.error("Lỗi gửi tin:", error.message); }
}

// -------------------------------------------------------------------
// HÀM GỬI ẢNH - [ĐÃ SỬA: THÊM METADATA]
// -------------------------------------------------------------------
async function sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl) {
  if (!sender_psid || !imageUrl) return;
  const safeImageUrl = imageUrl.replace(/&amp;/g, '&');
  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": {
      "attachment": {
        "type": "image",
        "payload": { "url": safeImageUrl, "is_reusable": true }
      },
      "metadata": "FROM_BOT_AUTO" // <--- QUAN TRỌNG
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body);
  } catch (error) { throw new Error("Lỗi ảnh"); }
}

// Hàm Typing (Giữ nguyên)
async function sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, isTyping) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
        "recipient": { "id": sender_psid },
        "sender_action": isTyping ? "typing_on" : "typing_off"
    });
  } catch (e) {}
}

// 5. Khởi động
app.listen(PORT, () => {
  console.log(`Bot AI v2.50 (Đã fix Bot đọc được tin Admin) đang chạy cổng ${PORT}`);
});