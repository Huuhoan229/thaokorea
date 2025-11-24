// File: index.js (Phiên bản "SINGLE PERSONA v3.6" - Fix Triệt Để Gọi Nhỡ bằng Code Cứng)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

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
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}

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

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === 1. XỬ LÝ ECHO (TIN ADMIN) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") {
                return; 
            } else {
                const adminText = webhook_event.message.text;
                const recipientID = webhook_event.recipient.id;
                if (adminText && recipientID) {
                    console.log(`[ADMIN CHAT TAY]: "${adminText}" -> Lưu.`);
                    await saveAdminReply(pageId, recipientID, adminText);
                }
                return;
            }
        }
        
        const sender_psid = webhook_event.sender.id;
        
        // === 2. PHÂN LOẠI TIN NHẮN (LOGIC MỚI) ===
        if (webhook_event.message) {
            // A. STICKER -> BỎ QUA
            if (webhook_event.message.sticker_id) {
                console.log("Bỏ qua Sticker.");
                return; 
            }

            // B. KIỂM TRA GỌI NHỠ (QUAN TRỌNG)
            // Nếu không có text (sự kiện hệ thống) HOẶC có text chứa từ khóa gọi nhỡ
            const textLower = webhook_event.message.text ? webhook_event.message.text.toLowerCase() : "";
            const isMissedCall = !webhook_event.message.text || // Không có chữ (thường là sự kiện gọi)
                                 textLower.includes("bỏ lỡ cuộc gọi") || 
                                 textLower.includes("missed call") ||
                                 textLower.includes("gọi lại") ||
                                 textLower.includes("cuộc gọi video");

            // C. ẢNH
            const isImage = webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image';

            if (isMissedCall && !isImage) {
                // -> XỬ LÝ NGAY BẰNG CODE CỨNG (Không gọi Gemini)
                console.log("Phát hiện gọi nhỡ -> Auto Reply Hotline.");
                await handleMissedCall(pageId, sender_psid);
                return; // Dừng luôn
            }

            // D. CÁC TRƯỜNG HỢP CÒN LẠI -> GỌI GEMINI
            let userMessage = "";
            if (isImage) {
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
// HÀM XỬ LÝ GỌI NHỠ (HARD-CODE) - CHẠY NGAY LẬP TỨC
// -------------------------------------------------------------------
async function handleMissedCall(pageId, sender_psid) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;

    const message = "Dạ Shop thấy Bác vừa gọi nhỡ ạ. Hiện nhân viên đang đóng hàng nên chưa nghe kịp máy. Bác cần gấp vui lòng gọi Hotline: 0986.646.845 - 0948.686.946 - 0946.686.474 để được hỗ trợ ngay nhé ạ!";
    
    // Gửi tin nhắn ngay
    await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, message);
    
    // Lưu vào lịch sử để Bot nhớ lần sau
    await saveState(`${pageId}_${sender_psid}`, "[Khách gọi nhỡ]", message);
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ CHÍNH (CHO GEMINI)
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    
    if (processingUserSet.has(uniqueStorageId)) return;
    processingUserSet.add(uniqueStorageId);

    try {
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      const userState = await loadState(uniqueStorageId);
      
      let productKnowledge;
      let geminiResult;

      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge);
      } else {
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      console.log(`[Gemini]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      // GỬI ẢNH
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
      
      // GỬI TEXT
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
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ Shop đang kiểm tra, Bác chờ xíu nhé.");
    } finally {
      processingUserSet.delete(uniqueStorageId);
    }
}

// -------------------------------------------------------------------
// BỘ NÃO (THẢO KOREA)
// -------------------------------------------------------------------
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";
    knowledgeString += "- GIỜ LÀM VIỆC: 8h00 - 17h00 hàng ngày.\n";
    knowledgeString += "- FREESHIP: Đơn hàng từ 500.000đ trở lên.\n";
    knowledgeString += "**QUY ĐỊNH QUÀ TẶNG:** Mua 1 hộp tặng Dầu Lạnh (có thể đổi sang Cao Dán).\n\n";
    
    knowledgeString += "---[SẢN PHẨM CHỦ ĐẠO - MẶC ĐỊNH]---\n";
    knowledgeString += "1. AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN (780.000đ)\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n";
    knowledgeString += "Đặc điểm: 1% trầm hương. Hộp gỗ màu nâu. Loại phổ biến nhất.\n";
    knowledgeString += "-----------------\n\n";
    
    knowledgeString += "---[SẢN PHẨM KHÁC]---\n";
    knowledgeString += "2. HỘP CAO HỒNG SÂM 365 HÀN QUỐC (Hộp 2 lọ - 450.000đ)\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/200000494375/product/z4941235209154_120a0977cf9b70138a2330b5fee4f1db_8ddbf4c7f03244e6a24e49551e83dee2_master.jpg\"\n";

    knowledgeString += "3. HỘP TINH DẦU THÔNG ĐỎ KWANGDONG (1.150.000đ - 120 viên)\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"\n";

    knowledgeString += "4. NƯỚC HỒNG SÂM NHUNG HƯƠU 30 GÓI (420.000đ)\n";
    knowledgeString += "Image_URL: \"https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg\"\n";

    knowledgeString += "5. NƯỚC HỒNG SÂM NHUNG HƯƠU 20 GÓI (HẾT HÀNG)\n";
    
    knowledgeString += "6. NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG (390.000đ)\n";
    knowledgeString += "Image_URL: \"https://hueminhkorea.com/wp-content/uploads/2025/02/mat-gan-nghe-dong-trung-tw-han-quoc-2.jpg\"\n";

    knowledgeString += "7. AN CUNG TRẦM HƯƠNG KWANGDONG 60 VIÊN (1.290.000đ)\n";
    knowledgeString += "Image_URL: \"https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg\"\n";
    knowledgeString += "Đặc điểm: 15% trầm hương (cao cấp nhất).\n";

    knowledgeString += "8. AN CUNG ROYAL FAMILY 32 VIÊN (690.000đ)\n";
    knowledgeString += "Image_URL: \"https://ikute.vn/wp-content/uploads/2022/11/An-cung-nguu-tram-huong-hoan-Royal-Family-Chim-Hyang-Hwan-1-ikute.vn_-600x449.jpg\"\n";
    
    return knowledgeString;
}

// -------------------------------------------------------------------
// HÀM LƯU TRỮ
// -------------------------------------------------------------------
async function loadState(uniqueStorageId) { 
  if (!db) return { history: [] }; 
  try {
      const doc = await db.collection('users').doc(uniqueStorageId).get();
      return doc.exists ? { history: doc.data().history ? doc.data().history.slice(-20) : [] } : { history: [] };
  } catch (error) { return { history: [] }; }
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

// -------------------------------------------------------------------
// HÀM GỌI GEMINI
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const hour = now.getHours();
    const day = now.getDay();
    let timeContext = "";
    if (day === 0) {
        timeContext = "Hiện tại là CHỦ NHẬT (Nghỉ). Khách chốt đơn -> Hẹn sáng Thứ 2 gọi xác nhận.";
    } else {
        if (hour >= 8 && hour < 17) {
            timeContext = "Hiện tại là GIỜ HÀNH CHÍNH (8h-17h). Chốt đơn bình thường.";
        } else {
            timeContext = "Hiện tại là NGOÀI GIỜ. Khách chốt đơn -> Hẹn 8h sáng mai gọi lại.";
        }
    }

    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn của Shop Thảo Korea. Xưng hô 'Shop' - '${greetingName}'.
    
**LUẬT CẤM (TUÂN THỦ TUYỆT ĐỐI):**
1. CẤM dùng từ 'Admin', 'Bot'.
2. CẤM gửi link trong text.
3. CẤM bịa quà (Chỉ tặng Dầu Lạnh/Cao Dán). CẤM giảm giá.
4. CẤM nói lặp "Shop đã nhận thông tin".

**LUẬT RÀ SOÁT THÔNG TIN:**
- Trước khi xin SĐT/Địa chỉ, **PHẢI** đọc "Lịch sử chat". Nếu có rồi thì KHÔNG xin lại.

**LUẬT TƯ VẤN:**
- Hỏi "An Cung" -> Tư vấn **Samsung (780k)**.
- Gửi ảnh: Chỉ gửi khi khách ĐÒI.

**NGỮ CẢNH THỜI GIAN:**
${timeContext}

${productKnowledge}

**Lịch sử chat:**
${historyString || "(Chưa có)"}

**Khách nhắn:** "${userMessage}"

**Yêu cầu JSON:**
{
  "response_message": "Câu trả lời text | tách ý bằng dấu |",
  "image_url_to_send": "link1, link2" (Nếu cần gửi ảnh)
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ Bác chờ Shop xíu ạ." };
    
    return {
        response_message: json.response_message || "Dạ.",
        image_url_to_send: json.image_url_to_send || "" 
    };

  } catch (error) {
    return { response_message: "Dạ mạng đang lag, Bác chờ em xíu nha.", image_url_to_send: "" };
  }
}

// -------------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------------
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
  console.log(`Bot v3.6 (Fix Call Missed 100%) chạy tại port ${PORT}`);
});