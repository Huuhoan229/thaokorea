// File: index.js (Phiên bản "MULTI-BOT v5.0" - Them Bot Tuyen Si Nghe + Keo Zalo)

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

// ----- BỘ MAP TOKEN (CẤU HÌNH ĐA TRANG) -----
const pageTokenMap = new Map();

// 1. Page Thảo Korea (Bán lẻ)
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}

// 2. Page Tuyển Sỉ Nghệ (MỚI)
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

      // Check Global Pause
      if (fs.existsSync('PAUSE_MODE')) return;

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === 1. XỬ LÝ TIN NHẮN TỪ ADMIN (ECHO) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") {
                return; 
            } else {
                // ADMIN CHAT TAY
                const adminText = webhook_event.message.text;
                const recipientID = webhook_event.recipient.id; 

                if (adminText && recipientID) {
                    const lowerText = adminText.trim().toLowerCase();
                    
                    // Lệnh Tắt/Bật Bot
                    if (lowerText.startsWith('.') || lowerText === 'stop' || lowerText === '!tatbot') {
                        await setBotStatus(pageId, recipientID, true); // True = Pause
                        console.log(`[ADMIN] TẮT Bot với khách ${recipientID}`);
                    }
                    else if (lowerText === 'auto' || lowerText === 'start' || lowerText === '.auto' || lowerText === '!batbot') {
                        await setBotStatus(pageId, recipientID, false); // False = Active
                        console.log(`[ADMIN] BẬT Bot với khách ${recipientID}`);
                        return; 
                    }
                    
                    await saveAdminReply(pageId, recipientID, adminText);
                }
                return;
            }
        }
        
        // === 2. XỬ LÝ TIN NHẮN KHÁCH HÀNG ===
        if (webhook_event.message) {
            const sender_psid = webhook_event.sender.id;
            if (webhook_event.message.sticker_id) return; // Bỏ qua Sticker

            // Check trạng thái Bot
            const userState = await loadState(`${pageId}_${sender_psid}`);
            if (userState.is_paused) return; 

            // Xử lý gọi nhỡ (Code cứng) - Chỉ áp dụng cho Page Bán Lẻ (Thảo Korea)
            // Page Tuyển Sỉ thường ít gọi nhỡ hơn, nhưng cứ để logic chung hoặc tách ra tùy nhu cầu
            let isMissedCall = false;
            if (webhook_event.message.text) {
                const textLower = webhook_event.message.text.toLowerCase();
                if (textLower.includes("bỏ lỡ cuộc gọi") || 
                    textLower.includes("missed call") || 
                    textLower.includes("cuộc gọi video") ||
                    textLower.includes("gọi lại") ||
                    textLower.includes("nghe máy")) {
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
    } catch (e) { console.error(e); }
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ GỌI NHỠ
// -------------------------------------------------------------------
async function handleMissedCall(pageId, sender_psid) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;

    // Tùy page mà có câu Hotline khác nhau
    let message = "Dạ Shop thấy Bác vừa gọi nhỡ ạ. Hiện nhân viên đang bận nên chưa nghe kịp máy. Bác cần gấp vui lòng gọi Hotline: 0986.646.845 để được hỗ trợ ngay nhé ạ!";
    
    await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, message);
    await saveState(`${pageId}_${sender_psid}`, "[Khách gọi nhỡ]", message);
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ CHÍNH (ROUTER CHO CÁC BOT)
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

      // === [ROUTER] CHIA BOT THEO PAGE ID ===
      
      // 1. BOT THẢO KOREA (BÁN LẺ)
      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          console.log(">> Bot: Thao Korea (Retail)");
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge);
      } 
      // 2. BOT TUYỂN SỈ NGHỆ (BÁN BUÔN) - MỚI
      else if (pageId === "833294496542063") {
          console.log(">> Bot: Tuyen Si Nghe (Wholesale)");
          productKnowledge = getProductKnowledge_TuyenSiNghe();
          geminiResult = await callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge);
      }
      else {
          processingUserSet.delete(uniqueStorageId);
          return;
      }
      // ======================================

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
// BỘ NÃO 1: THẢO KOREA (BÁN LẺ - GIỮ NGUYÊN)
// =================================================================
function getProductKnowledge_ThaoKorea() {
    // (Giữ nguyên nội dung cũ của bạn)
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA - BÁN LẺ):**\n\n";
    knowledgeString += "- GIỜ LÀM VIỆC: 8h00 - 17h00 hàng ngày.\n";
    knowledgeString += "- Hotline gấp: 0986.646.845 - 0948.686.946 - 0946.686.474\n";
    knowledgeString += "**QUY ĐỊNH QUÀ TẶNG:** Mua 1 hộp tặng 1 Dầu Lạnh (hoặc Cao Dán).\n";
    knowledgeString += "**QUY ĐỊNH SHIP:** Đơn < 500k: +30k Ship. Đơn >= 500k: Freeship.\n\n";
    
    knowledgeString += "---[SẢN PHẨM CHỦ ĐẠO]---\n";
    knowledgeString += "1. AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN (780.000đ)\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n";
    knowledgeString += "-----------------\n\n";
    
    knowledgeString += "---[SẢN PHẨM KHÁC]---\n";
    knowledgeString += "2. HỘP CAO HỒNG SÂM 365 HÀN QUỐC (Mỗi lọ 240g)\n";
    knowledgeString += "   - Hộp 2 Lọ: 450.000đ (Chưa Ship).\n";
    knowledgeString += "   - Hộp 4 Lọ: 850.000đ (Freeship).\n";
    knowledgeString += "   - Image_URL (2 Lọ): \"https://ghshop.vn/images/upload/images/Cao-H%E1%BB%93ng-S%C3%A2m-365-H%C3%A0n-Qu%E1%BB%91c-Lo%E1%BA%A1i-2-L%E1%BB%8D.png\"\n";
    knowledgeString += "   - Image_URL (4 Lọ): \"https://thuoc365.vn/wp-content/uploads/2017/12/cao-hong-sam-4.jpg\"\n";

    knowledgeString += "3. HỘP TINH DẦU THÔNG ĐỎ KWANGDONG (1.150.000đ - 120 viên)\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"\n";

    knowledgeString += "4. NƯỚC HỒNG SÂM NHUNG HƯƠU 30 GÓI (420.000đ - Chưa Ship)\n";
    knowledgeString += "Image_URL: \"https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg\"\n";

    knowledgeString += "5. NƯỚC HỒNG SÂM NHUNG HƯƠU 20 GÓI (HẾT HÀNG)\n";
    
    knowledgeString += "6. NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG (390.000đ - Chưa Ship)\n";
    knowledgeString += "Image_URL: \"https://hueminhkorea.com/wp-content/uploads/2025/02/mat-gan-nghe-dong-trung-tw-han-quoc-2.jpg\"\n";

    knowledgeString += "7. AN CUNG TRẦM HƯƠNG KWANGDONG 60 VIÊN (1.290.000đ)\n";
    knowledgeString += "Image_URL: \"https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg\"\n";

    knowledgeString += "8. AN CUNG ROYAL FAMILY 32 VIÊN (690.000đ)\n";
    knowledgeString += "Image_URL: \"https://ikute.vn/wp-content/uploads/2022/11/An-cung-nguu-tram-huong-hoan-Royal-Family-Chim-Hyang-Hwan-1-ikute.vn_-600x449.jpg\"\n";
    
    knowledgeString += "9. DẦU NÓNG XOA BÓP ANTIPHLAMINE HÀN QUỐC 100ML (89.000đ)\n";
    knowledgeString += "Image_URL: \"https://wowmart.vn/wp-content/uploads/2017/03/dau-nong-xoa-diu-cac-co-xuong-khop-antiphlamine-han-quoc-221024-ka.jpg\"\n";

    knowledgeString += "10. DẦU LẠNH GLUCOSAMINE HÀN QUỐC 150ML (Sản phẩm Quà Tặng)\n";
    knowledgeString += "Image_URL: \"https://glucosamin.com.vn/storage/uploads/noidung/dau-lanh-han-quoc-glucosamine-150ml-175.jpg\"\n";
    
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

    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn của Shop Thảo Korea. Xưng hô 'Shop' - '${greetingName}'.
    
