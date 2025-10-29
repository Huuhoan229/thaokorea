// File: index.js (Phiên bản "AI + BỘ NHỚ FIRESTORE + GOOGLE SHEETS RAG")

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin'); // Thư viện "bộ nhớ"
const { google } = require('googleapis'); // Thư viện "Google Sheet"

// ----- ID CỦA GOOGLE SHEET (ĐÃ NẠP SẴN) -----
const SPREADSHEET_ID = '16IP2nf5FsHSFhaIFpp2m16FTbOcGt_RGUZPwBC_7QHw'; 
// ----------------------------------------------------

// 2. KHỞI TẠO BỘ NHỚ (FIRESTORE)
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
console.log("Đã kết nối với Bộ nhớ Firestore.");

// 3. KHỞI TẠO GOOGLE SHEETS AUTH
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], // Chỉ đọc
});
const sheetsApi = google.sheets({ version: 'v4', auth: auth });
console.log("Đã kết nối với Google Sheets API.");

// 4. Khởi tạo các biến
const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 5. Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

// 6. Bộ đệm (Cache) cho Google Sheet (Để bot chạy nhanh hơn)
let sheetCache = {
  dataString: null,
  timestamp: 0,
};

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
      let sender_psid = webhook_event.sender.id; // ID khách hàng

      if (webhook_event.message && webhook_event.message.text) {
        const userMessage = webhook_event.message.text;
        
        try {
          await sendFacebookTyping(sender_psid, true);
          let userName = await getFacebookUserName(sender_psid);
          const userState = await loadState(sender_psid);
          
          // BƯỚC MỚI: LẤY KIẾN THỨC TỪ GOOGLE SHEET (CÓ CACHE)
          const productKnowledge = await getSheetData();

          console.log(`[User ${userName || 'Khách lạ'} (Giá: ${userState.price_asked_count} lần)]: ${userMessage}`);

          // Gọi Gemini để lấy Câu trả lời + Trạng thái MỚI
          const geminiResult = await callGemini(userMessage, userName, userState, productKnowledge);
          
          console.log(`[Gemini]: ${geminiResult.response_message}`);
          console.log(`[State Mới]: price_asked_count = ${geminiResult.new_state.price_asked_count}`);

          await sendFacebookTyping(sender_psid, false);
          await saveState(sender_psid, geminiResult.new_state, userMessage, geminiResult.response_message);

          // Tách câu và gửi
          const messages = geminiResult.response_message.split('|');
          for (const msg of messages) {
            const trimmedMsg = msg.trim();
            if (trimmedMsg) {
              await sendFacebookTyping(sender_psid, true);
              const typingTime = 2000 + (trimmedMsg.length / 20 * 1000);
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(sender_psid, false);
              await sendFacebookMessage(sender_psid, trimmedMsg);
            }
          }
          
          // GỬI NÚT BẤM (NẾU CÓ)
          if (geminiResult.quick_replies && geminiResult.quick_replies.length > 0) {
            await sendFacebookQuickReplies(sender_psid, "Bác có thể chọn nhanh sản phẩm Bác quan tâm ở dưới ạ:", geminiResult.quick_replies);
          }

        } catch (error) {
          console.error("Lỗi xử lý:", error);
          await sendFacebookMessage(sender_psid, "Dạ, Shop xin lỗi, hệ thống đang có chút bận rộn. Bác vui lòng thử lại sau ạ.");
        }
      } else if (webhook_event.message && webhook_event.message.quick_reply) {
        // XỬ LÝ KHI KHÁCH BẤM NÚT
        // (Giống hệt như khách gõ chữ)
        const userMessage = webhook_event.message.quick_reply.payload; 
        
        // Chạy lại quy trình y như trên
        try {
          await sendFacebookTyping(sender_psid, true);
          let userName = await getFacebookUserName(sender_psid);
          const userState = await loadState(sender_psid);
          const productKnowledge = await getSheetData();
          console.log(`[User ${userName || 'Khách lạ'} (Bấm nút)]: ${userMessage}`);
          const geminiResult = await callGemini(userMessage, userName, userState, productKnowledge);
          console.log(`[Gemini]: ${geminiResult.response_message}`);
          console.log(`[State Mới]: price_asked_count = ${geminiResult.new_state.price_asked_count}`);
          await sendFacebookTyping(sender_psid, false);
          await saveState(sender_psid, geminiResult.new_state, userMessage, geminiResult.response_message);
          const messages = geminiResult.response_message.split('|');
          for (const msg of messages) {
            const trimmedMsg = msg.trim();
            if (trimmedMsg) {
              await sendFacebookTyping(sender_psid, true);
              const typingTime = 2000 + (trimmedMsg.length / 20 * 1000);
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(sender_psid, false);
              await sendFacebookMessage(sender_psid, trimmedMsg);
            }
          }
        } catch (error) {
          console.error("Lỗi xử lý (quick reply):", error);
          await sendFacebookMessage(sender_psid, "Dạ, Shop xin lỗi, hệ thống đang có chút bận rộn. Bác vui lòng thử lại sau ạ.");
        }
      }
    });
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM MỚI: LẤY DỮ LIỆU GOOGLE SHEET (CÓ CACHE 5 PHÚT)
// -------------------------------------------------------------------
async function getSheetData() {
  const fiveMinutes = 5 * 60 * 1000;
  const now = Date.now();

  // Nếu cache còn hạn (dưới 5 phút), dùng cache
  if (sheetCache.dataString && (now - sheetCache.timestamp < fiveMinutes)) {
    console.log("Đang dùng kiến thức từ Cache...");
    return sheetCache.dataString;
  }
  
  // Nếu cache hết hạn, gọi API Google Sheet
  console.log("Đang tải kiến thức mới từ Google Sheet...");
  try {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:F', // Lấy từ cột A đến F
    });

    const rows = response.data.values;
    if (rows && rows.length > 0) {
      // Bỏ qua dòng tiêu đề (dòng 1)
      const headers = rows[0]; 
      const data = rows.slice(1);

      // Chuyển dữ liệu Excel thành 1 chuỗi văn bản lớn
      let knowledgeString = "BẢNG KIẾN THỨC SẢN PHẨM:\n\n";
      data.forEach((row) => {
        // Chỉ thêm SP nếu có Cột A (Tên SP)
        if (row[0]) {
            knowledgeString += "---[SẢN PHẨM]---\n";
            for (let i = 0; i < headers.length; i++) {
            // Đảm bảo không thêm cột/dữ liệu rỗng
            if (headers[i] && row[i]) {
                knowledgeString += `${headers[i]}: ${row[i]}\n`;
            }
            }
            knowledgeString += "-----------------\n\n";
        }
      });
      
      // Lưu vào cache
      sheetCache.dataString = knowledgeString;
      sheetCache.timestamp = now;
      return knowledgeString;
    } else {
      return "KHÔNG TÌM THẤY SẢN PHẨM NÀO.";
    }
  } catch (err) {
    console.error('Lỗi khi tải Google Sheet:', err);
    // Nếu lỗi, trả về cache cũ (nếu có)
    return sheetCache.dataString || "Lỗi: Không tải được kiến thức.";
  }
}

// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - (Giữ nguyên)
// -------------------------------------------------------------------
async function loadState(psid) {
  const userRef = db.collection('users').doc(psid);
  const doc = await userRef.get();
  if (!doc.exists) {
    return { price_asked_count: 0, history: [] };
  } else {
    const data = doc.data();
    return {
      price_asked_count: data.price_asked_count || 0,
      history: data.history ? data.history.slice(-10) : [] 
    };
  }
}

async function saveState(psid, newState, userMessage, botMessage) {
  const userRef = db.collection('users').doc(psid);
  const newUserMsg = { role: 'user', content: userMessage };
  const newBotMsg = { role: 'bot', content: botMessage };
  await userRef.set({
    price_asked_count: newState.price_asked_count,
    history: admin.firestore.FieldValue.arrayUnion(newUserMsg, newBotMsg), 
    last_updated: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}


// -------------------------------------------------------------------
// HÀM GỌI GEMINI (Phiên bản "GOOGLE SHEETS RAG" + "Nút Bấm")
// -------------------------------------------------------------------
async function callGemini(userMessage, userName, userState, productKnowledge) {
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác"; 

    // XÂY DỰNG PROMPT BẰNG CÁCH NỐI CHUỖI
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn ĐA SẢN PHẨM. Bạn PHẢI trả lời tin nhắn của khách, tra cứu kiến thức, và CẬP NHẬT TRẠNG THÁI (state) của họ.\n\n";
    
    // NẠP KIẾN THỨC (TỪ GOOGLE SHEET)
    prompt += productKnowledge + "\n\n"; 

    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "**Trạng thái ghi nhớ (State) của khách TRƯỚC KHI trả lời:**\n";
    prompt += "- price_asked_count: " + userState.price_asked_count + "\n\n";
    prompt += "**Luật Lệ:**\n";
    prompt += "1.  **Phân tích tin nhắn (RẤT QUAN TRỌNG):**\n";
    prompt += "    - Đọc tin nhắn của khách: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra SĐT):** Một SĐT Việt Nam hợp lệ (10 số, bắt đầu 09, 08, 07, 05, 03).\n";
    prompt += "    - **(Ưu tiên 1 - Khách để lại SĐT đầu tiên):** Nếu tin nhắn CHỈ chứa SĐT hợp lệ VÀ Lịch sử chat là (Chưa có lịch sử chat) -> Kích hoạt 'Luật 1: Trả Lời SĐT Ngay'.\n";
    prompt += "    - **(Ưu tiên 2 - Khách hỏi mơ hồ):** Nếu tin nhắn mơ hồ (như 'Tôi muốn mua', 'shop có gì', 'tư vấn') VÀ Lịch sử chat là (Chưa có lịch sử chat) -> Kích hoạt 'Luật 2: Hỏi Vague & Liệt Kê SP'.\n";
    prompt += "    - **(Ưu tiên 3 - Tra cứu):** Nếu không, hãy tra cứu 'BẢNG KIẾN THỨC' dựa trên 'Từ Khóa' để tìm sản phẩm/triệu chứng phù hợp.\n";
    prompt += "    - **(Ưu tiên 4 - Phân tích giá):** Khách có hỏi giá lần này không? (Trả lời CÓ hoặc KHÔNG).\n";
    
    prompt += "2.  **Cập nhật State MỚI:**\n";
    prompt += "    - Nếu khách hỏi giá lần này, `new_price_asked_count` = " + userState.price_asked_count + " + 1.\n";
    prompt += "    - Nếu không, `new_price_asked_count` = " + userState.price_asked_count + ".\n";
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    
    // ----- ĐÃ THÊM KỊCH BẢN MỚI -----
    prompt += "    - **Luật 1: Trả Lời SĐT Ngay (Theo yêu cầu):**\n";
    prompt += "      - Trả lời: \"Dạ vâng " + greetingName + " chú ý điện thoại, tư vấn viên gọi lại tư vấn cụ thể Ưu Đãi và Cách Dùng cho Bác ngay đây ạ, cảm ơn bác.\"\n";
    prompt += "      - (Trong trường hợp này, `quick_replies` phải là [] rỗng).\n";
    
    prompt += "    - **Luật 2: Hỏi Vague & Liệt Kê SP (Theo yêu cầu):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | Shop có nhiều sản phẩm sức khỏe, Bác đang quan tâm cụ thể về vấn đề gì ạ?\"\n";
    prompt += "      - (QUAN TRỌNG): Lấy 3-4 'Tên Sản Phẩm' đầu tiên (chỉ lấy TÊN) từ 'BẢNG KIẾN THỨC' và tạo nút bấm `quick_replies` cho chúng. (Ví dụ: ['An Cung 60 viên', 'Cao Hắc Sâm', 'Tinh Dầu Thông Đỏ']).\n";
    // ----- KẾT THÚC KỊCH BẢN MỚI -----

    prompt += "    - **Luật Giá (Áp dụng cho mọi sản phẩm):**\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count >= 2`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP tra cứu được] hiện tại là [Giá SP tra cứu được] ạ. | Shop FREESHIP mọi đơn; và nếu Bác lấy từ 2 hộp Shop sẽ tặng 1 phần quà sức khỏe ạ. | Bác có muốn Shop tư vấn thêm về quà tặng không ạ?\" (Lưu ý: Lấy giá từ 'BẢNG KIẾN THỨC')\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count == 1`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", về giá thì tuỳ ưu đãi từng đợt Bác ạ. | Bác để SĐT + giờ rảnh, shop gọi 1-2 phút giải thích cặn kẽ hơn ạ.\"\n";
    
    prompt += "    - **Luật SĐT (trong khi chat):**\n";
    prompt += "      - Nếu tin nhắn ('" + userMessage + "') chứa SĐT hợp lệ (VÀ KHÔNG PHẢI LUẬT 1):\n";
    prompt += "        -> Trả lời: \"Dạ Shop cảm ơn " + greetingName + " ạ. Shop đã nhận được SĐT của Bác. | Shop sẽ gọi Bác trong ít phút nữa, hoặc Bác muốn Shop gọi vào giờ nào ạ?\"\n";

    prompt += "    - **Luật Quà Tặng:**\n";
    prompt += "      - (Áp dụng khi khách hỏi về 'quà tặng', 'khuyến mãi').\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", quà tặng bên Shop rất đa dạng ạ... | Bác để SĐT + giờ rảnh, shop gọi 1–2 phút tư vấn kỹ hơn cho Bác nhé?\"\n";

    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - (Áp dụng khi không dính các luật trên)\n"; 
    prompt += "      - **YÊU CẦU 0 (Tra cứu):** Nếu khách hỏi về công dụng, cách dùng... -> Hãy tìm SẢN PHẨM PHÙ HỢP trong 'BẢNG KIẾN THỨC' và trả lời. PHẢI NHẮC LẠI: 'Sản phẩm không phải là thuốc'.\n";
    prompt += "      - **YÊU CẦU 1 (Hỏi ngược):** Luôn kết thúc câu trả lời bằng một câu hỏi gợi mở.\n";
    prompt += "      - **YÊU CẦU 2 (Tần suất SĐT):** TUYỆT ĐỐI KHÔNG xin SĐT trong luật này.\n"; 
    prompt += "      - Nếu tin nhắn khó hiểu (như 'È', 'Hả', 'Lô'):\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ. | Bác có thể nói rõ hơn Bác đang cần hỗ trợ gì không ạ?\"\n";
    
    prompt += "      - Luôn xưng hô \"Shop - Bác\", tông ấm áp, câu ngắn, tối đa 1 emoji.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n";
    prompt += "  \"new_state\": {\n";
    prompt += "    \"price_asked_count\": [SỐ LẦN MỚI SAU KHI PHÂN TÍCH]\n";
    prompt += "  },\n";
    prompt += "  \"quick_replies\": [\"Nút bấm 1\", \"Nút bấm 2\"] (Chỉ dùng cho 'Luật 2: Hỏi Vague'. Nếu không, trả về mảng rỗng [])\n";
    prompt += "}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n"; 
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- State cũ: { \"price_asked_count\": " + userState.price_asked_count + " }\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
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
    
    return JSON.parse(cleanJsonString); 
    
  } catch (error) {
    console.error("Lỗi khi gọi Gemini API hoặc parse JSON:", error);
    return {
      response_message: "Dạ, hệ thống AI đang gặp chút trục trặc, Bác chờ Shop vài phút ạ. 😥",
      new_state: userState, // Trả lại state cũ
      quick_replies: []
    };
  }
}

// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG (Giữ nguyên - Sửa lỗi Bác Bác)
// -------------------------------------------------------------------
async function getFacebookUserName(sender_psid) {
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
    console.error("Lỗi khi lấy tên (do ở Chế độ PT), trả về null.");
    return null; 
  }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN (Giữ nguyên)
// -------------------------------------------------------------------
async function sendFacebookMessage(sender_psid, responseText) {
  const request_body = { "recipient": { "id": sender_psid }, "message": { "text": responseText }};
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
    console.log(`Đã gửi: ${responseText}`);
  } catch (error) { console.error("Lỗi khi gửi tin nhắn:", error.response?.data?.error || error.message); }
}

// -------------------------------------------------------------------
// HÀM MỚI: GỬI NÚT BẤM (QUICK REPLIES)
// -------------------------------------------------------------------
async function sendFacebookQuickReplies(sender_psid, text, replies) {
  // Giới hạn 13 nút bấm, và mỗi nút tối đa 20 ký tự
  const quickReplies = replies.slice(0, 13).map(reply => ({
    content_type: "text",
    title: reply.substring(0, 20), // Cắt bớt nếu tên SP quá dài
    payload: reply, // Khi khách bấm, họ sẽ gửi lại tên SP đầy đủ
  }));

  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": {
      "text": text, // Câu dẫn
      "quick_replies": quickReplies
    }
  };

  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
    console.log("Đã gửi Quick Replies.");
  } catch (error) {
    console.error("Lỗi khi gửi Quick Replies:", error.response?.data?.error || error.message);
  }
}

// -------------------------------------------------------------------
// HÀM BẬT/TẮT "ĐANG GÕ..." (Giữ nguyên)
// -------------------------------------------------------------------
async function sendFacebookTyping(sender_psid, isTyping) {
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    await axios.post('https.graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
  } catch (error) { 
    // Bỏ qua lỗi typing
  }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI ĐA SẢN PHẨM (Google Sheet) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});