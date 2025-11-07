// File: index.js (Phiên bản "Chỉ Chạy Bot Thảo Korea" - Đa Trang)

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

// ----- BỘ MAP TOKEN MỚI (CHỈ CÒN 2 TRANG TPCN) -----
const pageTokenMap = new Map();
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    console.log(`Đã tải Token cho trang Thao Korea: ${process.env.PAGE_ID_THAO_KOREA}`);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    console.log(`Đã tải Token cho trang Trang Moi: ${process.env.PAGE_ID_TRANG_MOI}`);
}
// ----- ĐÃ XÓA TRANG MÁY TÍNH -----

console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage (TPCN).`);
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
// HÀM "TỔNG ĐÀI" - (ĐÃ BỎ "NHÂN CÁCH" BOT)
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
      
      // ----- ĐÃ BỎ BỘ CHIA "NHÂN CÁCH" -----
      // Bot giờ chỉ có 1 bộ não: Thảo Korea
      console.log(`[Router]: Trang Thuc Pham Chuc Nang (ID: ${pageId}). Đang tải Bộ Não 1...`);
      const productKnowledge = getProductKnowledge_ThaoKorea();
      const geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge); 
      // ----- KẾT THÚC BỎ BỘ CHIA -----


      console.log(`[Gemini Response]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message); 

      // ----- GỬI ẢNH (NẾU CÓ) -----
      if (geminiResult.image_urls_to_send && geminiResult.image_urls_to_send.length > 0) {
          console.log(`Đang gửi ${geminiResult.image_urls_to_send.length} ảnh...`);
          for (const imageUrl of geminiResult.image_urls_to_send) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Chờ 1s
              await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl); // Gửi ảnh
          }
      }
      
      // Tách câu và gửi chữ
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
      // Sửa câu báo lỗi (chỉ còn 1 loại bot)
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.");
    } finally {
      processingUserSet.delete(uniqueStorageId); 
      console.log(`[XỬ LÝ XONG]: Mở khóa cho ${uniqueStorageId}`);
    }
}


// -------------------------------------------------------------------
// BỘ NÃO 1: KIẾN THỨC SẢN PHẨM (THẢO KOREA - ĐÃ THÊM LINK ẢNH)
// -------------------------------------------------------------------
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";

    // == SẢN PHẨM 1 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    // ----- ĐÃ THÊM LINK ẢNH (BÁC TỰ THAY THẾ 4 LINK CÒN LẠI NHÉ) -----
    knowledgeString += "Image_URLs: [\n";
    knowledgeString += "  \"https://scontent.fhan15-1.fna.fbcdn.net/v/t39.30808-6/576731409_830033216623704_5397344053414736847_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=127cfc&_nc_ohc=PyFC1_0M_wUQ7kNvwGayhnK&_nc_oc=AdkteOcOUlB8PDwiUTqe4MkTHIAQh638tSOQMOO1FdEABwXFZjBBYP6k5kNFpvJSu-xf9j5douudM2Ynl0O3dNAe&_nc_zt=23&_nc_ht=scontent.fhan15-1.fna&_nc_gid=MojeBTyOssHg3b0YaPvCJg&oh=00_Afi6IiwyIRr7FuYk3u5FDFMyeBa6wZXEd5OcxN_ADUy3FQ&oe=69138B17\",\n"; 
    knowledgeString += "  \"https://... (BÁC DÁN LINK ẢNH 2 VÀO ĐÂY) ...jpg\",\n";
    knowledgeString += "  \"https://... (BÁC DÁN LINK ẢNH 3 VÀO ĐÂY) ...jpg\",\n";
    knowledgeString += "  \"https://... (BÁC DÁN LINK ẢNH 4 VÀO ĐÂY) ...jpg\",\n";
    knowledgeString += "  \"https://... (BÁC DÁN LINK ẢNH 5 VÀO ĐÂY) ...jpg\"\n";
    knowledgeString += "]\n";
    // ----------------------------
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối. Không dùng khi bụng đói. Giá: 780.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC (Loại 2 lọ & 4 lọ)\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu, hộp 2 lọ, hộp 4 lọ\n";
    knowledgeString += "Image_URLs: [\n";
    knowledgeString += "  \"https://product.hstatic.net/200000494375/product/z4941235209154_120a0977cf9b70138a2330b5fee4f1db_8ddbf4c7f03244e6a24e49551e83dee2_master.jpg\",\n"; // 2 lọ
    knowledgeString += "  \"https://bizweb.dktcdn.net/thumb/1024x1024/100/234/106/products/w5.jpg?v=1644402146527\"\n"; // 4 lọ
    knowledgeString += "]\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Shop bán theo hộp:\n - Hộp 2 lọ: 450.000đ/hộp (ƯU ĐÃI).\n - Hộp 4 lọ: 850.000đ/hộp (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC (120 VIÊN)\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, 120 viên, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Image_URLs: [\"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"]\n";
    knowledgeString += "Cách Dùng: Uống 1-2 viên/ngày sau bữa ăn tối 30 phút.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng cho phụ nữ có thai. Giá: 1.150.000đ/hộp 120 viên (ƯU ĐÃI) + TẶNG 1 GÓI CAO DÁN 20 MIẾNG + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Image_URLs: [\"https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg\"]\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 420.000đ/hộp 30 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Image_URLs: [\"https://product.hstatic.net/200000830217/product/nuoc-hong-sam-nhung-huou-sms-bio-pharm-7_7a5ee2afe6bb4bea90e318231d2e2113_large.jpg\"]\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 330.000đ/hộp 20 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 6 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Image_URLs: [\"https://hueminhkorea.com/wp-content/uploads/2025/02/mat-gan-nghe-dong-trung-tw-han-quoc-2.jpg\"]\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 390.000đ/hộp 30 chai (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 7 (ĐÃ THÊM LINK ẢNH) ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG TRẦM HƯƠNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung trầm hương, trầm hương, an cung kwangdong, kwang dong, kwangdong, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Image_URLs: [\"https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg\"]\n";
    knowledgeString += "Cách Dùng: Người tai biến: 1 viên/ngày. Người dự phòng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. (Tốt nhất trong dòng 60 viên). Giá: 1.290.000đ/hộp (ƯU ĐÃI) + TẶNG 1 LỌ DẦU LẠNH + MIỄN SHIP.\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    
    knowledgeString += "**LỊCH SỬ QUÀ TẶNG (Dùng để tra cứu):**\n";
    knowledgeString += "- Quà mặc định (An Cung Samsung, An Cung Kwangdong): 1 Lọ Dầu Lạnh.\n";
    knowledgeString += "- Quà mặc định (Tinh Dầu Thông Đỏ): 1 Gói Cao Dán 20 miếng.\n";
    knowledgeString += "- QUÀ CÓ THỂ ĐỔI (Nếu khách yêu cầu): Khách có thể đổi Dầu Lạnh lấy Cao Dán và ngược lại. Hãy xác nhận yêu cầu của khách.\n\n";
    
    return knowledgeString;
}