**LUẬT CẤM:**
1. CẤM dùng từ 'Admin', 'Bot'. CẤM gửi link text.
2. CẤM bịa quà. CẤM giảm giá.
3. CẤM nói lặp "Shop đã nhận thông tin".

**LUẬT RÀ SOÁT THÔNG TIN (QUAN TRỌNG):**
- Trước khi xin SĐT/Địa chỉ, **PHẢI** đọc kỹ lịch sử chat. Nếu có rồi thì **XÁC NHẬN LẠI** chứ không xin mới.

**LUẬT VẬN CHUYỂN:** Chỉ bán Online, ship Bưu cục. KHÔNG ship Grab.

**LUẬT TƯ VẤN:**
- Hỏi "An Cung" -> Tư vấn **Samsung (780k)**.
- Gửi ảnh: Chỉ gửi khi khách ĐÒI.

**NGỮ CẢNH THỜI GIAN:** ${timeContext}

${productKnowledge}

**Lịch sử chat:**
${historyString}

**Khách nhắn:** "${userMessage}"

**Yêu cầu JSON:** { "response_message": "...", "image_url_to_send": "" }`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ Bác chờ Shop xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ mạng lag, Bác chờ xíu ạ.", image_url_to_send: "" }; }
}


// =================================================================
// BỘ NÃO 2: TUYỂN SỈ NGHỆ (BÁN BUÔN - MỚI)
// =================================================================
function getProductKnowledge_TuyenSiNghe() {
    let knowledgeString = "**KHỐI KIẾN THỨC (TUYỂN SỈ NGHỆ NANO):**\n\n";
    
    knowledgeString += "**VAI TRÒ:** Bạn là Trợ lý Tuyển sỉ của Tổng Kho Nghệ Nano.\n";
    knowledgeString += "**MỤC TIÊU CỐT LÕI:** Xin Số Điện Thoại để kết bạn Zalo báo giá sỉ.\n";
    knowledgeString += "**XƯNG HÔ:** 'Chúng tôi' hoặc 'Kho' - gọi khách là 'Bạn' hoặc 'Anh/Chị'.\n\n";

    knowledgeString += "**CHIẾN THUẬT BÁO GIÁ (QUAN TRỌNG):**\n";
    knowledgeString += "- **KHÔNG BAO GIỜ** báo giá sỉ cụ thể trên Messenger (vì lộ giá thị trường).\n";
    knowledgeString += "- Nếu khách hỏi giá: 'Dạ chính sách giá sỉ bên kho phụ thuộc vào số lượng nhập ạ (càng nhiều giá càng tốt). Bạn vui lòng để lại SĐT để nhân viên kho kết bạn Zalo gửi bảng giá chi tiết cho bạn nhé!'.\n\n";

    knowledgeString += "**SẢN PHẨM:** Tinh chất nghệ Nano Curcumin 365 Care Hàn Quốc (Dạng nước).\n";
    knowledgeString += "- Quy cách: Tép 3g.\n";
    knowledgeString += "- Công dụng: Chữa đau dạ dày, làm đẹp da, bổ máu, phòng ung thư, tăng đề kháng.\n";
    knowledgeString += "- Đối tượng: Người đau dạ dày, phụ nữ sau sinh, người cần bồi bổ.\n";
    knowledgeString += "- Cách dùng: 1 tép/ngày pha với nước ấm.\n\n";

    return knowledgeString;
}

async function callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Kho'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Anh/Chị " + userName : "Anh/Chị";

    let prompt = `**Nhiệm vụ:** Bạn là Trợ lý Tuyển sỉ Nghệ Nano. Xưng hô 'Chúng tôi/Kho' - '${greetingName}'.
    
**LUẬT BẤT DI BẤT DỊCH:**
1. **KHÔNG BÁO GIÁ TRÊN CHAT:** Mục tiêu duy nhất là xin SĐT để Zalo.
2. **KHÔNG DÙNG TỪ "SHOP" hay "BÁC":** Đây là trang Bán Buôn, cần chuyên nghiệp (Doanh nghiệp B2B).
3. **CÂU CHỐT:** Luôn hướng về việc: "Để lại SĐT để nhận bảng giá sỉ tốt nhất qua Zalo".

${productKnowledge}

**Lịch sử chat:**
${historyString}

**Khách nhắn:** "${userMessage}"

**Yêu cầu JSON:** { "response_message": "...", "image_url_to_send": "" }`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ bạn chờ kho xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ hệ thống đang bận, bạn chờ xíu nhé.", image_url_to_send: "" }; }
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
          return { 
              history: data.history ? data.history.slice(-20) : [],
              is_paused: data.is_paused || false 
          };
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
  console.log(`Bot v5.0 (Multi-Bot: Retail + Wholesale) chạy tại port ${PORT}`);
});