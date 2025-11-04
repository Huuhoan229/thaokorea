// File: index.js (Phiên bản "ĐA NHÂN CÁCH" - Nâng Cấp Bot Máy Tính)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin'); // Thư viện "bộ nhớ"

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

// ----- BỘ MAP TOKEN MỚI (QUAN TRỌNG) -----
const pageTokenMap = new Map();
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    console.log(`Đã tải Token cho trang Thao Korea: ${process.env.PAGE_ID_THAO_KOREA}`);
}
if (process.env.PAGE_ID_MAY_TINH && process.env.FB_PAGE_TOKEN_MAY_TINH) {
    pageTokenMap.set(process.env.PAGE_ID_MAY_TINH, process.env.FB_PAGE_TOKEN_MAY_TINH);
    console.log(`Đã tải Token cho trang May Tinh: ${process.env.PAGE_ID_MAY_TINH}`);
}
console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);
if (pageTokenMap.size === 0) {
    console.error("LỖI: KHÔNG TÌM THẤY BẤT KỲ CẶP PAGE_ID VÀ TOKEN NÀO!");
}
// -------------------------------------------

// 4. Khởi tạo Gemini
let model; 
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    console.log("Đã kết nối với Gemini API (Model: gemini-2.5-flash).");
} catch(error) {
    console.error("LỖI KHI KHỞI TẠO GEMINI:", error);
    process.exit(1);
}

// -------------------------------------------------------------------
// Endpoint 1: Xác thực Webhook (Facebook)
// -------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed. Mode:', mode, 'Token:', token);
    res.sendStatus(403);
  }
});