// -------------------------------------------------------------------
// BỘ NÃO 2: ĐÃ BỊ XÓA
// -------------------------------------------------------------------


// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - (Giữ nguyên)
// -------------------------------------------------------------------
async function loadState(uniqueStorageId) { 
  if (!db) {
      console.error("Firestore chưa được khởi tạo!");
      return { history: [] }; 
  }
  const userRef = db.collection('users').doc(uniqueStorageId);
  try {
      const doc = await userRef.get();
      if (!doc.exists) {
        return { history: [] };
      } else {
        const data = doc.data();
        return {
          history: data.history ? data.history.slice(-10) : [] 
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
// HÀM GỌI GEMINI 1 (CHO TRANG THẢO KOREA - NÂNG CẤP GỬI ẢNH)
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
    let prompt = "**Nhiệm vụ:** Bạn là chuyên viên tư vấn (Trang Thảo Korea). Xưng hô 'Shop - Bác'. **LUẬT BÍ MẬT:** TUYỆT ĐỐI KHÔNG BAO GIỜ được nói mình là 'bot' hay 'AI'. Phải hành văn 1 cách tự nhiên nhất, giống như người thật đang chat.\n\n";
    prompt += productKnowledge + "\n\n";
    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    
    // ----- ĐÃ CẬP NHẬT LUẬT LỆ (THÊM LUẬT GỬI ẢNH) -----
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG lặp lại. Trả lời NGẮN GỌN. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - (Kiểm tra SĐT/Địa chỉ)...\n";
    prompt += "    - **(Kiểm tra Hình Ảnh):** Tin nhắn có chứa từ khóa yêu cầu ảnh ('ảnh', 'hình', 'video', 'xem hộp', 'nắp hộp', 'bên ngoài', 'gửi mẫu') không?\n"; // <--- LUẬT MỚI
    prompt += "    - (Kiểm tra Giá)...\n";
    prompt += "    - (Kiểm tra Đổi Quà)...\n";
    
    prompt += "    - **(Ưu tiên 1 - Yêu cầu Hình Ảnh):** Nếu 'Kiểm tra Hình Ảnh' (CÓ) -> Kích hoạt 'Luật 1: Gửi Ảnh Sản Phẩm'.\n"; // <--- LUẬT MỚI
    prompt += "    - (Ưu tiên 2 - Gửi SĐT/Địa chỉ)...\n";
    prompt += "    - (Ưu tiên 3 - Đổi Quà)...\n";
    prompt += "    - (Ưu tiên 4 - Câu hỏi mặc định SĐT)...\n";
    prompt += "    - (Ưu tiên 5 - Câu hỏi mặc định Mua SP)...\n";
    prompt += "    - (Ưu tiên 6 - Hỏi Giá)...\n";
    prompt += "    - (Ưu tiên 7 - Tra cứu)...\n";
    
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    
    // ----- LUẬT MỚI GỬI ẢNH -----
    prompt += "    - **Luật 1: Gửi Ảnh Sản Phẩm:**\n";
    prompt += "      - (Hành động): Xác định khách đang hỏi ảnh sản phẩm nào (dựa vào 'Từ Khóa' và Lịch sử chat). Tra cứu 'KHỐI KIẾN THỨC' để lấy danh sách 'Image_URLs' của sản phẩm đó.\n";
    prompt += "      - (Trả lời): Trả lời JSON có 2 trường: `response_message` (ví dụ: \"Dạ " + greetingName + ", Shop gửi Bác xem ảnh thật sản phẩm [Tên SP] ạ. | Bác xem có cần Shop tư vấn gì thêm không ạ?\") VÀ `image_urls_to_send` (mảng chứa các link ảnh đã tra cứu).\n";
    
    prompt += "    - **Luật 2: Ghi Nhận Đơn Hàng (SĐT/Địa chỉ):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop đã nhận được thông tin...\"\n";
    prompt += "    - **Luật 3: Xử Lý Đổi Quà:**\n";
    prompt += "      - Trả lời: \"Dạ vâng " + greetingName + ". Shop đã ghi nhận Bác muốn đổi quà...\"\n";
    prompt += "    - **Luật 5: Hỏi Vague & Liệt Kê SP (DANH SÁCH VĂN BẢN):**\n";
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | ... \n1. AN CUNG SAMSUNG...\n(Và 6 sản phẩm khác)\n7. AN CUNG TRẦM HƯƠNG KWANGDONG...\"\n";
    prompt += "    - **Luật 6: Báo Giá Công Khai (KHÔNG XIN SĐT):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP] là [Giá SP] ạ...\"\n";
    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - Nếu tin nhắn khó hiểu: -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ...\"\n";
    prompt += "      - Nếu không khó hiểu: Trả lời NGẮN GỌN dựa trên 'KHỐI KIẾN THỨC'.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    
    // ----- YÊU CẦU JSON MỚI -----
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n";
    prompt += "  \"image_urls_to_send\": [\"link1.jpg\", \"link2.jpg\"] (Chỉ dùng cho 'Luật 1: Gửi Ảnh SP'. Nếu không, trả về mảng rỗng [])\n";
    prompt += "}\n";
    // ----------------------------
    
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n"; // Dùng userName
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
        image_urls_to_send: geminiJson.image_urls_to_send || [] // Thêm trường trả về
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini (Thao Korea):", error);
    return {
      response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
      image_urls_to_send: []
    };
  }
}

// -------------------------------------------------------------------
// HÀM GỌI GEMINI 2 (ĐÃ BỊ XÓA)
// -------------------------------------------------------------------
// (Không còn hàm callGemini_MayTinh)


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
    
    let name = null;
    if (response.data) {
      if (response.data.first_name) {
        name = response.data.first_name + ' ' + (response.data.last_name || '');
      }
      return name;
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
    console.log(`Đã gửi (Text): ${responseText}`);
  } catch (error) {
      console.error("Lỗi khi gửi tin nhắn Facebook:", error.response?.data?.error || error.message);
  }
}

// -------------------------------------------------------------------
// HÀM MỚI: GỬI HÌNH ẢNH
// -------------------------------------------------------------------
async function sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl) {
  if (!sender_psid || !imageUrl) return;

  // Thay thế các ký tự '&' trong URL (lỗi phổ biến của link FB)
  // Đã sửa lại hàm replace an toàn hơn
  const safeImageUrl = imageUrl.replace(/&/g, '%26');

  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": {
      "attachment": {
        "type": "image",
        "payload": {
          "url": safeImageUrl, // Dùng link đã xử lý
          "is_reusable": true // Cho phép Facebook cache lại ảnh
        }
      }
    }
  };

  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body); 
    console.log(`Đã gửi (Ảnh): ${imageUrl}`);
  } catch (error) {
      console.error("Lỗi khi gửi ảnh Facebook:", error.response?.data?.error || error.message);
      // Gửi thông báo lỗi ảnh cho khách
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ, Shop gửi ảnh bị lỗi, Bác/Bạn chờ chút nhân viên Shop gửi lại ạ!");
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
  console.log(`Bot AI ĐA TRANG (v2.7 - Gui Anh) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});