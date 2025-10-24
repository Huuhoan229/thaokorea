// File: index.js (Phiên bản "AI + BỘ NHỚ FIRESTORE")

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin'); // Thư viện "bộ nhớ"

// 2. KHỞI TẠO BỘ NHỚ (FIRESTORE)
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
console.log("Đã kết nối với Bộ nhớ Firestore.");

// 3. Khởi tạo các biến
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 4. Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// -------------------------------------------------------------------
// Endpoint 1: Xác thực Webhook (Facebook)
// -------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  // (Code xác thực webhook giữ nguyên... không thay đổi)
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
// Endpoint 2: Nhận tin nhắn từ Facebook (XỬ LÝ CHÍNH)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED'); // Gửi OK ngay lập tức

    body.entry.forEach(async (entry) => {
      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender.id; // Đây là "ID khách hàng"

      if (webhook_event.message && webhook_event.message.text) {
        const userMessage = webhook_event.message.text;
        
        try {
          // B1: Bật "..."
          await sendFacebookTyping(sender_psid, true);
          
          // B2: Lấy tên khách hàng
          let userName = await getFacebookUserName(sender_psid);
          
          // B3: TẢI TRẠNG THÁI (bộ nhớ) từ Firestore
          const userState = await loadState(sender_psid);
          
          console.log(`[User ${userName} (Giá: ${userState.price_asked_count} lần)]: ${userMessage}`);

          // B4: Gọi Gemini để lấy Câu trả lời + Trạng thái MỚI
          const geminiResult = await callGemini(userMessage, userName, userState);
          
          console.log(`[Gemini]: ${geminiResult.response_message}`);
          console.log(`[State Mới]: price_asked_count = ${geminiResult.new_state.price_asked_count}`);

          // B5: Tắt "..."
          await sendFacebookTyping(sender_psid, false);

          // B6: LƯU TRẠNG THÁI MỚI vào Firestore
          await saveState(sender_psid, geminiResult.new_state, userMessage, geminiResult.response_message);

          // B7: Tách câu và gửi
          const messages = geminiResult.response_message.split('|');
          for (const msg of messages) {
            const trimmedMsg = msg.trim();
            if (trimmedMsg) {
              await sendFacebookTyping(sender_psid, true);
              const typingTime = 2000 + (trimmedMsg.length / 20 * 1000); // 2 giây + tg gõ
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(sender_psid, false);
              await sendFacebookMessage(sender_psid, trimmedMsg);
            }
          }

        } catch (error) {
          console.error("Lỗi xử lý:", error);
          await sendFacebookMessage(sender_psid, "Dạ, Shop xin lỗi, hệ thống đang có chút bận rộn. Bác vui lòng thử lại sau ạ.");
        }
      }
    });
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE)
// -------------------------------------------------------------------
async function loadState(psid) {
  const userRef = db.collection('users').doc(psid);
  const doc = await userRef.get();
  
  if (!doc.exists) {
    // Khách mới, tạo trạng thái mặc định
    return { 
      price_asked_count: 0, 
      history: [] 
    };
  } else {
    // Khách cũ, tải trạng thái
    const data = doc.data();
    return {
      price_asked_count: data.price_asked_count || 0,
      // Lấy 5 tin nhắn gần nhất
      history: data.history ? data.history.slice(-10) : [] 
    };
  }
}

async function saveState(psid, newState, userMessage, botMessage) {
  const userRef = db.collection('users').doc(psid);
  
  // Tạo 2 object tin nhắn mới
  const newUserMsg = { role: 'user', content: userMessage };
  const newBotMsg = { role: 'bot', content: botMessage };
  
  await userRef.set({
    price_asked_count: newState.price_asked_count,
    // Thêm tin nhắn mới vào lịch sử
    history: admin.firestore.FieldValue.arrayUnion(newUserMsg, newBotMsg), 
    last_updated: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true }); // Merge = True để chỉ cập nhật, không xóa dữ liệu cũ
}