// -------------------------------------------------------------------
// Endpoint 2: Nhận tin nhắn từ Facebook (ĐÃ SỬA LỖI LẶP TIN NHẮN)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED'); // Gửi OK ngay

    body.entry.forEach((entry) => {
      const pageId = entry.id; // Lấy Page ID

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0]; 
        const sender_psid = webhook_event.sender.id; // ID Khách hàng

        if (webhook_event.message && webhook_event.message.is_echo) {
          return; // Bỏ qua tin nhắn do Bot gửi
        }

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
    console.error("Payload webhook không hợp lệ:", body);
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM "TỔNG ĐÀI" - PHÂN LOẠI "NHÂN CÁCH" BOT
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) {
        console.error(`KHÔNG TÌM THẤY TOKEN cho Page ID: ${pageId}. Bot sẽ không trả lời.`);
        return; 
    }
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    
    if (processingUserSet.has(uniqueStorageId)) {
        console.log(`[CHỐNG LẶP PARALLEL]: Đang xử lý tin nhắn trước cho ${uniqueStorageId}. Bỏ qua.`);
        return; 
    }
    processingUserSet.add(uniqueStorageId); // --- KHÓA USER NÀY LẠI ---

    try {
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      const userState = await loadState(uniqueStorageId); 
      
      let productKnowledge;
      let geminiResult;

      // ----- BỘ CHIA "NHÂN CÁCH" BOT -----
      if (pageId === process.env.PAGE_ID_THAO_KOREA) {
          console.log(`[Router]: Trang Thao Korea. Đang tải Bộ Não 1...`);
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge); 
      
      } else if (pageId === process.env.PAGE_ID_MAY_TINH) {
          console.log(`[Router]: Trang May Tinh. Đang tải Bộ Não 2...`);
          productKnowledge = getProductKnowledge_MayTinh();
          geminiResult = await callGemini_MayTinh(userMessage, userName, userState, productKnowledge);
      
      } else {
          console.error(`KHÔNG BIẾT PAGE ID: ${pageId}. Không có kịch bản.`);
          processingUserSet.delete(uniqueStorageId); // Mở khóa
          return; // Dừng nếu không phải 2 trang đã định nghĩa
      }
      // ----- KẾT THÚC BỘ CHIA -----


      console.log(`[Gemini Response]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message); 

      // Tách câu và gửi
      const messages = geminiResult.response_message.split('|');
      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const trimmedMsg = msg.trim();
          if (trimmedMsg) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              const typingTime = 1500 + (trimmedMsg.length / 20 * 1000);
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
              
              await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, trimmedMsg); 
          }
      }

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.");
    } finally {
      processingUserSet.delete(uniqueStorageId); 
      console.log(`[XỬ LÝ XONG]: Mở khóa cho ${uniqueStorageId}`);
    }
}


// -------------------------------------------------------------------
// BỘ NÃO 1: KIẾN THỨC SẢN PHẨM (THẢO KOREA)
// -------------------------------------------------------------------
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";

    // == SẢN PHẨM 1 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối. Không dùng khi bụng đói. Giá: 780.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Giá: 450.000đ/hũ (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC (120 VIÊN)\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, 120 viên, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Cách Dùng: Uống 1-2 viên/ngày sau bữa ăn tối 30 phút.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng cho phụ nữ có thai. Giá: 1.150.000đ/hộp 120 viên (ƯU ĐÃI) + TẶNG 1 GÓI CAO DÁN 20 MIẾNG + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 420.000đ/hộp 30 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 330.000đ/hộp 20 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 6 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 390.000đ/hộp 30 chai (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 7 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG TRẦM HƯƠNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung trầm hương, trầm hương, an cung kwangdong, kwang dong, kwangdong, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Cách Dùng: Người tai biến: 1 viên/ngày. Người dự phòng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. (Tốt nhất trong dòng 60 viên). Giá: 1.290.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    return knowledgeString;
}

// -------------------------------------------------------------------
// BỘ NÃO 2: KIẾN THỨC SẢN PHẨM (ĐỒ CHƠI MÁY TÍNH - ĐÃ NÂNG CẤP)
// -------------------------------------------------------------------
function getProductKnowledge_MayTinh() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (ĐỒ CHƠI MÁY TÍNH):**\n\n";

    // == SẢN PHẨM 1 (ĐÃ NÂNG CẤP) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: Chuột Fuhlen L102 USB - Đen\n";
    knowledgeString += "Từ Khóa: chuột, fuhlen, l102, chuột l102, chuột fuhlen, chuột quốc dân, chuột giá rẻ, chuột 119k, chuột văn phòng, chuột game\n";
    knowledgeString += "Mô Tả Chung: Chuột Fuhlen L102 (chuột quốc dân), giá siêu tốt, siêu bền. Thiết kế công thái học (Ergonomic) và đối xứng, dùng được cả tay trái/phải, ôm tay, giảm mỏi cổ tay.\n";
    knowledgeString += "Thông Số Kỹ Thuật: Cảm biến quang học (Optical) 1000 DPI (di mượt và chính xác). Nút bấm dùng switch Omron (chất lượng cao). Độ bền 10 triệu lượt nhấn. Kết nối USB cắm là dùng.\n";
    knowledgeString += "Lưu Ý / Giá: Giá 119.000đ (ƯU ĐÃI). Hàng hot cho game thủ, quán net, văn phòng.\n";
    knowledgeString += "-----------------\n\n";

    // (Bác có thể thêm RAM, VGA... vào đây nếu muốn)

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    return knowledgeString;
}


// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - (Giữ nguyên)
// -------------------------------------------------------------------
async function loadState(uniqueStorageId) { 
  if (!db) {
      console.error("Firestore chưa được khởi tạo!");
      return { history: [] }; // Chỉ trả về lịch sử
  }
  const userRef = db.collection('users').doc(uniqueStorageId);
  try {
      const doc = await userRef.get();
      if (!doc.exists) {
        return { history: [] };
      } else {
        const data = doc.data();
        return {
          history: data.history ? data.history.slice(-10) : [] // Chỉ lấy lịch sử
        };
      }
  } catch (error) {
      console.error("Lỗi khi tải state từ Firestore:", error);
      return { history: [] };
  }
}

async function saveState(uniqueStorageId, userMessage, botMessage) { 
  if (!db) {
      console.error("Firestore chưa được khởi tạo! Không thể lưu state.");
      return;
  }
  const userRef = db.collection('users').doc(uniqueStorageId); 
  const newUserMsg = { role: 'user', content: userMessage };
  const shouldSaveBotMsg = botMessage && !botMessage.includes("nhân viên Shop chưa trực tuyến");
  const historyUpdates = shouldSaveBotMsg ? [newUserMsg, { role: 'bot', content: botMessage }] : [newUserMsg];

  try {
      await userRef.set({
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (error) {
      console.error("Lỗi khi lưu state vào Firestore:", error);
  }
}

// -------------------------------------------------------------------
// HÀM GỌI GEMINI 1 (CHO TRANG THẢO KOREA)
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return { response_message: "Dạ, nhân viên Shop chưa trực tuyến..." };
  }
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    // --- PROMPT 1: KỊCH BẢN THẢO KOREA (BÁC-SHOP) ---
    // (Prompt này giữ nguyên, đã bao gồm các luật Bác cần)
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn (Trang Thảo Korea). Xưng hô 'Shop - Bác'. Bạn PHẢI trả lời tin nhắn, tra cứu kiến thức.\n\n";
    prompt += productKnowledge + "\n\n";
    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG lặp lại. Trả lời NGẮN GỌN. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - (Kiểm tra SĐT/Địa chỉ)...\n";
    prompt += "    - (Kiểm tra Hình Ảnh)...\n";
    prompt += "    - (Kiểm tra Giá)...\n";
    prompt += "    - (Ưu tiên 1 - Yêu cầu Hình Ảnh)...\n";
    prompt += "    - (Ưu tiên 2 - Gửi SĐT/Địa chỉ)...\n";
    prompt += "    - (Ưu tiên 3 - Câu hỏi mặc định SĐT)...\n";
    prompt += "    - (Ưu tiên 4 - Câu hỏi mặc định Mua SP)...\n";
    prompt += "    - (Ưu tiên 5 - Hỏi Giá)...\n";
    prompt += "    - (Ưu tiên 6 - Tra cứu)...\n";
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    prompt += "    - **Luật 1: Chuyển Giao Nhân Viên (Hình Ảnh):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop xin lỗi vì chưa kịp gửi ảnh...\"\n";
    prompt += "    - **Luật 2: Ghi Nhận Đơn Hàng (SĐT/Địa chỉ):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop đã nhận được thông tin...\"\n";
    prompt += "    - **Luật 3: Phản hồi Câu SĐT Mặc Định:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Bác cần Shop hỗ trợ gì ạ?...\"\n";
    prompt += "    - **Luật 4: Hỏi Vague & Liệt Kê SP (DANH SÁCH VĂN BẢN):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | ... \n1. AN CUNG SAMSUNG...\n(Và 6 sản phẩm khác)\n7. AN CUNG TRẦM HƯƠNG KWANGDONG...\"\n";
    prompt += "    - **Luật 5: Báo Giá Công Khai (KHÔNG XIN SĐT):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP] là [Giá SP] ạ...\"\n";
    prompt += "    - **Luật Quà Tặng (KHÔNG XIN SĐT):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", quà tặng bên Shop rất đa dạng ạ...\"\n";
    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - Nếu tin nhắn khó hiểu: -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ...\"\n";
    prompt += "      - Nếu không khó hiểu: Trả lời NGẮN GỌN dựa trên 'KHỐI KIẾN THỨC'.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "{\n\"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\"\n}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n";
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "TRẢ VỀ JSON:";
    
    // (Phần gọi Gemini và dọn dẹp JSON giữ nguyên)
    const result = await model.generateContent(prompt);
    let responseText = await result.response.text();
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}') + 1;
    if (startIndex === -1 || endIndex === -1) {
        throw new Error("Gemini returned invalid data (no JSON found).");
    }
    const cleanJsonString = responseText.substring(startIndex, endIndex);
    const geminiJson = JSON.parse(cleanJsonString);
    
    return {
        response_message: geminiJson.response_message || "Dạ Bác chờ Shop một lát ạ.",
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini (Thao Korea):", error);
    return {
      response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
    };
  }
}

// -------------------------------------------------------------------
// HÀM GỌI GEMINI 2 (CHO TRANG ĐỒ CHƠI MÁY TÍNH - ĐÃ NÂNG CẤP "CHÉM GIÓ")
// -------------------------------------------------------------------
async function callGemini_MayTinh(userMessage, userName, userState, productKnowledge) {
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return { response_message: "Shop đang bận chút, bạn chờ 1 lát nhé 😥" };
  }
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    // Xưng hô "Anh/Chị/Em"
    const greetingName = userName ? userName : "Anh/Chị"; 

    // --- PROMPT 2: KỊCH BẢN MÁY TÍNH (SHOP-ANH/CHỊ/EM) ---
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn (Trang Đồ Chơi Máy Tính). Xưng hô 'Shop - Anh/Chị/Em'. Bạn PHẢI trả lời tin nhắn, tra cứu kiến thức và 'chém gió' (tư vấn thuyết phục) để chốt đơn.\n\n";
    prompt += productKnowledge + "\n\n";
    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    
    // ----- BỘ LUẬT MỚI CHO TRANG MÁY TÍNH (NÂNG CẤP) -----
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** Trả lời NGẮN GỌN, nhiệt tình. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra SĐT/Địa chỉ):** Tin nhắn có chứa SĐT (10 số) hoặc Địa chỉ (sn, ngõ...) không?\n";
    prompt += "    - **(Kiểm tra SP Khác):** Khách có hỏi sản phẩm KHÁC (như 'RAM', 'VGA', 'CPU'...) mà KHÔNG có trong 'KHỐI KIẾN THỨC' không?\n";
    prompt += "    - **(Kiểm tra Lịch sử):** Lịch sử chat có rỗng không? " + (historyString ? "Không rỗng" : "Rỗng") + "\n";
    prompt += "    - **(Kiểm tra Đồng Ý):** Tin nhắn có phải là ('Có', 'ok', 'vâng', 'tư vấn đi', 'đúng rồi', 'thêm đi', 'hàng hot') không?\n";
    
    prompt += "    - **(Ưu tiên 1 - Gửi SĐT/Địa chỉ):** Nếu 'Kiểm tra SĐT/Địa chỉ' -> Kích hoạt 'Luật 1: Ghi Nhận Chốt Đơn'.\n";
    prompt += "    - **(Ưu tiên 2 - Hỏi SP Khác):** Nếu 'Kiểm tra SP Khác' -> Kích hoạt 'Luật 2: Xin lỗi hết hàng'.\n";
    prompt += "    - **(Ưu tiên 3 - Chào/Hỏi mơ hồ LẦN ĐẦU):** Nếu Lịch sử chat là 'Rỗng' VÀ (tin nhắn là 'Alo', 'Chào', 'Tôi muốn mua sản phẩm') -> Kích hoạt 'Luật 3: Chào Hàng (Giới thiệu Chuột)'.\n";
    prompt += "    - **(Ưu tiên 4 - Khách đồng ý / Hỏi thêm):** Nếu (Lịch sử chat 'Không rỗng' VÀ 'Kiểm tra Đồng Ý' (CÓ)) HOẶC (Khách hỏi về 'cảm biến', 'độ bền', 'click') -> Kích hoạt 'Luật 4: Tư Vấn Sâu (Chém Gió)'.\n"; // Sửa logic
    prompt += "    - **(Ưu tiên 5 - Hỏi Giá):** Nếu khách hỏi 'giá' -> Kích hoạt 'Luật 5: Báo Giá'.\n";
    prompt += "    - **(Ưu tiên 6 - Chung):** Nếu không khớp -> Kích hoạt 'Luật Chung: Khó hiểu'.\n";

    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    prompt += "    - **Luật 1: Ghi Nhận Chốt Đơn:**\n";
    prompt += "      - Trả lời: \"Dạ Shop đã nhận được thông tin. | Anh/Chị vui lòng để lại Tên + SĐT + Địa chỉ + Số lượng đầy đủ để Shop chốt đơn cho mình ngay nhé!\"\n";
    
    prompt += "    - **Luật 2: Xin lỗi hết hàng:**\n";
    prompt += "      - Trả lời: \"Dạ Shop xin lỗi Anh/Chị, hiện tại Shop chỉ có sẵn sản phẩm 'Chuột Fuhlen L102' thôi ạ. | Anh/Chị có quan tâm sản phẩm này không ạ?\"\n";

    prompt += "    - **Luật 3: Chào Hàng (Giới thiệu Chuột):**\n";
    prompt += "      - Trả lời: \"Dạ chào " + greetingName + ". Shop hiện có Chuột Fuhlen L102 giá siêu tốt 119k, bền bỉ, nhạy bén cho cả game và văn phòng ạ. | Anh/Chị có muốn Shop tư vấn thêm không ạ?\"\n";

    prompt += "    - **Luật 4: Tư Vấn Sâu (Chém Gió):**\n";
    prompt += "      - (Tư vấn thuyết phục dựa trên 'KHỐI KIẾN THỨC' mới).\n";
    prompt += "      - Trả lời: \"Dạ con này thì 'quốc dân' rồi ạ! | Nó dùng switch Omron xịn nên độ bền 10 triệu click, bao trâu bò cho Anh/Chị cày game. | Thiết kế đối xứng (tay trái/phải đều ok) lại ôm tay, dùng lâu không mỏi. | Với giá 119k thì không có đối thủ luôn ạ! Anh/Chị muốn lấy mấy con để Shop chốt đơn ạ?\"\n"; // Kịch bản chốt đơn

    prompt += "    - **Luật 5: Báo Giá:**\n";
    prompt += "      - Trả lời: \"Dạ, Chuột Fuhlen L102 (chuột quốc dân) giá chỉ 119.000đ/con ạ. | Con này dùng switch Omron 10 triệu click siêu bền. | Anh/Chị muốn lấy mấy con ạ?\"\n";
    
    prompt += "    - **Luật Chung: Khó hiểu:**\n";
    prompt += "      - Trả lời: \"Dạ Shop chưa hiểu ý " + greetingName + " lắm. | Shop hiện đang bán Chuột Fuhlen L102 giá 119k, Anh/Chị có cần tư vấn về sản phẩm này không ạ?\"\n";

    prompt += "    - Tách câu trả lời bằng dấu |\n\n";
    // ----- KẾT THÚC BỘ LUẬT MỚI -----

    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "{\n\"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\"\n}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n";
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "TRẢ VỀ JSON:";
    
    // (Phần gọi Gemini và dọn dẹp JSON giữ nguyên)
    const result = await model.generateContent(prompt);
    let responseText = await result.response.text();
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}') + 1;
    if (startIndex === -1 || endIndex === -1) {
        throw new Error("Gemini returned invalid data (no JSON found).");
    }
    const cleanJsonString = responseText.substring(startIndex, endIndex);
    const geminiJson = JSON.parse(cleanJsonString);
    
    return {
        response_message: geminiJson.response_message || "Dạ bạn chờ Shop một lát ạ.",
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini (May Tinh):", error);
    return {
      response_message: "Dạ, Shop đang bận chút, Anh/Chị chờ Shop trong giây lát nhé.",
    };
  }
}


// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function getFacebookUserName(FB_PAGE_TOKEN, sender_psid) { 
  if (!sender_psid) return null;
  try {
    const url = `https://graph.facebook.com/${sender_psid}`;
    const response = await axios.get(url, {
      params: { fields: "first_name,last_name", access_token: FB_PAGE_TOKEN } 
    });
    if (response.data && response.data.first_name) {
      return response.data.first_name + ' ' + response.data.last_name;
    }
    return null;
  } catch (error) {
    if (!error.response || (error.response.status !== 400 && !error.message.includes("permission"))) {
        // console.error("Lỗi khi lấy tên:", error.message);
    }
    return null;
  }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, responseText) { 
  if (!sender_psid || !responseText) return;
  let messageData = { "text": responseText };
  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": messageData
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body); 
    console.log(`Đã gửi: ${responseText}`);
  } catch (error) {
      console.error("Lỗi khi gửi tin nhắn Facebook:", error.response?.data?.error || error.message);
  }
}

// -------------------------------------------------------------------
// HÀM BẬT/TẮT "ĐANG GÕ..." (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, isTyping) { 
  if (!sender_psid) return;
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body);
  } catch (error) {
    // Bỏ qua lỗi typing
  }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI ĐA NHÂN CÁCH (v2) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});