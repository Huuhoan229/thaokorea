// File: index.js (Phiên bản "ĐA NHÂN CÁCH v2.14" - Cập Nhật Địa Chỉ + Tặng Quà Chuẩn)

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

// ----- BỘ MAP TOKEN MỚI (QUAN TRỌNG - HỖ TRỢ 3 TRANG) -----
const pageTokenMap = new Map();
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
    console.log(`Đã tải Token cho trang Thao Korea: ${process.env.PAGE_ID_THAO_KOREA}`);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
    console.log(`Đã tải Token cho trang Trang Moi: ${process.env.PAGE_ID_TRANG_MOI}`);
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
// HÀM "TỔNG ĐÀI" - PHÂN LOẠI "NHÂN CÁCH" BOT (ĐÃ NÂNG CẤP GỬI ẢNH)
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

      // ----- BỘ CHIA "NHÂN CÁCH" BOT (ĐÃ CẬP NHẬT 3 TRANG) -----
      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          console.log(`[Router]: Trang Thuc Pham Chuc Nang (ID: ${pageId}). Đang tải Bộ Não 1...`);
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge); 
      
      } else if (pageId === process.env.PAGE_ID_MAY_TINH) {
          console.log(`[Router]: Trang May Tinh (ID: ${pageId}). Đang tải Bộ Não 2...`);
          productKnowledge = getProductKnowledge_MayTinh();
          geminiResult = await callGemini_MayTinh(userMessage, userName, userState, productKnowledge);
      
      } else {
          console.error(`KHÔNG BIẾT PAGE ID: ${pageId}. Không có kịch bản.`);
          processingUserSet.delete(uniqueStorageId); // Mở khóa
          return; 
      }
      // ----- KẾT THÚC BỘ CHIA -----


      console.log(`[Gemini Response]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message); 

      // ----- NÂNG CẤP LOGIC GỬI ẢNH (CHỈ 1 ẢNH) -----
      // 1. Gửi ảnh trước (nếu có)
      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          console.log(`Đang gửi 1 ảnh: ${geminiResult.image_url_to_send}`);
          await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Chờ 1s
          
          try {
            await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, geminiResult.image_url_to_send); // Gửi 1 ảnh
          } catch (imgError) {
            console.error("LỖI KHI GỬI ẢNH (sẽ tiếp tục gửi text):", imgError.message);
            // (Hàm sendFacebookImage đã tự gửi báo lỗi)
          }
      }
      
      // 2. Tách câu và gửi chữ (luôn luôn)
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
      // ----- KẾT THÚC NÂNG CẤP -----

    } catch (error) {
      console.error("Lỗi xử lý:", error);
      const errorMessage = (pageId === process.env.PAGE_ID_MAY_TINH) 
        ? "Dạ, Shop đang bận chút, bạn chờ Shop trong giây lát nhé."
        : "Dạ, nhân viên Shop chưa trực tuyến nên chưa trả lời được Bác ngay ạ. Bác vui lòng chờ trong giây lát nhé.";
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, errorMessage);
    } finally {
      processingUserSet.delete(uniqueStorageId); 
      console.log(`[XỬ LÝ XONG]: Mở khóa cho ${uniqueStorageId}`);
    }
}


// -------------------------------------------------------------------
// BỘ NÃO 1: KIẾN THỨC SẢN PHẨM (THẢO KOREA - ĐÃ THÊM ĐỊA CHỈ + SP 8)
// -------------------------------------------------------------------
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";

    // ----- THÊM ĐỊA CHỈ SHOP -----
    knowledgeString += "**THÔNG TIN SHOP:**\n";
    knowledgeString += "- Địa chỉ Kho: Hà Đông, Hà Nội.\n";
    knowledgeString += "- Địa chỉ Tổng công ty: Long Biên, Hà Nội.\n\n";
    // -----------------------------

    // == SẢN PHẨM 1 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: AN CUNG SAMSUNG HÀN QUỐC HỘP GỖ 60 VIÊN\n";
    knowledgeString += "Từ Khóa: an cung, an cung samsung, an cung 60 viên, an cung hộp gỗ, tai biến, đột quỵ, phòng đột quỵ, huyết áp, cao huyết áp, tiền đình, rối loạn tiền đình, đau đầu, bổ não, tuần hoàn não, hoa mắt, chóng mặt, samsung\n";
    knowledgeString += "Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n"; 
    knowledgeString += "Cách Dùng: Dùng hằng ngày, mỗi ngày 1 viên. Một năm dùng 2-3 hộp.\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Không dùng buổi tối. Không dùng khi bụng đói. Giá: 780.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP. (Mua 1 hộp TẶNG 1 Dầu Lạnh hoặc 1 Cao Dán).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 2 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: HỘP CAO HỒNG SÂM 365 HÀN QUỐC (Loại 2 lọ & 4 lọ)\n";
    knowledgeString += "Từ Khóa: cao hồng sâm, cao sâm, sâm 365, hồng sâm 365, sâm hàn quốc, bồi bổ, tăng đề kháng, suy nhược, mệt mỏi, người ốm, quà biếu, ốm dậy, ăn không ngon, ngủ không sâu, hộp 2 lọ, hộp 4 lọ\n";
    knowledgeString += "Image_URL: \"https://product.hstatic.net/200000494375/product/z4941235209154_120a0977cf9b70138a2330b5fee4f1db_8ddbf4c7f03244e6a24e49551e83dee2_master.jpg\"\n"; 
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Người huyết áp cao nên dùng liều nhỏ. Shop bán theo hộp:\n - Hộp 2 lọ: 450.000đ/hộp (ƯU ĐÃI). (Dưới 500k, chưa Freeship)\n - Hộp 4 lọ: 850.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP.\n"; 
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
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. (Loại 15% Trầm Hương, tốt nhất trong dòng 60 viên). Giá: 1.290.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP. (Mua 1 hộp TẶNG 1 Dầu Lạnh hoặc 1 Cao Dán).\n";
    knowledgeString += "-----------------\n\n";

    // == SẢN PHẨM 8 ==
    knowledgeString += "---[SẢN PHẨM]---\n";
    knowledgeString += "Tên Sản Phẩm: An Cung Ngưu Trầm Hương Hoàn Royal Family Chim Hyang Hwan Gold 32 Viên\n";
    knowledgeString += "Từ Khóa: an cung, an cung 32 viên, an cung royal family, royal family, chim hyang hwan, 5% trầm hương, 32 viên, an cung trầm hương, bổ não, suy nhược, mệt mỏi, kém tập trung\n";
    knowledgeString += "Image_URL: \"https://ikute.vn/wp-content/uploads/2022/11/An-cung-nguu-tram-huong-hoan-Royal-Family-Chim-Hyang-Hwan-1-ikute.vn_-600x449.jpg\"\n";
    knowledgeString += "Lưu Ý / Giá: KHÔNG PHẢI LÀ THUỐC. Chống chỉ định: Phụ nữ mang bầu/cho con bú, người cao huyết áp. Giá: 690.000đ/hộp (ƯU ĐÃI) + MIỄN SHIP (FREESHIP). (Không tặng quà).\n";
    knowledgeString += "-----------------\n\n";

    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    
    knowledgeString += "**QUY ĐỊNH QUÀ TẶNG (RẤT QUAN TRỌNG):**\n";
    knowledgeString += "- Mua 1 hộp (các SP có quà): Tặng 1 Dầu Lạnh HOẶC 1 Cao Dán (Khách được chọn 1 trong 2, có thể đổi).\n";
    knowledgeString += "- KHÔNG tặng thêm quà nếu khách chỉ mua 1 hộp mà đòi thêm.\n";
    knowledgeString += "- Mua 2 hộp trở lên: Có thể xem xét tặng thêm (nhưng bot hãy tư vấn khéo léo: \"Bác mua thêm hộp thứ 2 đi Shop tặng thêm quà cho Bác\").\n\n";
    
    return knowledgeString;
}

// -------------------------------------------------------------------
// BỘ NÃO 2: KIẾN THỨC SẢN PHẨM (ĐỒ CHƠI MÁY TÍNH)
// -------------------------------------------------------------------
function getProductKnowledge_MayTinh() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (ĐỒ CHƠI MÁY TÍNH):**\n\n";
    knowledgeString += "---[SẢN PHẨM CHÍNH]---\n";
    knowledgeString += "Tên Sản Phẩm: Chuột Fuhlen L102 USB - Đen (Hàng Xịn)\n";
    knowledgeString += "Từ Khóa: chuột, fuhlen, l102, chuột l102, chuột fuhlen, chuột quốc dân, chuột giá rẻ, chuột 119k, chuột văn phòng, chuột game\n";
    knowledgeString += "Image_URL: \"https://hacom.vn/media/lib/l102-1.jpg\"\n"; // Chỉ 1 link
    knowledgeString += "Thông Số Vàng (Dùng để chém gió): Switch Omron (siêu bền), Độ bền 10 TRIỆU LẦN CLICK (bao phê, bao trâu bò), Cảm biến quang học 1000 DPI (chính xác, di mượt), Thiết kế công thái học & đối xứng (ôm tay, tay trái/phải đều ok, giảm mỏi).\n";
    knowledgeString += "Mô Tả Chung: Hàng hot, 'chuột quốc dân' cho cả game thủ, quán net, văn phòng. Kết nối USB cắm là dùng.\n";
    knowledgeString += "Lưu Ý / Giá: Giá 119.000đ (ƯU ĐÃI).\n";
    knowledgeString += "-----------------\n\n";
    knowledgeString += "---[SẢN PHẨM KHÁC]---\n";
    knowledgeString += "Tên Sản Phẩm: RAM, VGA, CPU, Bàn phím...\n";
    knowledgeString += "Tình trạng: Hiện tại Shop chưa sẵn hàng. Sắp về.\n";
    knowledgeString += "-----------------\n\n";
    knowledgeString += "\n----- HẾT KHỐI KIẾN THỨC -----\n\n";
    // ----- THÊM ĐỊA CHỈ SHOP MÁY TÍNH -----
    knowledgeString += "**THÔNG TIN SHOP:**\n";
    knowledgeString += "- Địa chỉ Kho: Hà Đông, Hà Nội.\n";
    knowledgeString += "- Địa chỉ Tổng công ty: Long Biên, Hà Nội.\n\n";
    // ------------------------------------
    return knowledgeString;
}


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
  const shouldSaveBotMsg = botMessage && !botMessage.includes("nhân viên Shop chưa trực tuyến") && !botMessage.includes("Shop đang bận chút");
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
// HÀM GỌI GEMINI 1 (CHO TRANG THẢO KOREA - SỬA LỖI ĐỔI QUÀ + PHÂN LOẠI + FREESHIP 500K)
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
    
    // ----- ĐÃ CẬP NHẬT LUẬT LỆ (THÊM LUẬT FREESHIP) -----
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** KHÔNG lặp lại. Trả lời NGẮN GỌN. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - (Kiểm tra SĐT/Địa chỉ)...\n";
    prompt += "    - **(Kiểm tra Hình Ảnh):** Tin nhắn có chứa từ khóa yêu cầu ảnh ('ảnh', 'hình', 'video', 'xem hộp', 'nắp hộp', 'bên ngoài', 'gửi mẫu') không?\n";
    prompt += "    - (Kiểm tra Giá)...\n";
    prompt += "    - (Kiểm tra Đổi Quà): Tin nhắn có chứa từ khóa đổi quà ('đổi quà', 'lấy cao dán', 'lấy dầu lạnh', 'không lấy dầu lạnh') không?\n";
    prompt += "    - **(Kiểm tra Phân Loại):** Tin nhắn có chứa từ khóa chung chung ('an cung', 'cao 365', 'cao hồng sâm', 'nhung hươu', 'sâm nhung hươu') MÀ KHÔNG chứa từ khóa cụ thể (samsung, kwangdong, royal family, 2 lọ, 4 lọ, 20 gói, 30 gói) không?\n";
    prompt += "    - **(Kiểm tra Đòi Quà):** Khách có đòi thêm quà (như 'tặng thêm đi', 'cho thêm cao dán', 'tặng 2 hộp') không?\n";
    prompt += "    - **(Kiểm tra Freeship):** Tin nhắn có chứa từ khóa 'ship', 'miễn ship', 'vận chuyển', 'phí ship' không?\n"; // <--- LUẬT MỚI
    prompt += "    - **(Kiểm tra Địa Chỉ Shop):** Khách có hỏi 'shop ở đâu', 'địa chỉ shop' không?\n"; // <--- LUẬT MỚI
    
    prompt += "    - **(Ưu tiên 1 - Cần Phân Loại):** Nếu 'Kiểm tra Phân Loại' (CÓ) VÀ KHÔNG 'Kiểm tra Hình Ảnh' (KHÔNG) -> Kích hoạt 'Luật 1: Yêu Cầu Phân Loại'.\n"; 
    prompt += "    - **(Ưu tiên 2 - Yêu cầu Hình Ảnh):** Nếu 'Kiểm tra Hình Ảnh' (CÓ) -> Kích hoạt 'Luật 2: Gửi Ảnh Sản Phẩm'.\n";
    prompt += "    - **(Ưu tiên 3 - Gửi SĐT/Địa chỉ):** ... Kích hoạt 'Luật 3: Ghi Nhận Đơn Hàng'.\n";
    prompt += "    - **(Ưu tiên 4 - Đổi Quà):** ... Kích hoạt 'Luật 4: Xử Lý Đổi Quà'.\n";
    prompt += "    - **(Ưu tiên 5 - Đòi Quà):** ... Kích hoạt 'Luật 5: Xử Lý Đòi Quà'.\n";
    prompt += "    - **(Ưu tiên 6 - Hết Hàng):** ... Kích hoạt 'Luật 6: Chuyển Hướng SP Hết Hàng'.\n";
    prompt += "    - **(Ưu tiên 7 - Hỏi Freeship):** Nếu 'Kiểm tra Freeship' (CÓ) -> Kích hoạt 'Luật 7: Trả Lời Freeship'.\n"; // <--- LUẬT MỚI
    prompt += "    - **(Ưu tiên 8 - Hỏi Địa Chỉ Shop):** Nếu 'Kiểm tra Địa Chỉ Shop' (CÓ) -> Kích hoạt 'Luật 8: Trả Lời Địa Chỉ'.\n"; // <--- LUẬT MỚI
    
    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";
    
    // ----- LUẬT MỚI -----
    prompt += "    - **Luật 1: Yêu Cầu Phân Loại:**\n";
    prompt += "      - Nếu khách hỏi 'an cung': Trả lời: \"Dạ " + greetingName + ", Bác muốn hỏi An Cung Samsung (780.000đ) hay An Cung Trầm Hương Kwangdong (1.290.000đ, 15% trầm hương) hay An Cung Royal Family (690k, 5% trầm hương) ạ?\"\n"; 
    prompt += "      - Nếu khách hỏi 'cao 365' / 'cao hồng sâm': Trả lời: \"Dạ " + greetingName + ", Bác muốn hỏi Cao Hồng Sâm 365 loại Hộp 2 lọ (450.000đ) hay Hộp 4 lọ (850.000đ, có freeship) ạ?\"\n";
    prompt += "      - Nếu khách hỏi 'nhung hươu' / 'sâm nhung hươu': Trả lời: \"Dạ " + greetingName + ", Bác muốn hỏi Nước Sâm Nhung Hươu loại Hộp 20 gói (330.000đ) hay Hộp 30 gói (420.000đ) ạ?\"\n";
    
    prompt += "    - **Luật 2: Gửi Ảnh Sản Phẩm:**\n";
    prompt += "      - (Hành động): Xác định SP, tra cứu 'Image_URL'. Nếu hỏi chung, hỏi lại trước.\n";
    prompt += "      - (Trả lời): Trả về JSON: `response_message` (ví dụ: \"Dạ " + greetingName + ", Shop gửi Bác xem ảnh thật sản phẩm [Tên SP] ạ. | Bác xem có cần Shop tư vấn gì thêm không ạ?\") VÀ `image_url_to_send` (1 link ảnh).\n";
    
    prompt += "    - **Luật 3: Ghi Nhận Đơn Hàng (SĐT/Địa chỉ):**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop đã nhận được thông tin (SĐT/Địa chỉ) của Bác ạ. | Shop sẽ gọi điện cho Bác để xác nhận đơn hàng ngay. Cảm ơn Bác ạ!\"\n";
    prompt += "    - **Luật 4: Xử Lý Đổi Quà:**\n";
    prompt += "      - Trả lời: \"Dạ vâng " + greetingName + ". Shop đã ghi nhận Bác muốn đổi quà (từ Dầu Lạnh sang Cao Dán hoặc ngược lại) ạ. | Shop sẽ xác nhận lại khi gọi chốt đơn cho Bác nhé!\"\n";
    prompt += "    - **Luật 5: Xử Lý Đòi Quà:**\n";
    prompt += "      - Trả lời: \"Dạ Bác thông cảm giúp Shop ạ, mua 1 hộp thì Shop chỉ tặng được 1 phần quà thôi ạ. | Nếu Bác lấy từ 2 hộp trở lên Shop sẽ ưu đãi tặng thêm quà cho Bác ạ! Bác lấy thêm 1 hộp nữa nhé?\"\n";
    prompt += "    - **Luật 6: Chuyển Hướng SP Hết Hàng:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop xin lỗi Bác ạ! | Loại Nước Sâm Nhung Hươu 20 gói (330k) hiện đang tạm hết hàng rồi ạ. | Bác tham khảo sang Hộp 30 gói (giá 420k) được không ạ? Tính ra vẫn tiết kiệm mà dùng được lâu hơn ạ!\"\n";

    // ----- LUẬT MỚI -----
    prompt += "    - **Luật 7: Trả Lời Freeship:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Shop có chính sách MIỄN SHIP (Freeship) toàn quốc cho các đơn hàng từ 500.000đ trở lên ạ. | Các đơn dưới 500k Shop sẽ báo phí ship sau nhé ạ. | Bác đang quan tâm sản phẩm nào ạ?\"\n";
    prompt += "    - **Luật 8: Trả Lời Địa Chỉ:**\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", Kho hàng của Shop ở Hà Đông, Hà Nội ạ. | Còn Tổng công ty thì ở Long Biên, Hà Nội ạ. | Shop có ship hàng toàn quốc Bác nhé!\"\n";

    prompt += "    - **Luật 9: Hỏi Vague & Liệt Kê SP (DANH SÁCH VĂN BẢN):**\n"; 
    prompt += "      - Trả lời: \"Dạ Shop chào " + greetingName + " ạ. | ... \n1. AN CUNG SAMSUNG (Hỗ trợ tai biến)\n(Và 7 sản phẩm khác)\n8. AN CUNG ROYAL FAMILY (32 viên)\"\n"; 
    prompt += "    - **Luật 10: Báo Giá Công Khai (KHÔNG XIN SĐT):**\n";
    prompt += "      - (Hành động): Nếu khách hỏi giá RÕ RÀNG, tra cứu 'KHỐI KIẾN THỨC'.\n";
    prompt += "      - Trả lời: \"Dạ " + greetingName + ", giá của [Tên SP] là [Giá SP] ạ...\"\n";
    prompt += "    - **Luật Chung (Mặc định):**\n";
    prompt += "      - Nếu tin nhắn khó hiểu: -> Trả lời: \"Dạ " + greetingName + ", Shop chưa hiểu ý Bác lắm ạ...\"\n";
    prompt += "      - Nếu không khó hiểu: Trả lời NGẮN GỌN dựa trên 'KHỐI KIẾN THỨC'.\n";
    prompt += "      - Tách câu trả lời bằng dấu |\n\n";
    
    // ----- YÊU CẦU JSON MỚI (1 ẢNH) -----
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n";
    prompt += "  \"image_url_to_send\": \"link1.jpg\" (Chỉ dùng cho 'Luật 2: Gửi Ảnh SP'. Nếu không, trả về chuỗi rỗng \"\")\n";
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
        image_url_to_send: geminiJson.image_url_to_send || "" // Thêm trường trả về
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
// HÀM GỌI GEMINI 2 (CHO TRANG ĐỒ CHƠI MÁY TÍNH - NÂNG CẤP GỬI ẢNH)
// -------------------------------------------------------------------
async function callGemini_MayTinh(userMessage, userName, userState, productKnowledge) {
  if (!model) {
      console.error("Gemini model chưa được khởi tạo!");
      return { response_message: "Shop đang bận chút, bạn chờ 1 lát nhé 😥" };
  }
  try {
    const historyString = userState.history.map(h => `${h.role}: ${h.content}`).join('\n');
    const salutation = "bạn"; 
    const greetingName = userName ? userName : salutation;
    
    // --- PROMPT 2: KỊCH BẢN MÁY TÍNH (SHOP-BẠN) ---
    let prompt = "**Nhiệm vụ:** Bạn là nhân viên tư vấn (Trang Đồ Chơi Máy Tính). **LUẬT BÍ MẬT:** TUYỆT ĐỐI KHÔNG BAO GIỜ được nói mình là 'bot' hay 'AI'. Phải chat 1 cách tự nhiên nhất, giọng văn giới trẻ (dùng 'sp', 'k', 'đc', 'ib', 'bao phê', 'hàng xịn'...). Xưng hô 'Shop' và gọi khách là '" + salutation + "'. Nếu biết tên, hãy chào tên (ví dụ 'Chào " + greetingName + "').\n\n";
    prompt += productKnowledge + "\n\n";
    prompt += "**ƯU ĐÃI HIỆN TẠI (Đồ Chơi Máy Tính):**\n";
    prompt += "- Mua 1 con: Giá 119k + 30k ship.\n";
    prompt += "- Mua từ 2 con chuột Fuhlen L102 trở lên: Giá 119k/con + MIỄN PHÍ SHIP (FREESHIP) toàn quốc.\n\n";
    prompt += "**Lịch sử chat (10 tin nhắn gần nhất):**\n";
    prompt += (historyString || "(Chưa có lịch sử chat)") + "\n\n";
    
    // ----- BỘ LUẬT MỚI CHO TRANG MÁY TÍNH (v2.14) -----
    prompt += "**Luật Lệ (Ưu tiên từ trên xuống):**\n";
    prompt += "1.  **LUẬT CHAT (QUAN TRỌNG NHẤT):** Trả lời NGẮN GỌN, nhiệt tình, giọng giới trẻ. Tách câu bằng |\n";
    prompt += "2.  **Phân tích tin nhắn:**\n";
    prompt += "    - Đọc tin nhắn: \"" + userMessage + "\".\n";
    prompt += "    - **(Kiểm tra Hình Ảnh):** Tin nhắn có chứa từ khóa yêu cầu ảnh ('ảnh', 'hình', 'video', 'xem chuột', 'ảnh thật') không?\n";
    prompt += "    - (Kiểm tra SĐT/Địa chỉ)...\n";
    prompt += "    - (Kiểm tra SP Khác)...\n";
    prompt += "    - (Kiểm tra Lịch sử)...\n";
    prompt += "    - (Kiểm tra Chào/Hỏi Mơ Hồ)...\n";
    prompt += "    - (Kiểm tra Đồng Ý)...\n";
    prompt += "    - **(Kiểm tra Địa Chỉ Shop):** Khách có hỏi 'shop ở đâu', 'địa chỉ shop' không?\n"; // <--- LUẬT MỚI
    
    prompt += "    - **(Ưu tiên 1 - Yêu cầu Hình Ảnh):** Nếu 'Kiểm tra Hình Ảnh' (CÓ) -> Kích hoạt 'Luật 1: Gửi Ảnh Sản Phẩm'.\n";
    prompt += "    - **(Ưu tiên 2 - Gửi SĐT/Địa chỉ):** ... Kích hoạt 'Luật 2: Ghi Nhận Đơn Hàng'.\n";
    prompt += "    - **(Ưu tiên 3 - Hỏi SP Khác):** ... Kích hoạt 'Luật 3: Xin lỗi hết hàng'.\n";
    prompt += "    - **(Ưu tiên 4 - Chào/Hỏi mơ hồ LẦN ĐẦU):** ... Kích hoạt 'Luật 4: Chào Hàng (Giới thiệu Chuột)'.\n";
    prompt += "    - **(Ưu tiên 5 - Khách đồng ý / Hỏi thêm):** ... Kích hoạt 'Luật 5: Tư Vấn Sâu (Chém Gió)'.\n";
    prompt += "    - **(Ưu tiên 6 - Hỏi Giá):** ... Kích hoạt 'Luật 6: Báo Giá'.\n";
    prompt += "    - **(Ưu tiên 7 - Hỏi Địa Chỉ Shop):** ... Kích hoạt 'Luật 7: Trả Lời Địa Chỉ'.\n"; // <--- LUẬT MỚI
    prompt += "    - (Ưu tiên 8 - Chung)...\n";

    prompt += "3.  **Luật Trả Lời (dựa trên Phân tích):**\n";

    // ----- LUẬT MỚI GỬI ẢNH -----
    prompt += "    - **Luật 1: Gửi Ảnh Sản Phẩm:**\n";
    prompt += "      - (Hành động): Khách đang hỏi ảnh Chuột Fuhlen L102. Tra cứu 'KHỐI KIẾN THỨC' để lấy 1 'Image_URL' của Chuột L102.\n";
    prompt += "      - (Trả lời): Trả về JSON có 2 trường: `response_message` (ví dụ: \"Dạ " + greetingName + ", đây là ảnh thật sp L102 'bao phê' bên Shop ạ. | Hàng xịn, switch Omron 10 triệu click, 119k/con, " + salutation + " lấy mấy con ạ?\") VÀ `image_url_to_send` (chuỗi string 1 link ảnh Chuột L102).\n";
    
    prompt += "    - **Luật 2: Ghi Nhận Đơn Hàng:**\n";
    prompt += "      - (Phân tích): Tin nhắn của khách là '" + userMessage + "'. Lịch sử chat là: '" + historyString + "'.\n";
    prompt += "      - (Hành động): Bot phải tự kiểm tra xem 4 thông tin: [Tên], [SĐT], [Địa Chỉ], [Số Lượng] đã đủ chưa (dựa vào tin nhắn MỚI và Lịch sử chat).\n";
    prompt += "      - (Kịch bản 1: Đã ĐỦ): Trả lời: \"Ok " + greetingName + "! Shop đã nhận đủ thông tin...\"\n";
    prompt += "      - (Kịch bản 2: CÒN THIẾU): Trả lời: \"Dạ Shop đã nhận được thông tin của " + salutation + " rồi ạ. | " + salutation + " vui lòng cung cấp nốt [VIẾT TÊN CÁC MỤC CÒN THIẾU] để Shop chốt đơn nhé!...\"\n";
    
    prompt += "    - **Luật 3: Xin lỗi hết hàng:**\n";
    prompt += "      - Trả lời: \"Dạ Shop xin lỗi " + salutation + ", hiện tại Shop chỉ có sẵn sp 'Chuột Fuhlen L102'...\n"; 
    prompt += "    - **Luật 4: Chào Hàng (Giới thiệu Chuột):**\n";
    prompt += "      - Trả lời: \"Chào " + greetingName + ". Shop hiện có Chuột Fuhlen L102 giá siêu tốt 119k...\"\n"; 
    prompt += "    - **Luật 5: Tư Vấn Sâu (Chém Gió):**\n";
    prompt += "      - Trả lời: \"Dạ con này thì 'quốc dân' rồi " + salutation + " ạ! | Nó dùng switch Omron xịn...\"\n"; 
    prompt += "    - **Luật 6: Báo Giá:**\n";
    prompt += "      - Trả lời: \"Dạ, Chuột Fuhlen L102 giá chỉ 119.000đ/con ạ...\"\n"; 
    
    // ----- LUẬT MỚI -----
    prompt += "    - **Luật 7: Trả Lời Địa Chỉ:**\n";
    prompt += "      - Trả lời: \"Dạ " + salutation + ", Kho hàng của Shop ở Hà Đông, Hà Nội ạ. | Còn Tổng công ty thì ở Long Biên, Hà Nội. | " + salutation + " ở đâu Shop cũng ship tận nơi nhé!\"\n";
    
    prompt += "    - **Luật Chung: Khó hiểu:**\n";
    prompt += "      - Trả lời: \"Dạ Shop chưa hiểu ý " + salutation + " lắm. | Shop hiện đang bán Chuột Fuhlen L102 giá 119k...\"\n"; 
    // ----- KẾT THÚC CẬP NHẬT LUẬT -----

    prompt += "    - Tách câu trả lời bằng dấu |\n\n";

    // ----- YÊU CẦU JSON MỚI (1 ẢNH) -----
    prompt += "**YÊU CẦU ĐẦU RA (JSON):**\n";
    prompt += "Bạn PHẢI trả lời dưới dạng một JSON string duy nhất, không có giải thích, không có \\```json ... \\```.\n";
    prompt += "{\n";
    prompt += "  \"response_message\": \"Câu trả lời cho khách | tách bằng dấu |\",\n";
    prompt += "  \"image_url_to_send\": \"link1.jpg\" (Chỉ dùng cho 'Luật 1: Gửi Ảnh SP'. Nếu không, trả về chuỗi rỗng \"\")\n";
    prompt += "}\n";
    // ----------------------------
    
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
        image_url_to_send: geminiJson.image_url_to_send || "" // Sửa trường trả về
    };

  } catch (error) {
    console.error("Lỗi khi gọi Gemini (May Tinh):", error);
    return {
      response_message: "Dạ, Shop đang bận chút, " + salutation + " chờ Shop trong giây lát nhé.",
      image_url_to_send: ""
    };
  }
}


// -------------------------------------------------------------------
// HÀM LẤY TÊN NGƯỜI DÙNG (QUAY LẠI KHÔNG LẤY GENDER)
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
// HÀM MỚI: GỬI HÌNH ẢNH (ĐÃ SỬA LỖI &amp;)
// -------------------------------------------------------------------
async function sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imageUrl) {
  if (!sender_psid || !imageUrl) return;

  // ----- SỬA LỖI &amp; -----
  const safeImageUrl = imageUrl.replace(/&amp;/g, '&');
  // -------------------------

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
      await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ, Shop gửi ảnh bị lỗi. Nhân viên sẽ gửi lại cho Bác/bạn ngay ạ!");
      // Ném lỗi để processMessage biết và dừng lại
      throw new Error("Gửi ảnh thất bại"); 
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
  console.log(`Bot AI ĐA NHÂN CÁCH (v2.14 - Chuan Hoa Qua Tang) đang chạy ở cổng ${PORT}`);
  console.log(`Sẵn sàng nhận lệnh từ Facebook tại /webhook`);
});