// -------------------------------------------------------------------
// HÀM GỌI GEMINI (Phiên bản SỬA LỖI "BÁC BÁC" + YÊU CẦU MỚI)
// -------------------------------------------------------------------
async function callGemini(userMessage, userName, userState) {
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    
    // ----- BẮT ĐẦU SỬA LỖI "BÁC BÁC" -----
    // Logic mới:
    // 1. Nếu `userName` có tên (ví dụ: "Si Gia Dung") -> `greetingName` = "Bác Si Gia Dung"
    // 2. Nếu `userName` là `null` (do lỗi) -> `greetingName` = "Bác"
    const greetingName = userName ? "Bác " + userName : "Bác";
    // ----- KẾT THÚC SỬA LỖI -----

    // XÂY DỰNG PROMPT BẰNG CÁCH NỐI CHUỖI (AN TOÀN)
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn. Bạn PHẢI trả lời tin nhắn của khách và CẬP NHẬT TRẠNG THÁI (state) của họ.\n\n";
    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "**Trạng thái ghi nhớ (State) của khách TRƯỚC KHI trả lời:**\n";
    prompt += "- price_asked_count: " + userState.price_asked_count + "\n\n";
    prompt += "**Luật Lệ:**\n";
    prompt += "1.  **Phân tích tin nhắn:** Tin nhắn mới của khách là \"" + userMessage + "\". Khách có hỏi giá lần này không? (Trả lời CÓ hoặc KHÔNG).\n";
    prompt += "2.  **Cập nhật State MỚI:**\n";
    prompt += "    - Nếu khách hỏi giá lần này, `new_price_asked_count` = " + userState.price_asked_count + " + 1.\n";
    prompt += "    - Nếu không, `new_price_asked_count` = " + userState.price_asked_count + ".\n";
    prompt += "3.  **Luật Trả Lời (dựa trên State MỚI):**\n";
    
    // ----- ĐÃ CẬP NHẬT TÊN CHÀO (greetingName) -----
    prompt += "    - **Luật Giá (Quan trọng nhất):**\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count >= 2`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", giá hiện tại là 790.000đ/hộp ạ. | Shop FREESHIP mọi đơn; và nếu Bác lấy từ 2 hộp Shop sẽ tặng 1 phần quà sức khỏe ạ. | Bác có muốn Shop tư vấn thêm về quà tặng không ạ?\"\n"; // (Đã thêm câu hỏi ngược)
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count == 1`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", về giá thì tuỳ ưu đãi từng đợt Bác ạ. | Bác để SĐT + giờ rảnh, shop gọi 1-2 phút giải thích cặn kẽ hơn ạ.\"\n"; // (Đây là nơi duy nhất chủ động xin SĐT)
    prompt += "    - **Luật SĐT (chỉ áp dụng nếu KHÔNG HỎI GIÁ):**\n";
    prompt += "      - Nếu tin nhắn '" + userMessage + "' chỉ chứa số, hoặc trông giống SĐT (7-11 số) -> Hiểu là khách gửi SĐT.\n";
    prompt += "      -> Trả lời: \"Dạ Shop cảm ơn " + greetingName + " ạ. | Shop sẽ gọi Bác trong ít phút nữa, hoặc Bác muốn Shop gọi vào giờ nào ạ?\"\n";
    
    // ----- ĐÃ CẬP NHẬT LUẬT CHUNG (THEO YÊU CẦU MỚI) -----
    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - (Áp dụng khi không dính Luật Giá/Luật SĐT)\n";
    prompt += "      - **YÊU CẦU 1 (Hỏi ngược):** Luôn kết thúc câu trả lời bằng một câu hỏi gợi mở. Ví dụ: 'Bác cần Shop tư vấn thêm gì không ạ?', 'Bác còn thắc mắc gì về cách dùng không ạ?', 'Bác muốn hỏi thêm về công dụng nào khác không ạ?'.\n";
    prompt += "      - **YÊU CẦU 2 (Tần suất SĐT):** TUYỆT ĐỐI KHÔNG xin SĐT trong luật này. Chỉ được xin SĐT khi dính 'Luật Giá (lần 1)'.\n";
    prompt += "      - Nếu tin nhắn khó hiểu (như 'È', 'Hả', 'Lô'):\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ. | Bác có thể nói rõ hơn Bác đang cần hỗ trợ gì không ạ?\"\n";
    prompt += "      - Nếu khách chào (như 'Alo shop'):\n";
    prompt += "        -> Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | Bác cần Shop hỗ trợ gì về An Cung Ngưu Hoàng Hoàn ạ?\"\n";
    prompt += "      - Nếu khách hỏi về 1 triệu chứng (như 'Tôi bị đau đầu'):\n";
    prompt += "        -> Trả lời: \"Dạ Shop hiểu " + greetingName + " đang bị đau đầu ạ. | Sản phẩm An Cung này hỗ trợ rất tốt cho tuần hoàn máu não, giúp giảm các triệu chứng đau đầu, chóng mặt ạ. | Bác muốn tìm hiểu thêm về cách dùng hay công dụng ạ?\"\n";
    // ----- KẾT THÚC CẬP NHẬT -----
    
    prompt += "      - Luôn xưng hô \"Shop - Bác\", tông ấm áp, câu ngắn, tối đa 1 emoji.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n";
    prompt += "  \"new_state\": {\n";
    prompt += "    \"price_asked_count\": [SỐ LẦN MỚI SAU KHI PHÂN TÍCH]\n";
    prompt += "  }\n";
    prompt += "}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n"; // Tên để log
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- State cũ: { \"price_asked_count\": " + userState.price_asked_count + " }\n\n";
    prompt += "TRẢ VỀ JSON:";

    const result = await model.generateContent(prompt);
    let responseText = await result.response.text();
    
    // "Dọn dẹp" JSON (Giữ nguyên)
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}') + 1;
    if (startIndex === -1 || endIndex === -1) {
        throw new Error("Gemini returned invalid data (no JSON found). Response: " + responseText);
    }
    const cleanJsonString = responseText.substring(startIndex, endIndex);
    
    // Parse JSON đã được "dọn dẹp"
    return JSON.parse(cleanJsonString); 
    
  } catch (error) {
    console.error("Lỗi khi gọi Gemini API hoặc parse JSON:", error);
    // Trả về một lỗi an toàn để bot không bị crash
    return {
      response_message: "Dạ, hệ thống AI đang gặp chút trục trặc, Bác chờ Shop vài phút ạ. 😥",
      new_state: userState // Trả lại state cũ
    };
  }
}

// -------------------------------------------------------------------
// CÁC HÀM CŨ (Không thay đổi nhiều)
// -------------------------------------------------------------------
async function getFacebookUserName(sender_psid) {
  try {
    const url = `https://graph.facebook.com/${sender_psid}`;
    const response = await axios.get(url, { 
      params: { 
        fields: "first_name,last_name", 
        access_token: FB_PAGE_TOKEN 
      }
    });
    
    // Kiểm tra xem có tên không, một số tài khoản bị ẩn
    if (response.data && response.data.first_name) {
      return response.data.first_name + ' ' + response.data.last_name;
    }
    // Nếu có data nhưng không có tên, trả về null
    return null; 

  } catch (error) { 
    // Nếu BỊ LỖI (do app chưa public), trả về null
    console.error("Lỗi khi lấy tên (do ở Chế độ PT), trả về null.");
    return null; 
  }
}

async function sendFacebookMessage(sender_psid, responseText) {
  // (Giữ nguyên code hàm sendFacebookMessage... )
  const request_body = { "recipient": { "id": sender_psid }, "message": { "text": responseText }};
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
    console.log(`Đã gửi: ${responseText}`);
  } catch (error) { console.error("Lỗi khi gửi tin nhắn:", error.response?.data?.error || error.message); }
}

async function sendFacebookTyping(sender_psid, isTyping) {
  // (Giữ nguyên code hàm sendFacebookTyping... )
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
  } catch (error) { /* Bỏ qua lỗi typing */ }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI CÓ BỘ NHỚ đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});