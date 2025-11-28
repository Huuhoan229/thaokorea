// File: index.js (Phiên bản "MULTI-BOT v6.5" - Fix Loi Ngu Canh Gui Anh + Tinh Dau Thong)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');

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

// 3. Khởi tạo server
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ----- BỘ MAP TOKEN -----
const pageTokenMap = new Map();

// 1. Page Thảo Korea
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}

// 2. Page Tuyển Sỉ
const PAGE_ID_TUYEN_SI = "833294496542063";
const TOKEN_TUYEN_SI = "EAAP9uXbATjwBQG27LFeffPcNh2cZCjRebBML7ZAHcMGEvu5ZBws5Xq5BdP6F2qVauF5O1UZAKjch5KVHIb4YsDXQiC7hEeJpsn0btLApL58ohSU8iBmcwXUgEprH55hikpj8sw16QAgKbUzYQxny0vZAWb0lM9SvwQ5SH0k6sTpCHD6J7dbtihUJMsZAEWG0NoHzlyzNDAsROHr8xxycL0g5O4DwZDZD";
pageTokenMap.set(PAGE_ID_TUYEN_SI, TOKEN_TUYEN_SI);

console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
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
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// -------------------------------------------------------------------
// Endpoint 2: Nhận tin nhắn
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach(async (entry) => {
      const pageId = entry.id;

      // Global Pause
      if (fs.existsSync('PAUSE_MODE')) return;

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === 1. XỬ LÝ TIN ADMIN (ECHO) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") return; 
            
            const adminText = webhook_event.message.text;
            const recipientID = webhook_event.recipient.id; 

            if (adminText && recipientID) {
                const lowerText = adminText.trim().toLowerCase();
                if (lowerText.startsWith('.') || lowerText === 'stop' || lowerText === '!tatbot') {
                    await setBotStatus(pageId, recipientID, true); 
                    console.log(`[ADMIN] TẮT Bot ${recipientID}`);
                }
                else if (lowerText === 'auto' || lowerText === 'start' || lowerText === '.auto' || lowerText === '!batbot') {
                    await setBotStatus(pageId, recipientID, false); 
                    console.log(`[ADMIN] BẬT Bot ${recipientID}`);
                    return; 
                }
                await saveAdminReply(pageId, recipientID, adminText);
            }
            return;
        }
        
        // === 2. XỬ LÝ TIN KHÁCH HÀNG ===
        if (webhook_event.message) {
            const sender_psid = webhook_event.sender.id;

            // Lọc Sticker & Like
            if (webhook_event.message.sticker_id) return; 
            if (webhook_event.message.attachments && webhook_event.message.attachments.length > 0) {
                const att = webhook_event.message.attachments[0];
                if (att.payload && att.payload.sticker_id) return;
            }

            // Check trạng thái Bot
            const userState = await loadState(`${pageId}_${sender_psid}`);
            if (userState.is_paused) return; 

            // Xử lý gọi nhỡ
            let isMissedCall = false;
            if (webhook_event.message.text) {
                const textLower = webhook_event.message.text.toLowerCase();
                if (textLower.includes("bỏ lỡ cuộc gọi") || textLower.includes("missed call") || textLower.includes("gọi lại") || textLower.includes("nghe máy")) {
                    isMissedCall = true;
                }
            }
            if (webhook_event.message.attachments) {
                const att = webhook_event.message.attachments[0];
                if (att.type === 'fallback' || att.type === 'call') {
                    if (att.title && (att.title.toLowerCase().includes("cuộc gọi") || att.title.toLowerCase().includes("call"))) {
                        isMissedCall = true;
                    }
                }
            }

            if (isMissedCall) {
                await handleMissedCall(pageId, sender_psid);
                return; 
            }

            // Xử lý tin nhắn thường
            let userMessage = "";
            if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                userMessage = "[Khách gửi hình ảnh]";
            } else if (webhook_event.message.text) {
                userMessage = webhook_event.message.text;
            }

            if (userMessage) {
                processMessage(pageId, sender_psid, userMessage);
            }
        }
      }
    });
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM SET TRẠNG THÁI BOT
// -------------------------------------------------------------------
async function setBotStatus(pageId, customerId, isPaused) {
    if (!db) return;
    const uniqueStorageId = `${pageId}_${customerId}`;
    try {
        await db.collection('users').doc(uniqueStorageId).set({
            is_paused: isPaused, 
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ GỌI NHỠ (TÙY PAGE)
// -------------------------------------------------------------------
async function handleMissedCall(pageId, sender_psid) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;

    let message = "";
    if (pageId === PAGE_ID_TUYEN_SI) {
        message = "Dạ Kho đang bận chút ạ. Anh/Chị để lại Số Điện Thoại để Kho gọi lại tư vấn giá sỉ tốt nhất nhé ạ!";
    } else {
        message = "Dạ Shop thấy Bác vừa gọi nhỡ ạ. Hiện nhân viên đang bận đóng hàng nên chưa nghe kịp máy. Bác cần gấp vui lòng gọi Hotline: 0986.646.845 - 0948.686.946 - 0946.686.474 để được hỗ trợ ngay nhé ạ!";
    }
    
    await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, message);
    await saveState(`${pageId}_${sender_psid}`, "[Khách gọi nhỡ]", message);
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ CHÍNH
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    if (processingUserSet.has(uniqueStorageId)) return;
    processingUserSet.add(uniqueStorageId);

    try {
      const userState = await loadState(uniqueStorageId);
      if (userState.is_paused) {
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      
      let productKnowledge;
      let geminiResult;

      // === [ROUTER] ===
      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge);
      } 
      else if (pageId === PAGE_ID_TUYEN_SI) {
          productKnowledge = getProductKnowledge_TuyenSiNghe();
          geminiResult = await callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge);
      }
      else {
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      console.log(`[Gemini]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      // Gửi Ảnh
      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          const imageUrls = geminiResult.image_url_to_send.split(',').map(url => url.trim()).filter(url => url.length > 0);
          for (const imgUrl of imageUrls) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(resolve => setTimeout(resolve, 500));
              try {
                await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imgUrl);
              } catch (imgError) {}
          }
      }
      
      // Gửi Text
      const messages = geminiResult.response_message.split('|');
      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i].trim();
          if (msg) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              const typingTime = 1000 + (msg.length / 20 * 500);
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
              await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, msg);
          }
      }

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ Shop đang kiểm tra, bạn chờ xíu nhé.");
    } finally {
      processingUserSet.delete(uniqueStorageId);
    }
}

// =================================================================
// BỘ NÃO 1: THẢO KOREA (BÁN LẺ) - [DỮ LIỆU SP CHUẨN]
// =================================================================
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";
    knowledgeString += "- Shop CHỈ BÁN ONLINE. Kho Hà Đông, VP Long Biên.\n";
    knowledgeString += "- Hotline gấp: 0986.646.845 - 0948.686.946 - 0946.686.474\n";
    knowledgeString += "**QUY ĐỊNH QUÀ TẶNG:** Mua 1 hộp tặng 1 Dầu Lạnh (hoặc Cao Dán). Riêng 'Hắc Sâm' Tặng Cao Dán. 'Đạm Sâm Kana', 'Nghệ Nano', 'Sâm Nước 100 gói' -> KHÔNG CÓ QUÀ.\n\n";
    
    knowledgeString += "**QUY ĐỊNH SHIP:** Đơn < 500k: +20k Ship. Đơn >= 500k: Freeship.\n\n";

    knowledgeString += "---[DANH SÁCH SẢN PHẨM]---\n";
    knowledgeString += "1. AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN (780.000đ)\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n";
    
    knowledgeString += "2. HỘP CAO HỒNG SÂM 365 (DẠNG CAO SỆT)\n";
    knowledgeString += "   - Hộp 2 Lọ: 450.000đ (+20k ship).\n";
    knowledgeString += "   - Hộp 4 Lọ: 850.000đ (Freeship).\n";
    knowledgeString += "   - Image_URL (2 Lọ): \"https://ghshop.vn/images/upload/images/Cao-H%E1%BB%93ng-S%C3%A2m-365-H%C3%A0n-Qu%E1%BB%91c-Lo%E1%BA%A1i-2-L%E1%BB%8D.png\"\n";
    knowledgeString += "   - Image_URL (4 Lọ): \"https://thuoc365.vn/wp-content/uploads/2017/12/cao-hong-sam-4.jpg\"\n";

    knowledgeString += "3. HỘP TINH DẦU THÔNG ĐỎ KWANGDONG (1.150.000đ)\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"\n";

    knowledgeString += "13. TINH CHẤT HỒNG SÂM 365 - DẠNG NƯỚC UỐNG LIỀN (690.000đ/hộp 100 gói)\n";
    knowledgeString += "Image_URL: \"https://nhungnheng.com/uploads/shops/2024_04/555439700_24765749976387672_8906127611892730086_n.jpg\"\n";

    knowledgeString += "11. NGHỆ NANO CURCUMIN 365 CARE (990.000đ/hộp)\n";
    knowledgeString += "Image_URL: \"https://scontent.fhan15-2.fna.fbcdn.net/v/t39.30808-6/589158835_122096348745142019_9083802807600819254_n.jpg\"\n";

    knowledgeString += "16. CAO HẮC SÂM TRẦM HƯƠNG HANJEONG (690.000đ - Tặng 1 Gói Cao Dán)\n";
    knowledgeString += "Image_URL: \"https://huyenviet.com.vn/storage/products/July2025/36bECKNzZcANZO0ba11G.jpg\"\n";
    
    // (Các SP khác: Đạm Sâm Kana, Canxi, Bổ Mắt, An Cung Royal, Kwangdong... giữ nguyên)
    
    return knowledgeString;
}

async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const hour = now.getHours();
    let timeContext = (hour >= 8 && hour < 17) ? "GIỜ HÀNH CHÍNH" : "NGOÀI GIỜ";

    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn của Shop Thảo Korea. Xưng hô 'Shop' và gọi khách là '${greetingName}'.
    
**LUẬT GỬI ẢNH THÔNG MINH (QUAN TRỌNG NHẤT):**
1. Nếu khách nói: "xem mẫu", "gửi ảnh", "cho xem hình"...
   -> BẠN PHẢI **TỰ SUY LUẬN** dựa trên tin nhắn GẦN NHẤT của khách.
   -> Ví dụ:
      - Khách: "Có tinh dầu thông đỏ không?" -> Shop: "Dạ có..." -> Khách: "Xem mẫu"
      => HÀNH ĐỘNG: Gửi ngay ảnh **Tinh Dầu Thông Đỏ** (Tìm link trong Knowledge). TUYỆT ĐỐI KHÔNG HỎI LẠI "Mẫu nào?".
      
      - Khách: "Cho xem mẫu" (Ngay đầu cuộc trò chuyện hoặc sau thời gian dài)
      => Lúc này mới được hỏi: "Dạ Bác muốn xem mẫu sản phẩm nào ạ? An Cung, Sâm hay Tinh dầu thông ạ?".

2. Nếu khách nói rõ tên: "Xem mẫu tinh dầu thông" -> Gửi ngay ảnh Tinh dầu thông.

**LUẬT CẤM:**
- CẤM dùng từ 'Admin', 'Bot'. CẤM gửi link text.
- CẤM bịa quà. CẤM giảm giá.
- CẤM nói lặp "Shop đã nhận thông tin".

**LUẬT XÁC NHẬN ĐƠN HÀNG:**
- Khi khách đưa thông tin (SĐT, Địa chỉ), trích xuất và nhắc lại để khách kiểm tra.

**NGỮ CẢNH THỜI GIAN HIỆN TẠI:** ${timeContext}

${productKnowledge}

**Lịch sử chat (Hãy đọc kỹ để hiểu ngữ cảnh gửi ảnh):**
${historyString}

**Khách nhắn:** "${userMessage}"

**Yêu cầu JSON:**
{
  "response_message": "Câu trả lời text | tách ý bằng dấu |",
  "image_url_to_send": "link1, link2" (Điền link ảnh vào đây nếu khách đòi xem mẫu)
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ Bác chờ Shop xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ mạng lag, Bác chờ xíu ạ.", image_url_to_send: "" }; }
}


// =================================================================
// BỘ NÃO 2: TUYỂN SỈ NGHỆ (BÁN BUÔN)
// =================================================================
function getProductKnowledge_TuyenSiNghe() {
    let knowledgeString = "**KHỐI KIẾN THỨC (TUYỂN SỈ NGHỆ NANO):**\n\n";
    knowledgeString += "**VAI TRÒ:** Trợ lý Tuyển sỉ Tổng Kho Nghệ Nano.\n";
    knowledgeString += "**MỤC TIÊU:** Xin SĐT để kết bạn Zalo báo giá.\n";
    knowledgeString += "**CHIẾN THUẬT:** KHÔNG BÁO GIÁ SỈ TRÊN CHAT.\n";
    return knowledgeString;
}

async function callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Kho'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Anh/Chị " + userName : "Anh/Chị";

    let prompt = `**Nhiệm vụ:** Bạn là Trợ lý Tuyển sỉ Nghệ Nano. Xưng hô 'Chúng tôi/Kho' - '${greetingName}'.
**LUẬT:** KHÔNG BÁO GIÁ. Mục tiêu: Xin SĐT để Zalo.
${productKnowledge}
**Lịch sử chat:** ${historyString}
**Khách nhắn:** "${userMessage}"
**Yêu cầu JSON:** { "response_message": "...", "image_url_to_send": "" }`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ bạn chờ kho xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ hệ thống bận, bạn chờ xíu nhé.", image_url_to_send: "" }; }
}


// -------------------------------------------------------------------
// HÀM LƯU TRỮ & HELPER (DÙNG CHUNG)
// -------------------------------------------------------------------
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
  const shouldSaveBotMsg = botMessage && !botMessage.includes("nhân viên Shop chưa trực tuyến");
  const historyUpdates = shouldSaveBotMsg ? [newUserMsg, { role: 'model', content: botMessage }] : [newUserMsg];
  try {
      await db.collection('users').doc(uniqueStorageId).set({
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (e) {}
}

async function saveAdminReply(pageId, customerId, text) {
    if (!db) return;
    const uniqueStorageId = `${pageId}_${customerId}`; 
    try {
        await db.collection('users').doc(uniqueStorageId).set({
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

// 5. Khởi động
app.listen(PORT, () => {
  console.log(`Bot v6.5 (Fix Ngu Canh Gui Anh) chạy tại port ${PORT}`);
});