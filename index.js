// File: index.js (Phiên bản "Bỏ Giới Hạn 2 Câu" + "Sửa Lỗi Báo Bận")

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin'); // Thư viện "bộ nhớ"

// 2. KHỞI TẠO BỘ NHỚ (FIRESTORE)
let db; // Khai báo db ở đây
try {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore(); // Gán giá trị sau khi initializeApp
    console.log("Đã kết nối với Bộ nhớ Firestore.");
} catch (error) {
    console.error("LỖI NGHIÊM TRỌNG KHI KẾT NỐI FIRESTORE:", error);
    console.error("Vui lòng kiểm tra biến môi trường SERVICE_ACCOUNT_KEY_JSON trên Koyeb.");
    process.exit(1); // Thoát ứng dụng nếu không kết nối được Firestore
}


// 3. Khởi tạo các biến
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Kiểm tra các biến môi trường cần thiết khác
if (!GEMINI_API_KEY || !FB_PAGE_TOKEN || !VERIFY_TOKEN) {
    console.error("LỖI: Thiếu một hoặc nhiều biến môi trường (GEMINI_API_KEY, FB_PAGE_TOKEN, VERIFY_TOKEN).");
    process.exit(1);
}

// 4. Khởi tạo Gemini
let model; // Khai báo model ở đây
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    // SỬ DỤNG MODEL CHUẨN ĐÃ CHẠY
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
// Endpoint 2: Nhận tin nhắn từ Facebook (XỬ LÝ CHÍNH)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    // Gửi OK ngay lập tức để tránh Facebook gửi lại
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach((entry) => {
      if (entry.messaging && entry.messaging.length > 0) {
        let webhook_event = entry.messaging[0];
        let sender_psid = webhook_event.sender.id; // ID khách hàng

        if (webhook_event.message && webhook_event.message.is_echo) {
            return; // Bỏ qua tin nhắn do chính Bot gửi
        }

        // Xử lý cả tin nhắn văn bản và nút bấm (nếu có)
        let userMessage = null;
        if (webhook_event.message && webhook_event.message.text) {
            userMessage = webhook_event.message.text;
        } else if (webhook_event.message && webhook_event.message.quick_reply) {
            userMessage = webhook_event.message.quick_reply.payload;
        }

        if (userMessage && sender_psid) {
          processMessage(sender_psid, userMessage); // Gọi hàm xử lý riêng
        } else {
            // console.log("Tin nhắn không hợp lệ hoặc thiếu sender_psid:", webhook_event);
        }
      }
    });
  } else {
    console.error("Payload webhook không hợp lệ:", body);
    res.sendStatus(404);
  }
});

// Hàm xử lý tin nhắn riêng biệt (async)
async function processMessage(sender_psid, userMessage) {
    try {
      await sendFacebookTyping(sender_psid, true);
      let userName = await getFacebookUserName(sender_psid);
      const userState = await loadState(sender_psid);

      // LẤY KIẾN THỨC SẢN PHẨM TRỰC TIẾP TỪ CODE
      const productKnowledge = getProductKnowledge();

      console.log(`[User ${userName || 'Khách lạ'} (Giá: ${userState.price_asked_count} lần)]: ${userMessage}`);

      // Gọi Gemini để lấy Câu trả lời + Trạng thái MỚI
      const geminiResult = await callGemini(userMessage, userName, userState, productKnowledge);

      console.log(`[Gemini Response]: ${geminiResult.response_message}`);
      console.log(`[New State]: price_asked_count = ${geminiResult.new_state.price_asked_count}`);

      await sendFacebookTyping(sender_psid, false);
      await saveState(sender_psid, geminiResult.new_state, userMessage, geminiResult.response_message);

      // Tách câu và gửi
      const messages = geminiResult.response_message.split('|');
      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const trimmedMsg = msg.trim();
          if (trimmedMsg) {
              const isLastMessage = i === messages.length - 1;
              
              await sendFacebookTyping(sender_psid, true);
              const typingTime = 1500 + (trimmedMsg.length / 20 * 1000); // 1.5s + tg gõ
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(sender_psid, false);
              
              await sendFacebookMessage(sender_psid, trimmedMsg); // Bỏ quick replies
          }
      }

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      // ----- ĐÃ SỬA CÂU BÁO LỖI -----
      await sendFacebookMessage(sender_psid, "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.");
    }
}


