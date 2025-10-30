// File: index.js (Phiên bản "KHÔNG GOOGLE SHEET" - Tạo Nút Bấm Tự Động)

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

      // Xử lý cả tin nhắn văn bản và nút bấm
      let userMessage = null;
      if (webhook_event.message && webhook_event.message.text) {
          userMessage = webhook_event.message.text;
      } else if (webhook_event.message && webhook_event.message.quick_reply) {
          userMessage = webhook_event.message.quick_reply.payload; // Lấy nội dung từ nút bấm
      }

      if (userMessage) {
        try {
          await sendFacebookTyping(sender_psid, true);
          let userName = await getFacebookUserName(sender_psid);
          const userState = await loadState(sender_psid);
          
          // LẤY KIẾN THỨC SẢN PHẨM TRỰC TIẾP TỪ CODE
          const productKnowledge = getProductKnowledge(); 

          console.log(`[User ${userName || 'Khách lạ'} (Giá: ${userState.price_asked_count} lần)]: ${userMessage}`);

          // Gọi Gemini để lấy Câu trả lời + Trạng thái MỚI
          const geminiResult = await callGemini(userMessage, userName, userState, productKnowledge);
          
          console.log(`[Gemini]: ${geminiResult.response_message}`);
          console.log(`[State Mới]: price_asked_count = ${geminiResult.new_state.price_asked_count}`);

          await sendFacebookTyping(sender_psid, false);
          await saveState(sender_psid, geminiResult.new_state, userMessage, geminiResult.response_message);

          // Tách câu và gửi
          const messages = geminiResult.response_message.split('|');
          for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              const trimmedMsg = msg.trim();
              if (trimmedMsg) {
                  // Chỉ gửi nút bấm kèm tin nhắn cuối cùng (nếu có)
                  const isLastMessage = i === messages.length - 1;
                  const quickRepliesToSend = (isLastMessage && geminiResult.quick_replies && geminiResult.quick_replies.length > 0) ? geminiResult.quick_replies : [];
                  
                  await sendFacebookTyping(sender_psid, true);
                  const typingTime = 1500 + (trimmedMsg.length / 20 * 1000); // 1.5s + tg gõ
                  await new Promise(resolve => setTimeout(resolve, typingTime));
                  await sendFacebookTyping(sender_psid, false);
                  
                  await sendFacebookMessage(sender_psid, trimmedMsg, quickRepliesToSend);
              }
          }

        } catch (error) {
          console.error("Lỗi xử lý:", error);
          await sendFacebookMessage(sender_psid, "Dạ, Shop xin lỗi, hệ thống đang có chút bận rộn. Bác vui lòng thử lại sau ạ.");
        }
      } // Kết thúc if (userMessage)
    }); // Kết thúc forEach entry
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM MỚI: TRẢ VỀ KHỐI KIẾN THỨC SẢN PHẨM (NHÚNG VÀO CODE)
// -------------------------------------------------------------------
function getProductKnowledge() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (DÙNG ĐỂ TRA CỨU):**\n\n";

