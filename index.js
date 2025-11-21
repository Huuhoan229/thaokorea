// File: index.js (Phiên bản "SINGLE PERSONA v2.80" - Fix Lỗi Gửi Nhiều Ảnh)

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
if (pageTokenMap.size === 0) {
    console.error("LỖI: KHÔNG TÌM THẤY BẤT KỲ CẶP PAGE_ID VÀ TOKEN NÀO!");
}
// -------------------------------------------

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    // Sử dụng gemini-2.0-flash
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
// Endpoint 2: Nhận tin nhắn từ Facebook (LOGIC ĐỌC TIN ADMIN)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page' && body.entry) {
    res.status(200).send('EVENT_RECEIVED'); // Gửi OK ngay

    body.entry.forEach(async (entry) => { // Thêm async
      const pageId = entry.id; // Lấy Page ID

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === XỬ LÝ ECHO (TIN NHẮN TỪ PAGE) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") {
                return; // Tin của Bot -> Bỏ qua
            } else {
                // Tin của Admin (Chủ Shop) -> Lưu lại
                const adminText = webhook_event.message.text;
                const recipientID = webhook_event.recipient.id;
                if (adminText && recipientID) {
                    console.log(`[ADMIN CHAT TAY]: "${adminText}" -> Đang lưu vào bộ nhớ...`);
                    await saveAdminReply(pageId, recipientID, adminText);
                }
                return;
            }
        }
        // ========================================

        const sender_psid = webhook_event.sender.id; // ID Khách hàng

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
// HÀM XỬ LÝ CHÍNH (ĐÃ FIX LOGIC GỬI NHIỀU ẢNH)
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) {
        console.error(`KHÔNG TÌM THẤY TOKEN cho Page ID: ${pageId}. Bot sẽ không trả lời.`);
        return;
    }
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    
    if (processingUserSet.has(uniqueStorageId)) {
        console.log(`[CHỐNG LẶP]: Đang xử lý tin nhắn trước cho ${uniqueStorageId}. Bỏ qua.`);
        return;
    }
    processingUserSet.add(uniqueStorageId);

    try {
      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      const userState = await loadState(uniqueStorageId);
      
      let productKnowledge;
      let geminiResult;

      // ----- CHỈ CÒN LOGIC CỦA THẢO KOREA -----
      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          console.log(`[Router]: Trang Thuc Pham Chuc Nang (ID: ${pageId}). Processing...`);
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge);
      
      } else {
          console.error(`PAGE ID KHÔNG ĐƯỢC HỖ TRỢ: ${pageId}`);
          processingUserSet.delete(uniqueStorageId);
          return;
      }
      // ----------------------------------------

      console.log(`[Gemini Response]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      // === [LOGIC MỚI] GỬI NHIỀU ẢNH ===
      // Nếu Gemini trả về danh sách ảnh cách nhau bởi dấu phẩy
      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          // Tách chuỗi bằng dấu phẩy và xóa khoảng trắng thừa
          const imageUrls = geminiResult.image_url_to_send.split(',').map(url => url.trim()).filter(url => url.length > 0);
          
          console.log(`Đang gửi ${imageUrls.length} ảnh...`);
          
          // Gửi lần lượt từng ảnh
          for (const imgUrl of imageUrls) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(resolve => setTimeout(resolve, 500)); // Nghỉ xíu giữa các ảnh
              
              try {
                await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imgUrl);
              } catch (imgError) {
                console.error("LỖI KHI GỬI ẢNH:", imgError.message);
              }
          }
      }
      // ====================================
      
      // ----- GỬI CHỮ (TÁCH CÂU) -----
      const messages = geminiResult.response_message.split('|');
      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const trimmedMsg = msg.trim();
          if (trimmedMsg) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              const typingTime = 1500 + (trimmedMsg.length / 20 * 500);
              await new Promise(resolve => setTimeout(resolve, typingTime));
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
              
              await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, trimmedMsg);
          }
      }

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      const errorMessage = "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.";
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, errorMessage);
    } finally {
      processingUserSet.delete(uniqueStorageId);
      console.log(`[XỬ LÝ XONG]: Mở khóa cho ${uniqueStorageId}`);
    }
}

// -------------------------------------------------------------------
// BỘ NÃO: KIẾN THỨC SẢN PHẨM (THẢO KOREA) - [GIỮ NGUYÊN]
// -------------------------------------------------------------------
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";

    // ----- THÔNG TIN SHOP -----
    knowledgeString += "**THÔNG TIN SHOP:**\n";
    knowledgeString += "- Địa chỉ Kho: Hà Đông, Hà Nội.\n";
    knowledgeString += "- Địa chỉ Tổng công ty: Long Biên, Hà Nội.\n";
    knowledgeString += "- LƯU Ý: Shop CHỈ BÁN ONLINE, ship COD toàn quốc, được kiểm tra hàng.\n";
    knowledgeString += "- GIỜ LÀM VIỆC: 8h00 - 17h00 hàng ngày.\n";
    knowledgeString += "- FREESHIP: Đơn hàng từ 500.000đ trở lên.\n";
    
    // ----- QUY ĐỊNH QUÀ TẶNG -----
    knowledgeString += "**QUY ĐỊNH QUÀ TẶNG (QUAN TRỌNG):**\n";
    knowledgeString += "- Mua 1 hộp (các SP có quà): Mặc định tặng Dầu Lạnh.\n";
    knowledgeString += "- **ĐỔI QUÀ:** Khách CÓ THỂ yêu cầu đổi sang Cao Dán (hoặc ngược lại). Bot phải chấp nhận yêu cầu này.\n";
    knowledgeString += "- KHÔNG tặng thêm quà nếu khách chỉ mua 1 hộp. Nếu khách đòi thêm, hãy mời khách mua 2 hộp.\n\n";

    // == SẢN PHẨM 1 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN (1% TRẦM HƯƠNG)\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung, 1% trầm hương\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n"; 
    knowledgeString += "Mô Tả: Sản phẩm nổi tiếng Hàn Quốc, có chứa khoảng 1% trầm hương giúp bổ não, tăng tuần hoàn não, ổn định huyết áp.\n";
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối. Không dùng khi bụng đói. Giá: 780.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP. (Mua 1 hộp TẶNG 1 Dầu Lạnh hoặc 1 Cao Dán).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC (Hộp 2 lọ)\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu, hộp 2 lọ\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/200000494375/product/z4941235209154_120a0977cf9b70138a2330b5fee4f1db_8ddbf4c7f03244e6a24e49551e83dee2_master.jpg\"\n"; 
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Giá: 450.000đ/hộp (2 lọ). (Dưới 500k chưa Freeship, mua 2 hộp được Freeship).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 3 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP TINH DẦU THÔNG ĐỎ KWANGDONG HÀN QUỐC (120 VIÊN)\n";
    knowledgeString += "Từ Khóa: tinh dầu thông đỏ, thông đỏ, 120 viên, thông đỏ kwangdong, mỡ máu, giảm mỡ máu, cholesterol, tim mạch, mỡ gan, huyết áp, thông huyết mạch, xơ vữa động mạch\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"\n";
    knowledgeString += "Cách Dùng: Uống 1-2 viên/ngày sau bữa ăn tối 30 phút.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng cho phụ nữ có thai. Giá: 1.150.000đ/hộp 120 viên (ƯU ĐÃI) + MIỄN SHIP. (Mua 1 hộp TẶNG 1 Gói Cao Dán 20 miếng hoặc 1 Dầu Lạnh).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 4 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 30 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 30 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Image_URL: \"https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg\"\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 420.000đ/hộp 30 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 5 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP NƯỚC HỒNG SÂM NHUNG HƯƠU HỘP 20 GÓI\n";
    knowledgeString += "Từ Khóa: nước sâm, nước hồng sâm, sâm nhung hươu, nhung hươu, sâm 20 gói, bồi bổ, đau lưng, mỏi gối, xương khớp, yếu sinh lý, tăng đề kháng, suy nhược, mệt mỏi\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/200000830217/product/nuoc-hong-sam-nhung-huou-sms-bio-pharm-7_7a5ee2afe6bb4bea90e318231d2e2113_large.jpg\"\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Tình trạng: HẾT HÀNG. (Khi khách hỏi, hãy tư vấn chuyển sang Hộp 30 gói).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 6 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: NƯỚC MÁT GAN ĐÔNG TRÙNG NGHỆ SAMSUNG\n";
    knowledgeString += "Từ Khóa: nước mát gan, mát gan, giải độc gan, gan, nóng trong, men gan cao, rượu bia, mụn, mề đay, đông trùng, nghệ, curcumin, dạ dày, samsung gan\n";
    knowledgeString += "Image_URL: \"https://hueminhkorea.com/wp-content/uploads/2025/02/mat-gan-nghe-dong-trung-tw-han-quoc-2.jpg\"\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Giá: 390.000đ/hộp 30 gói (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    
    // == SẢN PHẨM 7 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG TRẦM HƯƠNG KWANGDONG HÀN QUỐC HỘP 60 VIÊN (15% TRẦM HƯƠNG)\n";
    knowledgeString += "Từ Khóa: an cung, an cung trầm hương, 15% trầm hương, trầm hương, an cung kwangdong, kwang dong, kwangdong, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não\n";
    knowledgeString += "Image_URL: \"https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg\"\n";
    knowledgeString += "Cách Dùng: Người tai biến: 1 viên/ngày. Người dự phòng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. (Loại 15% Trầm Hương, tốt nhất). Giá: 1.290.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP. (Mua 1 hộp TẶNG 1 Dầu Lạnh hoặc 1 Cao Dán).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 8 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: An Cung Ngưu Trầm Hương Hoàn Royal Family Chim Hyang Hwan Gold 32 Viên\n";
    knowledgeString += "Từ Khóa: an cung, an cung 32 viên, an cung royal family, royal family, chim hyang hwan, 5% trầm hương, 32 viên, an cung trầm hương, bổ não, suy nhược, mệt mỏi, kém tập trung\n";
    knowledgeString += "Image_URL: \"https://ikute.vn/wp-content/uploads/2022/11/An-cung-nguu-tram-huong-hoan-Royal-Family-Chim-Hyang-Hwan-1-ikute.vn_-600x449.jpg\"\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Chống chỉ định: Phụ nữ mang bầu/cho con bú, người cao huyết áp. Giá: 690.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP (FREESHIP). (Không tặng quà).\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    
    knowledgeString += "**KIẾN THỨC QUÀ TẶNG (Dùng để tra cứu):**\n";
    knowledgeString += "- Quà mặc định (An Cung Samsung, An Cung Kwangdong): 1 Lọ Dầu Lạnh.\n";
    knowledgeString += "- Quà mặc định (Tinh Dầu Thông Đỏ): 1 Gói Cao Dán 20 miếng.\n";
    knowledgeString += "- QUÀ CÓ THỂ ĐỔI (Nếu khách yêu cầu): Khách có thể đổi Dầu Lạnh lấy Cao Dán và ngược lại. Hãy xác nhận yêu cầu của khách.\n\n";
    
    return knowledgeString;
}

// -------------------------------------------------------------------
// HÀM QUẢN LÝ BỘ NHỚ (FIRESTORE) - [HỖ TRỢ LƯU TIN ADMIN]
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
        return { history: data.history ? data.history.slice(-15) : [] };
      }
  } catch (error) {
      console.error("Lỗi khi tải state từ Firestore:", error);
      return { history: [] };
  }
}

async function saveState(uniqueStorageId, userMessage, botMessage) { 
  if (!db) return;
  const userRef = db.collection('users').doc(uniqueStorageId); 
  const newUserMsg = { role: 'user', content: userMessage };
  const shouldSaveBotMsg = botMessage && !botMessage.includes("nhân viên Shop chưa trực tuyến");
  
  // Lưu tin nhắn của bot với role là 'model'
  const historyUpdates = shouldSaveBotMsg ? [newUserMsg, { role: 'model', content: botMessage }] : [newUserMsg];

  try {
      await userRef.set({
        history: admin.firestore.FieldValue.arrayUnion(...historyUpdates),
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (error) {
      console.error("Lỗi khi lưu state vào Firestore:", error);
  }
}

// --- HÀM MỚI: LƯU TIN NHẮN CỦA ADMIN CHAT TAY ---
async function saveAdminReply(pageId, customerId, text) {
    if (!db) return;
    const uniqueStorageId = `${pageId}_${customerId}`; 
    const userRef = db.collection('users').doc(uniqueStorageId);

    try {
        // Lưu với role là 'model' (Admin = Bot)
        await userRef.set({
            history: admin.firestore.FieldValue.arrayUnion({ 
                role: 'model', 
                content: text 
            }),
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`-> Đã lưu tin nhắn Admin vào lịch sử chat của khách ${customerId}`);
    } catch (error) {
        console.error("Lỗi khi lưu tin nhắn Admin:", error);
    }
}

// -------------------------------------------------------------------
// HÀM GỌI GEMINI (THẢO KOREA) - [ĐÃ CẬP NHẬT PROMPT CHẶN LINK TEXT]
// -------------------------------------------------------------------
async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "Dạ, nhân viên Shop chưa trực tuyến..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    // ----- LẤY GIỜ VIỆT NAM CHUẨN -----
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const vnTime = new Date(utc + (3600000 * 7)); // Cộng 7 tiếng
    const currentHour = vnTime.getHours();

    // --- PROMPT THẢO KOREA ---
    let prompt = "**Nhiệm vụ:** Bạn là chuyên viên tư vấn (Trang Thảo Korea). Xưng hô 'Shop - Bác'. **LUẬT BÍ MẬT:** TUYỆT ĐỐI KHÔNG BAO GIỜ được nói mình là 'bot' hay 'AI'. Phải hành văn 1 cách tự nhiên nhất.\n\n";
    
    // ----- LUẬT TỐI CAO (ĐỌC TIN ADMIN) -----
    prompt += "**LUẬT TỐI CAO:**\n";
    prompt += "Hãy đọc kỹ 'Lịch sử chat'. Nếu thấy 'Shop' (Admin) vừa nhắn tin trả lời khách, bạn PHẢI NƯƠNG THEO nội dung đó.\n";
    // -------------------------------------------

    prompt += productKnowledge + "\n\n";
    
    prompt += `**THỜI GIAN HIỆN TẠI:** ${currentHour} giờ.\n`;
    prompt += "**LUẬT GIỜ GIẤC:**\n";
    prompt += "- Nếu từ 8h - 17h: Nói 'Shop sẽ gọi điện xác nhận ngay ạ'.\n";
    prompt += "- Nếu từ 17h - 8h sáng hôm sau: Nói 'Dạ Shop đã nhận thông tin. Tuy nhiên hiện tại đã hết giờ làm việc (8h-17h), sáng mai nhân viên Shop sẽ ưu tiên gọi lại sớm nhất cho Bác nhé ạ!'.\n\n";

    prompt += "**Lịch sử chat (10-15 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG lặp lại. Trả lời NGẮN GỌN. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra Hình Ảnh):** Tin nhắn có chứa từ khóa yêu cầu ảnh ('ảnh', 'hình', 'video', 'xem hộp', 'cả 3', 'mẫu') không?\n";
    
    prompt += "    - **(Ưu tiên 1 - Yêu cầu Hình Ảnh):** Nếu 'Kiểm tra Hình Ảnh' (CÓ) -> Kích hoạt 'Luật 2: Gửi Ảnh Sản Phẩm'.\n";
    prompt += "    - (Ưu tiên 3 - Gửi SĐT/Địa chỉ): ... Kích hoạt 'Luật 3: Ghi Nhận Đơn Hàng'.\n";
    
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    
    prompt += "    - **Luật 2: Gửi Ảnh Sản Phẩm (QUAN TRỌNG):**\n";
    prompt += "      - (Hành động): Xác định SP khách muốn xem. Tra cứu 'Image_URL'.\n";
    prompt += "      - **NẾU KHÁCH MUỐN XEM NHIỀU ẢNH:** Hãy điền TẤT CẢ các link ảnh vào trường `image_url_to_send`, cách nhau bằng dấu phẩy (,).\n";
    prompt += "      - **CẤM:** TUYỆT ĐỐI KHÔNG chèn link ảnh vào `response_message`. Chỉ được viết text mô tả vào đó.\n";
    prompt += "      - (Ví dụ đúng): response_message: \"Dạ đây là ảnh 3 loại Bác tham khảo ạ\", image_url_to_send: \"link1.jpg, link2.jpg, link3.jpg\"\n";
    
    prompt += "    - **Luật 10: Báo Giá:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP] là [Giá SP] ạ...\"\n";
    
    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách (CHỈ TEXT, KHÔNG LINK) | tách bằng dấu |\",\n";
    prompt += "  \"image_url_to_send\": \"link1.jpg, link2.jpg\" (Nếu nhiều ảnh thì cách nhau bằng dấu phẩy)\n";
    prompt += "}\n";
    
    prompt += "---\n";
    prompt += "**BẮT ĐẦU:**\n";
    prompt += "- Khách hàng: \"" + (userName || "Khách lạ") + "\"\n";
    prompt += "- Tin nhắn: \"" + userMessage + "\"\n";
    prompt += "- Lịch sử chat: " + (historyString ? "Đã có" : "(Chưa có lịch sử chat)") + "\n\n";
    prompt += "TRẢ VỀ JSON:";
    
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
        image_url_to_send: geminiJson.image_url_to_send || "" 
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini (Thao Korea):", error);
    return {
      response_message: "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.",
      image_url_to_send: ""
    };
  }
}

// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG
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
    return null; 
  }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN (TEXT)
// -------------------------------------------------------------------
async function sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, responseText) { 
  if (!sender_psid || !responseText) return;
  
  let messageData = { 
      "text": responseText,
      "metadata": "FROM_BOT_AUTO" // Metadata để Bot không tự nói chuyện với mình
  };
  
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
// HÀM GỬI ẢNH
// -------------------------------------------------------------------
async function sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl) {
  if (!sender_psid || !imageUrl) return;

  const safeImageUrl = imageUrl.replace(/&amp;/g, '&');

  const request_body = {
    "recipient": { "id": sender_psid },
    "messaging_type": "RESPONSE",
    "message": {
      "attachment": {
        "type": "image",
        "payload": {
          "url": safeImageUrl, 
          "is_reusable": true 
        }
      },
      "metadata": "FROM_BOT_AUTO" // Metadata
    }
  };

  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body); 
    console.log(`Đã gửi (Ảnh): ${imageUrl}`);
  } catch (error) {
      console.error("Lỗi khi gửi ảnh Facebook:", error.response?.data?.error || error.message);
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ, Shop gửi ảnh bị lỗi. Nhân viên sẽ gửi lại cho Bác/bạn ngay ạ!");
      throw new Error("Gửi ảnh thất bại"); 
  }
}

// -------------------------------------------------------------------
// HÀM BẬT/TẮT "ĐANG GÕ..."
// -------------------------------------------------------------------
async function sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, isTyping) { 
  if (!sender_psid) return;
  const request_body = { "recipient": { "id": sender_psid }, "sender_action": isTyping ? "typing_on" : "typing_off" };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`, request_body);
  } catch (error) {
  }
}

// -------------------------------------------------------------------
// 5. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot AI (v2.80 - Fix Link Ảnh) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});