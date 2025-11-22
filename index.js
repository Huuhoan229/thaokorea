// File: index.js (Phiên bản "SINGLE PERSONA v2.95" - Fix Lặp Vô Tri + Mặc Định Samsung)

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

// ----- BỘ MAP TOKEN (CHỈ CÒN THẢO KOREA & TRANG MỚI) -----
const pageTokenMap = new Map();
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    console.log(`Đã tải Token cho trang Thao Korea: ${process.env.PAGE_ID_THAO_KOREA}`);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    console.log(`Đã tải Token cho trang Trang Moi: ${process.env.PAGE_ID_TRANG_MOI}`);
}

console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    // Dùng flash 2.0 cho thông minh và nhanh hơn
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    console.log("Đã kết nối với Gemini API (Model: gemini-2.0-flash).");
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
// Endpoint 2: Nhận tin nhắn (Logic Đọc Tin Admin)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach(async (entry) => {
      const pageId = entry.id;

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === XỬ LÝ ECHO (TIN NHẮN TỪ PAGE/ADMIN) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") {
                return; // Bot tự nói -> Bỏ qua
            } else {
                // Admin chat tay -> Lưu lại
                const adminText = webhook_event.message.text;
                const recipientID = webhook_event.recipient.id;
                if (adminText && recipientID) {
                    console.log(`[ADMIN CHAT TAY]: "${adminText}" -> Lưu.`);
                    await saveAdminReply(pageId, recipientID, adminText);
                }
                return;
            }
        }
        // ============================================

        const sender_psid = webhook_event.sender.id;
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
// HÀM XỬ LÝ CHÍNH
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    
    if (processingUserSet.has(uniqueStorageId)) {
        console.log(`[CHỐNG LẶP]: Bỏ qua tin nhắn dồn dập từ ${uniqueStorageId}`);
        return;
    }
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

      // === GỬI ẢNH (Logic tách nhiều ảnh bằng dấu phẩy) ===
      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          // Tách chuỗi bằng dấu phẩy
          const imageUrls = geminiResult.image_url_to_send.split(',').map(url => url.trim()).filter(url => url.length > 0);
          
          for (const imgUrl of imageUrls) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(resolve => setTimeout(resolve, 500));
              try {
                await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imgUrl);
              } catch (imgError) {
                 console.error("Lỗi gửi ảnh:", imgError.message);
              }
          }
      }
      
      // === GỬI TEXT (Tách câu) ===
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
    
    // --- SẢN PHẨM CHÍNH (MẶC ĐỊNH) ---
    knowledgeString += "---[SẢN PHẨM CHỦ ĐẠO - MẶC ĐỊNH]---\n";
    knowledgeString += "1. AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN (780.000đ)\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n";
    knowledgeString += "Đặc điểm: Hộp gỗ màu nâu. Chứa 1% trầm hương. Giúp bổ não, ổn định huyết áp, phòng ngừa tai biến. Đây là loại phổ biến nhất.\n";
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
    knowledgeString += "Đặc điểm: Hộp màu đen/xám. 15% trầm hương (cao cấp nhất). Dùng cho người đã bị tai biến hoặc muốn loại tốt nhất.\n";

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
      return doc.exists ? { history: doc.data().history ? doc.data().history.slice(-15) : [] } : { history: [] };
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
// HÀM GỌI GEMINI [UPDATE LOGIC MỚI: MẶC ĐỊNH SAMSUNG + FIX LẶP]
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const currentHour = new Date(utc + (3600000 * 7)).getHours();

    // --- PROMPT MỚI ---
    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn của Shop Thảo Korea. Xưng hô 'Shop' và gọi khách là '${greetingName}'.
    
**LUẬT CẤM (TUÂN THỦ TUYỆT ĐỐI):**
1. KHÔNG dùng từ 'Admin', 'Bot'. Gọi người trả lời trước đó là 'Shop'.
2. KHÔNG gửi link trong text (chỉ gửi text).
3. **KHÔNG LẶP LẠI:** Nếu trong lịch sử chat, Shop vừa nói "Shop đã nhận thông tin..." thì tuyệt đối không nói lại câu đó nữa.

**LUẬT SẢN PHẨM (MẶC ĐỊNH SAMSUNG):**
- Nếu khách hỏi chung chung "An Cung", "thuốc chống đột quỵ", "loại hộp gỗ"... -> **Tư vấn NGAY vào An Cung Samsung (780k)**.
- Không cần hỏi ngược lại "Bác muốn loại nào". Cứ giới thiệu Samsung trước.
- Chỉ khi khách chê đắt hoặc hỏi loại tốt hơn thì mới giới thiệu Royal (690k) hoặc Kwangdong (1290k).

**LUẬT GIỜ GIẤC (Hiện tại là ${currentHour} giờ):**
- Nếu là giờ hành chính (8h-17h): Tư vấn và chốt đơn bình thường.
- **NẾU LÀ NGOÀI GIỜ (17h-8h sáng hôm sau):**
  - **Trường hợp A (Khách CHỈ HỎI/TƯ VẤN):**
    -> Trả lời câu hỏi của khách một cách nhiệt tình.
    -> Kết thúc bằng câu: *"Bác cần tư vấn kỹ hơn thì cứ để lại SĐT mai con gọi tư vấn cho Bác nhé!"*.
    -> **CẤM** nói "Shop đã nhận thông tin" ở trường hợp này.
  - **Trường hợp B (Khách ĐÃ CHỐT ĐƠN hoặc ĐÃ GỬI SĐT):**
    -> Lúc này mới nói: *"Dạ Shop đã nhận đủ thông tin. Giờ muộn rồi, sáng mai nhân viên Shop sẽ ưu tiên gọi lại xác nhận đơn cho Bác sớm nhất ạ!"*.

${productKnowledge}

**Lịch sử chat:**
${historyString || "(Chưa có)"}

**Khách nhắn:** "${userMessage}"

**Yêu cầu JSON:**
{
  "response_message": "Câu trả lời text | tách ý bằng dấu |",
  "image_url_to_send": "link1, link2" (Nếu cần gửi ảnh, cách nhau bằng dấu phẩy)
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
  console.log(`Bot v2.95 (Fix Vô Tri + Mặc Định Samsung) chạy tại port ${PORT}`);
});