// == SẢN PHẨM 1 (ĐÃ CẬP NHẬT) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    knowledgeString += "Mô Tả Chung: Sản phẩm nổi tiếng Hàn Quốc, giúp bổ não, tăng tuần hoàn não, ổn định huyết áp, phòng ngừa nguy cơ bị tai biến, đột quỵ.\n";
    knowledgeString += "Công Dụng: Hỗ trợ cải thiện rối loạn tiền đình, đau nửa đầu, thiếu máu não; Phòng bệnh cho người có nguy cơ đột quỵ; Hỗ trợ phục hồi sau tai biến.\n";
    // ----- ĐÃ CẬP NHẬT DÒNG NÀY -----
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp. Nhai hoặc pha nước ấm.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối (gây mất ngủ). Không dùng khi bụng đói. Giá: 790.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu\n";
    knowledgeString += "Mô Tả Chung: Tinh chất hồng sâm 6 năm tuổi cô đặc, giúp bồi bổ sức khỏe toàn diện, giảm mệt mỏi, tăng cường đề kháng.\n";
    knowledgeString += "Công Dụng: Bồi bổ cơ thể, phục hồi sức khỏe cho người mới ốm dậy; Giảm stress, mệt mỏi; Tăng cường trí nhớ; Ổn định đường huyết.\n";
    knowledgeString += "Cách Dùng: Mỗi ngày 1 thìa cafe, pha với 100ml nước ấm. Uống vào buổi sáng sau khi ăn.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Trẻ em dưới 15 tuổi không nên dùng. Giá: 1.200.000đ/hũ.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Mô Tả Chung: Chiết xuất 100% từ lá thông đỏ Hàn Quốc, hỗ trợ thông huyết mạch, giảm mỡ máu.\n";
    knowledgeString += "Công Dụng: Hỗ trợ giảm mỡ máu (cholesterol); Hỗ trợ phòng ngừa xơ vữa động mạch, huyết khối; Hỗ trợ tim mạch; Giảm đau nhức xương khớp.\n";
    knowledgeString += "Cách Dùng: Uống 1-2 viên/ngày sau bữa ăn tối 30 phút.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng cho phụ nữ có thai hoặc đang cho con bú. Uống nhiều nước khi dùng. Giá: 950.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Mô Tả Chung: Nước hồng sâm kết hợp nhung hươu, tiện lợi dạng gói, giúp bồi bổ khí huyết, tăng cường sinh lực.\n";
    knowledgeString += "Công Dụng: Bồi bổ sức khỏe, tăng cường thể lực; Hỗ trợ xương khớp, giảm đau lưng mỏi gối; Cải thiện sinh lý; Tăng cường miễn dịch.\n";
    knowledgeString += "Cách Dùng: Uống trực tiếp 1 gói/ngày, tốt nhất vào buổi sáng.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 650.000đ/hộp 30 gói.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Mô Tả Chung: Nước hồng sâm kết hợp nhung hươu, tiện lợi dạng gói, giúp bồi bổ khí huyết, tăng cường sinh lực (loại 20 gói).\n";
    knowledgeString += "Công Dụng: Bồi bổ sức khỏe, tăng cường thể lực; Hỗ trợ xương khớp, giảm đau lưng mỏi gối; Cải thiện sinh lý; Tăng cường miễn dịch.\n";
    knowledgeString += "Cách Dùng: Uống trực tiếp 1 gói/ngày, tốt nhất vào buổi sáng.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 480.000đ/hộp 20 gói.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 6 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, uống nhiều rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Mô Tả Chung: Nước uống thanh nhiệt, giải độc gan từ đông trùng, nghệ và các thảo dược, giúp bảo vệ gan.\n";
    knowledgeString += "Công Dụng: Hỗ trợ thanh nhiệt, giải độc gan; Bảo vệ và phục hồi chức năng gan; Giảm tác hại của rượu bia; Hỗ trợ tiêu hóa, giảm mụn nhọt.\n";
    knowledgeString += "Cách Dùng: Uống 1 chai/ngày, lắc đều trước khi uống.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 550.000đ/hộp 30 chai.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 7 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung kwangdong, kwang dong, kwangdong, an cung 60 viên, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Mô Tả Chung: Sản phẩm an cung ngưu hoàng hoàn nổi tiếng của Kwangdong, hỗ trợ phòng ngừa tai biến, ổn định huyết áp.\n";
    knowledgeString += "Công Dụng: Tương tự An Cung Samsung, hỗ trợ phòng ngừa đột quỵ, tai biến; Hỗ trợ điều hòa huyết áp; Bổ não, tăng cường tuần hoàn.\n";
    knowledgeString += "Cách Dùng: Tương tự An Cung Samsung (1 viên/ngày cho người lớn).\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 1.100.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    return knowledgeString;
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
// HÀM GỌI GEMINI (Phiên bản "KHÔNG BAO GIỜ CHỦ ĐỘNG XIN SĐT")
// -------------------------------------------------------------------
async function callGemini(userMessage, userName, userState, productKnowledge) {
  // Đảm bảo model đã được khởi tạo
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return {
          response_message: "Dạ, Shop xin lỗi, hệ thống AI chưa sẵn sàng ạ. 😥",
          new_state: userState,
          quick_replies: []
      };
  }
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    // XÂY DỰNG PROMPT BẰNG CÁCH NỐI CHUỖI
    let prompt = "**Nhiệm vụ:** Bạn là bot tư vấn ĐA SẢN PHẨM. Bạn PHẢI trả lời tin nhắn của khách, tra cứu kiến thức, và CẬP NHẬT TRẠNG THÁI (state) của họ.\n\n";

    // NẠP KIẾN THỨC (TỪ CODE)
    prompt += productKnowledge + "\n\n";

    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "**Trạng thái ghi nhớ (State) của khách TRƯỚC KHI trả lời:**\n";
    prompt += "- price_asked_count: " + userState.price_asked_count + "\n\n";
    prompt += "**Luật Lệ:**\n";
    prompt += "1.  **Phân tích tin nhắn (RẤT QUAN TRỌNG):**\n";
    prompt += "    - Đọc tin nhắn của khách: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra SĐT):** Một SĐT Việt Nam hợp lệ (10 số, bắt đầu 09, 08, 07, 05, 03).\n";
    prompt += "    - **(Ưu tiên 1 - Khách tự gửi SĐT):** Nếu tin nhắn CHỈ chứa SĐT hợp lệ HOẶC chứa SĐT hợp lệ trong câu -> Kích hoạt 'Luật 1: Xác Nhận SĐT'.\n"; // Áp dụng mọi lúc
    prompt += "    - **(Ưu tiên 2 - Khách hỏi mơ hồ lần đầu):** Nếu tin nhắn mơ hồ ('Tôi muốn mua', 'shop có gì'...) VÀ Lịch sử chat là (Chưa có lịch sử chat) -> Kích hoạt 'Luật 2: Hỏi Vague & Liệt Kê SP'.\n";
    prompt += "    - **(Ưu tiên 3 - Tra cứu):** Nếu không, hãy tra cứu 'KHỐI KIẾN THỨC SẢN PHẨM' dựa trên 'Từ Khóa'.\n";
    prompt += "    - **(Ưu tiên 4 - Phân tích giá):** Khách có hỏi giá lần này không? (Trả lời CÓ hoặc KHÔNG).\n";

    prompt += "2.  **Cập nhật State MỚI:**\n";
    prompt += "    - Nếu khách hỏi giá lần này, `new_price_asked_count` = " + userState.price_asked_count + " + 1.\n";
    prompt += "    - Nếu không, `new_price_asked_count` = " + userState.price_asked_count + ".\n";
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";

    // ----- ĐÃ CẬP NHẬT KỊCH BẢN -----
    prompt += "    - **Luật 1: Xác Nhận SĐT (Khi khách tự gửi):**\n";
    prompt += "      - Trả lời: \"Dạ vâng " + greetingName + " chú ý điện thoại, tư vấn viên gọi lại tư vấn cụ thể Ưu Đãi và Cách Dùng cho Bác ngay đây ạ, cảm ơn bác.\"\n";
    prompt += "      - (`quick_replies` phải là [] rỗng).\n";

    prompt += "    - **Luật 2: Hỏi Vague & Liệt Kê SP (Khi khách hỏi mơ hồ lần đầu):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | Shop có nhiều sản phẩm sức khỏe Hàn Quốc, Bác đang quan tâm cụ thể về vấn đề gì hoặc sản phẩm nào ạ?\"\n";
    prompt += "      - Lấy 4 'Tên Sản Phẩm' đầu tiên từ 'KHỐI KIẾN THỨC SẢN PHẨM' và tạo nút bấm `quick_replies`.\n";

    // ----- ĐÃ BỎ XIN SĐT TRONG LUẬT GIÁ -----
    prompt += "    - **Luật Giá (KHÔNG XIN SĐT):**\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count >= 2`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP tra cứu được] hiện tại là [Giá SP tra cứu được] ạ. | Shop FREESHIP mọi đơn; và nếu Bác lấy từ 2 hộp Shop sẽ tặng 1 phần quà sức khỏe ạ. | Bác có muốn Shop tư vấn thêm về quà tặng không ạ?\"\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count == 1`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", về giá thì tuỳ ưu đãi từng đợt và liệu trình Bác dùng ạ. | Để biết giá chính xác và ưu đãi tốt nhất, Bác hỏi lại lần nữa giúp Shop nhé!\"\n"; // Gợi ý hỏi lại thay vì xin SĐT

    // ----- ĐÃ BỎ XIN SĐT TRONG LUẬT QUÀ TẶNG -----
    prompt += "    - **Luật Quà Tặng (KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi khách hỏi về 'quà tặng', 'khuyến mãi').\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", quà tặng bên Shop rất đa dạng ạ, thường là các sản phẩm sức khỏe đi kèm. | Shop sẽ tư vấn quà tặng phù hợp nhất khi Bác chốt đơn nhé ạ! | Bác muốn hỏi thêm về sản phẩm nào khác không ạ?\"\n"; // Trả lời chung và hỏi ngược

    prompt += "    - **Luật Chung (Mặc định - KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi không dính các luật trên)\n";
    prompt += "      - **YÊU CẦU 0 (Tra cứu):** Nếu khách hỏi về công dụng, cách dùng... -> Hãy tìm SẢN PHẨM PHÙ HỢP trong 'KHỐI KIẾN THỨC SẢN PHẨM' và trả lời. PHẢI NHẮC LẠI: 'Sản phẩm không phải là thuốc'.\n";
    prompt += "      - **YÊU CẦU 1 (Hỏi ngược):** Luôn kết thúc câu trả lời bằng một câu hỏi gợi mở.\n";
    prompt += "      - **YÊU CẦU 2 (KHÔNG XIN SĐT):** TUYỆT ĐỐI KHÔNG xin SĐT trong luật này.\n";
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

    const generationConfig = {
      // temperature: 0.7, // Có thể điều chỉnh độ "sáng tạo" nếu cần
      // maxOutputTokens: 1000,
    };

    const result = await model.generateContent(prompt, generationConfig);
    let responseText = await result.response.text();

    // "Dọn dẹp" JSON (Cực kỳ quan trọng, giữ nguyên)
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}') + 1;
    if (startIndex === -1 || endIndex === -1) {
        console.error("Gemini raw response:", responseText); // Log lại để debug
        throw new Error("Gemini returned invalid data (no JSON found).");
    }
    const cleanJsonString = responseText.substring(startIndex, endIndex);

    // Parse JSON đã được "dọn dẹp"
    return JSON.parse(cleanJsonString);

  } catch (error) {
    console.error("Lỗi khi gọi Gemini API hoặc parse JSON:", error);
    // Trả về một lỗi an toàn để bot không bị crash
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
// HÀM GỬI TIN NHẮN (ĐÃ CẬP NHẬT ĐỂ GỬI NÚT BẤM)
// -------------------------------------------------------------------
async function sendFacebookMessage(sender_psid, responseText, quickReplies = []) {
  let messageData = { "text": responseText };
  
  // Nếu có nút bấm, thêm vào messageData
  if (quickReplies && quickReplies.length > 0) {
      messageData.quick_replies = quickReplies.slice(0, 13).map(reply => ({ // Giới hạn 13 nút
          content_type: "text",
          title: reply.substring(0, 20), // Tên nút tối đa 20 ký tự
          payload: reply, // Khi bấm, gửi lại tên đầy đủ
      }));
  }

  const request_body = { 
    "recipient": { "id": sender_psid }, 
    "messaging_type": "RESPONSE",
    "message": messageData
  };
  
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
    if (quickReplies.length > 0) {
        console.log(`Đã gửi: ${responseText} (kèm ${quickReplies.length} nút bấm)`);
    } else {
        console.log(`Đã gửi: ${responseText}`);
    }
  } catch (error) { console.error("Lỗi khi gửi tin nhắn:", error.response?.data?.error || error.message); }
}

// -------------------------------------------------------------------
// HÀM BẬT/TẮT "ĐANG GÕ..." (Giữ nguyên)
// -------------------------------------------------------------------
async function sendFacebookTyping(sender_psid, isTyping) {
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    // Lưu ý URL đúng
    await axios.post('https://graph.facebook.com/v19.0/me/messages', request_body, { params: { "access_token": FB_PAGE_TOKEN }});
  } catch (error) { 
    // Bỏ qua lỗi typing
  }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI ĐA SẢN PHẨM (KHÔNG Sheet) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});