// -------------------------------------------------------------------
// HÀM MỚI: TRẢ VỀ KHỐI KIẾN THỨC SẢN PHẨM (NHÚNG VÀO CODE)
// -------------------------------------------------------------------
function getProductKnowledge() {
    // (Toàn bộ kiến thức sản phẩm Bác đã cung cấp ở đây)
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (DÙNG ĐỂ TRA CỨU):**\n\n";

    // == SẢN PHẨM 1 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp. Nhai hoặc pha nước ấm.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối (gây mất ngủ). Không dùng khi bụng đói. Giá: 790.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 1.200.000đ/hũ.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 950.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 650.000đ/hộp 30 gói.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 480.000đ/hộp 20 gói.\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 6 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 550.000đ/hộp 30 chai.\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 7 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung kwangdong, kwang dong, kwangdong, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Cách Dùng: Người tai biến: 1 viên/ngày. Người dự phòng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 1.100.000đ/hộp.\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    return knowledgeString;
}

// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - (Giữ nguyên)
// -------------------------------------------------------------------
async function loadState(psid) {
  if (!db) {
      console.error("Firestore chưa được khởi tạo!");
      return { price_asked_count: 0, history: [] };
  }
  const userRef = db.collection('users').doc(psid);
  try {
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
  } catch (error) {
      console.error("Lỗi khi tải state từ Firestore:", error);
      return { price_asked_count: 0, history: [] };
  }
}

