// File: index.js (Phiên bản "ĐA TRANG FACEBOOK" - HOÀN CHỈNH 100%)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin'); // Thư viện "bộ nhớ"

// 2. KHỞI TẠO BỘ NHỚ (FIRESTORE)
let db; 
try {
    // Code này sẽ đọc "Secret" SERVICE_ACCOUNT_KEY_JSON trên Koyeb
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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Dùng chung 1 Verify Token cho cả 2 trang

// ----- BỘ MAP TOKEN MỚI (QUAN TRỌNG) -----
// Code này sẽ đọc "Secrets" Bác tạo trên Koyeb
const pageTokenMap = new Map();

// Tải Token cho Trang 1 (Thảo Korea)
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    console.log(`Đã tải Token cho trang: ${process.env.PAGE_ID_THAO_KOREA}`);
}
// Tải Token cho Trang 2 (Trang Mới)
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    console.log(`Đã tải Token cho trang: ${process.env.PAGE_ID_TRANG_MOI}`);
}

console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);
if (pageTokenMap.size === 0) {
    console.error("LỖI: KHÔNG TÌM THẤY BẤT KỲ CẶP PAGE_ID VÀ TOKEN NÀO!");
    console.error("Bác cần tạo 'Secrets' trên Koyeb (ví dụ: PAGE_ID_THAO_KOREA, FB_PAGE_TOKEN_THAO_KOREA...)");
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
// Endpoint 2: Nhận tin nhắn từ Facebook (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    // Gửi OK ngay lập tức
    res.status(200).send('EVENT_RECEIVED');

    (async () => {
      for (const entry of body.entry) {
        const pageId = entry.id; // Lấy Page ID

        if (entry.messaging && entry.messaging.length > 0) {
          const webhook_event = entry.messaging[0]; 
          const sender_psid = webhook_event.sender.id; // ID Khách hàng

          if (webhook_event.message && webhook_event.message.is_echo) {
            continue; // Bỏ qua tin nhắn do Bot gửi
          }

          let userMessage = null;
          if (webhook_event.message && webhook_event.message.text) {
              userMessage = webhook_event.message.text;
          } else if (webhook_event.message && webhook_event.message.quick_reply) {
              userMessage = webhook_event.message.quick_reply.payload;
          }

          if (userMessage && sender_psid) {
            // Truyền PAGE ID vào hàm xử lý
            await processMessage(pageId, sender_psid, userMessage); 
          }
        } 
      } 
    })(); 

  } else {
    console.error("Payload webhook không hợp lệ:", body);
    res.sendStatus(404);
  }
});