async function saveState(psid, newState, userMessage, botMessage) {
  if (!db) {
      console.error("Firestore chưa được khởi tạo! Không thể lưu state.");
      return;
  }
  const userRef = db.collection('users').doc(psid);
  const newUserMsg = { role: 'user', content: userMessage };
  const shouldSaveBotMsg = botMessage && !botMessage.includes("nhân viên Shop chưa trực tuyến"); // Sửa chữ "trục trặc"
  const historyUpdates = shouldSaveBotMsg ? [newUserMsg, { role: 'bot', content: botMessage }] : [newUserMsg];

  try {
      await userRef.set({
        price_asked_count: newState.price_asked_count,
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (error) {
      console.error("Lỗi khi lưu state vào Firestore:", error);
  }
}

// -------------------------------------------------------------------
// HÀM GỌI GEMINI (Phiên bản "BỎ GIỚI HẠN 2 CÂU" + "SỬA LỖI BÁO BẬN")
// -------------------------------------------------------------------
async function callGemini(userMessage, userName, userState, productKnowledge) {
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return {
          response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.", // Sửa lỗi
          new_state: userState
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
    
    // ----- ĐÃ CẬP NHẬT LUẬT LỆ (BỎ GIỚI HẠN 2 CÂU) -----
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG được nói lặp đi lặp lại. Phải trả lời NGẮN GỌN, đúng trọng tâm. (Vẫn dùng dấu | để tách các ý/câu nếu cần).\n";
    
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn của khách: \"" + userMessage + "\".\n";
    prompt += "    - **(Ưu tiên 1 - Xử lý Đơn Hàng):** Nếu tin nhắn của khách chứa SĐT + Địa chỉ + Tên SP (như 'mua 1 hop an cung hoan dt 079...'): Kích hoạt 'Luật 1: Xử Lý Đơn Hàng'.\n";
    prompt += "    - **(Ưu tiên 2 - Câu hỏi mặc định SĐT):** Nếu tin nhắn GIỐNG HỆT 'Số Điện Thoại của tôi là:' -> Kích hoạt 'Luật 2: Phản hồi Câu SĐT Mặc Định'.\n";
    prompt += "    - **(Ưu tiên 3 - Câu hỏi mặc định Mua SP):** Nếu tin nhắn GIỐNG HỆT 'Tôi muốn mua sản phẩm:' HOẶC tin nhắn mơ hồ ('shop có gì'...) VÀ Lịch sử chat là (Chưa có lịch sử chat) -> Kích hoạt 'Luật 3: Hỏi Vague & Liệt Kê SP'.\n";
    prompt += "    - **(Ưu tiên 4 - Tra cứu):** Nếu không, hãy tra cứu 'KHỐI KIẾN THỨC SẢN PHẨM'.\n";
    prompt += "    - **(Ưu tiên 5 - Phân tích giá):** Khách có hỏi giá lần này không? (Trả lời CÓ hoặc KHÔNG).\n";

    prompt += "3.  **Cập nhật State MỚI:**\n";
    prompt += "    - Nếu khách hỏi giá lần này, `new_price_asked_count` = " + userState.price_asked_count + " + 1.\n";
    prompt += "    - Nếu không, `new_price_asked_count` = " + userState.price_asked_count + ".\n";
    prompt += "4.  **Luật Trả Lời (dựa trên Phân tích):**\n";

    prompt += "    - **Luật 1: Xử Lý Đơn Hàng (NGẮN GỌN):**\n";
    prompt += "      - **TUYỆT ĐỐI KHÔNG** lặp lại SĐT hoặc Địa chỉ của khách.\n";
    prompt += "      - Nếu Tên SP rõ ràng (ví dụ 'Cao Hồng Sâm'): Chỉ trả lời 1 câu: \"Dạ Shop đã nhận được đơn hàng [Tên SP] của Bác " + greetingName + " ạ. Shop sẽ gọi Bác để xác nhận ngay nhé.\"\n";
    prompt += "      - Nếu Tên SP chung chung (ví dụ 'an cung'): PHẢI hỏi 1 câu duy nhất để làm rõ (bao gồm giá): \"Dạ " + greetingName + ", Shop đã nhận được thông tin. Bác vui lòng xác nhận giúp Shop là Bác muốn đặt An Cung Samsung (790.000đ) hay An Cung Kwangdong (1.100.000đ) ạ?\"\n";

    prompt += "    - **Luật 2: Phản hồi Câu SĐT Mặc Định:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Bác cần Shop hỗ trợ gì ạ? | Nếu Bác muốn được tư vấn kỹ hơn qua điện thoại, Bác có thể nhập Số Điện Thoại vào đây, Shop sẽ gọi lại ngay ạ.\"\n";

    prompt += "    - **Luật 3: Hỏi Vague & Liệt Kê SP (DANH SÁCH VĂN BẢN):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | Shop có nhiều sản phẩm sức khỏe Hàn Quốc, Bác đang quan tâm cụ thể về vấn đề gì hoặc sản phẩm nào ạ? Bác có thể tham khảo một số sản phẩm sau: \n1. AN CUNG SAMSUNG (Hỗ trợ tai biến)\n2. CAO HỒNG SÂM 365 (Bồi bổ sức khỏe)\n3. TINH DẦU THÔNG ĐỎ (Hỗ trợ mỡ máu)\n4. NƯỚC SÂM NHUNG HƯƠU (Tăng cường sinh lực)\"\n";
    
    prompt += "    - **Luật Giá (KHÔNG XIN SĐT):**\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count >= 2`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP tra cứu được] hiện tại là [Giá SP tra cứu được] ạ. | Shop FREESHIP mọi đơn và có quà tặng khi Bác lấy từ 2 hộp ạ.\"\n";
    prompt += "      - Nếu khách hỏi giá (CÓ) VÀ `new_price_asked_count == 1`:\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", về giá thì tuỳ ưu đãi từng đợt và liệu trình Bác dùng ạ. | Để biết giá chính xác, Bác hỏi lại lần nữa giúp Shop nhé!\"\n";

    prompt += "    - **Luật Quà Tặng (KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi khách hỏi về 'quà tặng', 'khuyến mãi').\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", quà tặng bên Shop rất đa dạng ạ. | Shop sẽ tư vấn quà tặng phù hợp nhất khi Bác chốt đơn nhé ạ!\"\n";

    prompt += "    - **Luật Chung (Mặc định - KHÔNG XIN SĐT):**\n";
    prompt += "      - (Áp dụng khi không dính các luật trên)\n";
    prompt += "      - **LUÔN NHỚ LUẬT CHAT:** Trả lời NGẮN GỌN, không lặp lại.\n"; // Đã bỏ giới hạn 2 câu
    prompt += "      - **YÊU CẦU 0 (Tra cứu):** Nếu khách hỏi về công dụng, cách dùng... -> Trả lời NGẮN GỌN dựa trên 'KHỐI KIẾN THỨC SẢN PHẨM'. PHẢI NHẮC LẠI: 'Sản phẩm không phải là thuốc'.\n";
    prompt += "      - **YÊU CẦU 1 (Hỏi ngược):** Kết thúc bằng một câu hỏi gợi mở NGẮN.\n";
    prompt += "      - **YÊU CẦU 2 (KHÔNG XIN SĐT):** TUYỆT ĐỐI KHÔNG xin SĐT.\n";
    prompt += "      - **(BỎ QUA SĐT):** Nếu tin nhắn của khách chỉ chứa SĐT -> KHÔNG trả lời gì đặc biệt, coi như tin nhắn khó hiểu.\n";
    prompt += "      - Nếu tin nhắn khó hiểu (kể cả SĐT):\n";
    prompt += "        -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ. | Bác có thể nói rõ hơn Bác đang cần hỗ trợ gì không ạ?\"\n";

    prompt += "      - Luôn xưng hô \"Shop - Bác\", tông ấm áp, câu ngắn, tối đa 1 emoji.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";

    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n"; // Bỏ giới hạn 1 dấu |
    prompt += "  \"new_state\": {\n";
    prompt += "    \"price_asked_count\": [SỐ LẦN MỚI SAU KHI PHÂN TÍCH]\n";
    prompt += "  }\n";
    prompt += "}\n";
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n";
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- State cũ: { \"price_asked_count\": " + userState.price_asked_count + " }\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "TRẢ VỀ JSON:";

    const generationConfig = {
      // temperature: 0.7,
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
    const geminiJson = JSON.parse(cleanJsonString);
    
    return {
        response_message: geminiJson.response_message || "Dạ Bác chờ Shop một lát ạ.",
        new_state: geminiJson.new_state || userState
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini API hoặc parse JSON:", error);
    // ----- ĐÃ SỬA CÂU BÁO LỖI -----
    return {
      response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
      new_state: userState, // Trả lại state cũ
    };
  }
}

// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG (Giữ nguyên - Sửa lỗi Bác Bác)
// -------------------------------------------------------------------
async function getFacebookUserName(sender_psid) {
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
        // console.error("Lỗi khi lấy tên:", error.message); // Tắt bớt log không quan trọng
    }
    return null;
  }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN (ĐÃ XÓA LOGIC NÚT BẤM)
// -------------------------------------------------------------------
async function sendFacebookMessage(sender_psid, responseText) {
  if (!sender_psid || !responseText) return; // Thêm kiểm tra đầu vào

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
// HÀM BẬT/TẮT "ĐANG GÕ..." (Giữ nguyên)
// -------------------------------------------------------------------
async function sendFacebookTyping(sender_psid, isTyping) {
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
  console.log(`Bot AI ĐA SẢN PHẨM (Bo gioi han) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});