// Hàm xử lý tin nhắn (ĐÃ NÂNG CẤP ĐA TRANG)
async function processMessage(pageId, sender_psid, userMessage) {
    // LẤY ĐÚNG TOKEN CHO TRANG NÀY
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) {
        console.error(`KHÔNG TÌM THẤY TOKEN cho Page ID: ${pageId}. Bot sẽ không trả lời.`);
        return; // Dừng lại
    }

    try {
      // TRUYỀN TOKEN VÀO CÁC HÀM CON
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      
      // TẠO ID BỘ NHỚ DUY NHẤT (Ghép Page ID + User ID)
      const uniqueStorageId = `${pageId}_${sender_psid}`;
      const userState = await loadState(uniqueStorageId); 

      // LẤY KIẾN THỨC SẢN PHẨM (Dùng chung cho cả 2 trang)
      const productKnowledge = getProductKnowledge();

      console.log(`[Page: ${pageId}] [User: ${userName || 'Khách lạ'}]: ${userMessage}`);

      // Gọi Gemini (đã bỏ state đếm giá)
      const geminiResult = await callGemini(userMessage, userName, userState, productKnowledge); 

      console.log(`[Gemini Response]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      // LƯU VÀO BỘ NHỚ VỚI ID DUY NHẤT (đã bỏ new_state)
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
    }
}


// -------------------------------------------------------------------
// HÀM: TRẢ VỀ KHỐI KIẾN THỨC SẢN PHẨM (ĐẦY ĐỦ 7 SẢN PHẨM)
// -------------------------------------------------------------------
function getProductKnowledge() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (DÙNG ĐỂ TRA CỨU):**\n\n";

    // == SẢN PHẨM 1 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối. Không dùng khi bụng đói. Giá: 780.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Giá: 450.000đ/hũ (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng cho phụ nữ có thai. Giá: 1.150.000đ/hộp (ƯU ĐÃI) + TẶNG 1 GÓI CAO DÁN 20 MIẾNG + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 420.000đ/hộp 30 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 330.000đ/hộp 20 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 6 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 390.000đ/hộp 30 chai (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 7 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung kwangdong, kwang dong, kwangdong, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Cách Dùng: Người tai biến: 1 viên/ngày. Người dự phòng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. (Tốt nhất trong dòng 60 viên). Giá: 1.290.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    return knowledgeString;
}

// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function loadState(uniqueStorageId) { // Sửa thành uniqueStorageId
  if (!db) {
      console.error("Firestore chưa được khởi tạo!");
      return { history: [] }; // Chỉ trả về lịch sử
  }
  const userRef = db.collection('users').doc(uniqueStorageId); // Dùng ID mới
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

async function saveState(uniqueStorageId, userMessage, botMessage) { // Sửa thành uniqueStorageId
  if (!db) {
      console.error("Firestore chưa được khởi tạo! Không thể lưu state.");
      return;
  }
  const userRef = db.collection('users').doc(uniqueStorageId); // Dùng ID mới
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
// HÀM GỌI GEMINI (Phiên bản "CÔNG KHAI GIÁ" - KHÔNG BỊ RÚT GỌN)
// -------------------------------------------------------------------
async function callGemini(userMessage, userName, userState, productKnowledge) {
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return {
          response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
      };
  }
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n'); // userState chỉ có history
    const greetingName = userName ? "Bác " + userName : "Bác";

    // XÂY DỰNG PROMPT BẰNG CÁCH NỐI CHUỖI
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn ĐA SẢN PHẨM. Bạn PHẢI trả lời tin nhắn của khách và tra cứu kiến thức.\n\n";

    // NẠP KIẾN THỨC (TỪ CODE)
    prompt += productKnowledge + "\n\n";

    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG được nói lặp đi lặp lại. Phải trả lời NGẮN GỌN, đúng trọng tâm. (Vẫn dùng dấu | để tách các ý/câu nếu cần).\n";
    
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn của khách: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra SĐT):** Tin nhắn có chứa SĐT hợp lệ (10 số, 09/08/07/05/03) hoặc Địa chỉ (sn, ngõ, phố...) không?\n";
    prompt += "    - **(Kiểm tra Hình Ảnh):** Tin nhắn có chứa từ khóa yêu cầu ảnh không (như: 'ảnh', 'hình', 'video', 'xem hộp', 'nắp hộp').\n";
    prompt += "    - **(Kiểm tra Giá):** Khách có hỏi giá lần này không (như 'giá', 'bao nhiêu tiền', 'giá sao')?\n";
    
    prompt += "    - **(Ưu tiên 1 - Yêu cầu Hình Ảnh):** Nếu chứa từ khóa 'Kiểm tra Hình Ảnh' -> Kích hoạt 'Luật 1: Chuyển Giao Nhân Viên (Hình Ảnh)'.\n";
    prompt += "    - **(Ưu tiên 2 - Gửi SĐT/Địa chỉ):** Nếu chứa SĐT hoặc Địa chỉ -> Kích hoạt 'Luật 2: Ghi Nhận Đơn Hàng'.\n";
    prompt += "    - **(Ưu tiên 3 - Câu hỏi mặc định SĐT):** Nếu tin nhắn GIỐNG HỆT 'Số Điện Thoại của tôi là:' -> Kích hoạt 'Luật 3: Phản hồi Câu SĐT Mặc Định'.\n";
    prompt += "    - **(Ưu tiên 4 - Câu hỏi mặc định Mua SP):** Nếu tin nhắn GIỐNG HỆT 'Tôi muốn mua sản phẩm:' HOẶC tin nhắn mơ hồ ('shop có gì'...) VÀ Lịch sử chat là (Chưa có lịch sử chat) -> Kích hoạt 'Luật 4: Hỏi Vague & Liệt Kê SP'.\n";
    prompt += "    - **(Ưu tiên 5 - Hỏi Giá):** Nếu khách 'Kiểm tra Giá' (CÓ) -> Kích hoạt 'Luật 5: Báo Giá Công Khai'.\n"; // LUẬT MỚI
    prompt += "    - **(Ưu tiên 6 - Tra cứu):** Nếu không, hãy tra cứu 'KHỐI KIẾN THỨC SẢN PHẨM'.\n";
    
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n"; // Sửa thành số 3

    prompt += "    - **Luật 1: Chuyển Giao Nhân Viên (Hình Ảnh):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop xin lỗi vì chưa kịp gửi ảnh/video cho Bác ngay ạ. | Nhân viên của Shop sẽ kiểm tra và gửi cho Bác ngay sau đây, Bác chờ Shop 1-2 phút nhé!\"\n";
    
    prompt += "    - **Luật 2: Ghi Nhận Đơn Hàng (SĐT/Địa chỉ):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop đã nhận được thông tin (SĐT/Địa chỉ) của Bác ạ. | Shop sẽ gọi điện cho Bác để xác nhận đơn hàng ngay. Cảm ơn Bác ạ!\"\n";

    prompt += "    - **Luật 3: Phản hồi Câu SĐT Mặc Định:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Bác cần Shop hỗ trợ gì ạ? | Nếu Bác muốn được tư vấn kỹ hơn qua điện thoại, Bác có thể nhập Số Điện Thoại vào đây, Shop sẽ gọi lại ngay ạ.\"\n";

    prompt += "    - **Luật 4: Hỏi Vague & Liệt Kê SP (DANH SÁCH VĂN BẢN):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | Shop có nhiều sản phẩm sức khỏe Hàn Quốc, Bác đang quan tâm cụ thể về vấn đề gì hoặc sản phẩm nào ạ? Bác có thể tham khảo một số sản phẩm sau: \n1. AN CUNG SAMSUNG (Hỗ trợ tai biến)\n2. CAO HỒNG SÂM 365 (Bồi bổ sức khỏe)\n3. TINH DẦU THÔNG ĐỎ (Hỗ trợ mỡ máu)\n4. NƯỚC SÂM NHUNG HƯƠU (30 gói)\n5. NƯỚC SÂM NHUNG HƯƠU (20 gói)\n6. NƯỚC MÁT GAN SAMSUNG (Giải độc gan)\n7. AN CUNG KWANGDONG (Tai biến cao cấp)\"\n";
    
    prompt += "    - **Luật 5: Báo Giá Công Khai (KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi khách hỏi giá)\n";
    prompt += "      - **(Hành động):** Tra cứu 'KHỐI KIẾN THỨC' để tìm [Tên SP] và [Giá SP] (bao gồm quà tặng, freeship nếu có) mà khách đang hỏi. Nếu khách không nói rõ SP, hãy báo giá 1-2 SP phổ biến (An Cung Samsung).\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP tra cứu được] hiện tại là [Giá SP tra cứu được] ạ. | [Thông tin Quà Tặng/Freeship nếu có]. | Bác có muốn Shop tư vấn thêm về cách dùng không ạ?\"\n";

    prompt += "    - **Luật Quà Tặng (KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi khách hỏi về 'quà tặng', 'khuyến mãi').\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", quà tặng bên Shop rất đa dạng ạ, tùy theo sản phẩm. | Ví dụ An Cung Samsung (780k) thì được tặng 1 lọ dầu lạnh ạ. | Bác muốn hỏi quà của sản phẩm nào ạ?\"\n";

    prompt += "    - **Luật Chung (Mặc định - KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi không dính các luật trên)\n";
    prompt += "      - **LUÔN NHỚ LUẬT CHAT:** Trả lời NGẮN GỌN, không lặp lại.\n";
    prompt += "      - **YÊU CẦU 0 (Tra cứu):** Nếu khách hỏi về công dụng, cách dùng... -> Trả lời NGẮN GỌN dựa trên 'KHỐI KIẾN THỨC SẢN PHẨM'. PHẢI NHẮC LẠI: 'Sản phẩm không phải là thuốc'.\n";
    prompt += "      - **YÊU CẦU 1 (Hỏi ngược):** Kết thúc bằng một câu hỏi gợi mở NGẮN.\n";
    prompt += "      - **YÊU CẦU 2 (KHÔNG XIN SĐT):** TUYỆT ĐỐI KHÔNG xin SĐT.\n";
    prompt += "      - Nếu tin nhắn khó hiểu (kể cả SĐT, Địa chỉ, Ảnh bị lọt):\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ. | Bác có thể nói rõ hơn Bác đang cần hỗ trợ gì không ạ?\"\n";

    prompt += "      - Luôn xưng hô \"Shop - Bác\", tông ấm áp, câu ngắn, tối đa 1 emoji.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";

    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\"\n";
    prompt += "}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n";
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "TRẢ VỀ JSON:";

    const generationConfig = {
      // temperature: 0.7,
      // maxOutputTokens: 1000,
    };

    const result = await model.generateContent(prompt, generationConfig);
    let responseText = await result.response.text();

    // "Dọn dẹp" JSON
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}') + 1;
    if (startIndex === -1 || endIndex === -1) {
        console.error("Gemini raw response:", responseText);
        throw new Error("Gemini returned invalid data (no JSON found).");
    }
    const cleanJsonString = responseText.substring(startIndex, endIndex);

    // Parse JSON
    const geminiJson = JSON.parse(cleanJsonString);
    
    // Trả về, không cần new_state
    return {
        response_message: geminiJson.response_message || "Dạ Bác chờ Shop một lát ạ.",
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini API hoặc parse JSON:", error);
    return {
      response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
    };
  }
}

// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function getFacebookUserName(FB_PAGE_TOKEN, sender_psid) { // Thêm FB_PAGE_TOKEN
  if (!sender_psid) return null;
  try {
    const url = `https://graph.facebook.com/${sender_psid}`;
    const response = await axios.get(url, {
      params: { fields: "first_name,last_name", access_token: FB_PAGE_TOKEN } // Dùng token đúng
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
async function sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, responseText) { // Thêm FB_PAGE_TOKEN
  if (!sender_psid || !responseText) return;

  let messageData = { "text": responseText };

  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": messageData
  };

  try {
    // Dùng token đúng
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body); 
    console.log(`Đã gửi: ${responseText}`);
  } catch (error) {
      console.error("Lỗi khi gửi tin nhắn Facebook:", error.response?.data?.error || error.message);
  }
}

// -------------------------------------------------------------------
// HÀM BẬT/TẮT "ĐANG GÕ..." (ĐÃ NÂNG CẤP ĐA TRANG)
// -------------------------------------------------------------------
async function sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, isTyping) { // Thêm FB_PAGE_TOKEN
  if (!sender_psid) return;
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    // Dùng token đúng
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body);
  } catch (error) {
    // Bỏ qua lỗi typing
  }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI ĐA TRANG (Multi-Page) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});