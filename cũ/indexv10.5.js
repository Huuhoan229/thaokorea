// File: index.js (Phiên bản "MULTI-BOT v10.5" - Fix Loi Vision: Anh La Thi Bao Cho Kiem Tra)

// 1. Nạp các thư viện
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');
const nodemailer = require('nodemailer');

// ----- CẤU HÌNH EMAIL -----
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'vngenmart@gmail.com', 
        pass: 'mat_khau_ung_dung_cua_ban' 
    }
});

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

// ----- BỘ MAP TOKEN -----
const pageTokenMap = new Map();

// 1. Page Thảo Korea
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}

// 2. Page Tuyển Sỉ
const PAGE_ID_TUYEN_SI = "833294496542063";
const TOKEN_TUYEN_SI = "EAAP9uXbATjwBQG27LFeffPcNh2cZCjRebBML7ZAHcMGEvu5ZBws5Xq5BdP6F2qVauF5O1UZAKjch5KVHIb4YsDXQiC7hEeJpsn0btLApL58ohSU8iBmcwXUgEprH55hikpj8sw16QAgKbUzYQxny0vZAWb0lM9SvwQ5SH0k6sTpCHD6J7dbtihUJMsZAEWG0NoHzlyzNDAsROHr8xxycL0g5O4DwZDZD";
pageTokenMap.set(PAGE_ID_TUYEN_SI, TOKEN_TUYEN_SI);

console.log(`Bot đã được khởi tạo cho ${pageTokenMap.size} Fanpage.`);

// 4. Khởi tạo Gemini
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    console.log("Đã kết nối với Gemini API (Vision Enabled).");
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

      // Global Pause
      if (fs.existsSync('PAUSE_MODE')) return;

      if (entry.messaging && entry.messaging.length > 0) {
        const webhook_event = entry.messaging[0];
        
        // === 1. XỬ LÝ TIN ADMIN (ECHO) ===
        if (webhook_event.message && webhook_event.message.is_echo) {
            const metadata = webhook_event.message.metadata;
            if (metadata === "FROM_BOT_AUTO") return; 
            
            const adminText = webhook_event.message.text;
            const recipientID = webhook_event.recipient.id; 

            if (adminText && recipientID) {
                const lowerText = adminText.trim().toLowerCase();
                if (lowerText.startsWith('.') || lowerText === 'stop' || lowerText === '!tatbot') {
                    await setBotStatus(pageId, recipientID, true); 
                    console.log(`[ADMIN] TẮT Bot ${recipientID}`);
                }
                else if (lowerText.startsWith(',') || lowerText === 'auto' || lowerText === '.auto' || lowerText === '!batbot') {
                    await setBotStatus(pageId, recipientID, false); 
                    console.log(`[ADMIN] BẬT Bot ${recipientID}`);
                }
                await saveAdminReply(pageId, recipientID, adminText);
            }
            return;
        }
        
        // === 2. XỬ LÝ TIN KHÁCH HÀNG ===
        if (webhook_event.message) {
            const sender_psid = webhook_event.sender.id;

            if (webhook_event.message.sticker_id) return; 
            
            const userState = await loadState(`${pageId}_${sender_psid}`);
            if (userState.is_paused) {
                await saveState(`${pageId}_${sender_psid}`, webhook_event.message.text || "[Khách gửi ảnh/file]", null);
                return;
            }

            let isMissedCall = false;
            if (webhook_event.message.text) {
                const textLower = webhook_event.message.text.toLowerCase();
                if (textLower.includes("bỏ lỡ cuộc gọi") || textLower.includes("missed call") || textLower.includes("gọi lại") || textLower.includes("nghe máy")) {
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

            // Xử lý tin nhắn (Text hoặc Ảnh)
            let userMessage = "";
            let imageUrl = null;

            if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                userMessage = "[Khách gửi hình ảnh]";
                imageUrl = webhook_event.message.attachments[0].payload.url; 
            } else if (webhook_event.message.text) {
                userMessage = webhook_event.message.text;
            }

            if (userMessage) {
                processMessage(pageId, sender_psid, userMessage, imageUrl);
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
    } catch (e) {}
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ GỌI NHỠ
// -------------------------------------------------------------------
async function handleMissedCall(pageId, sender_psid) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;

    let message = "";
    if (pageId === PAGE_ID_TUYEN_SI) {
        message = "Dạ Kho đang bận chút ạ. Anh/Chị để lại Số Điện Thoại để Kho gọi lại tư vấn giá sỉ tốt nhất nhé ạ!";
    } else {
        message = "Dạ Shop thấy Bác vừa gọi nhỡ ạ. Hiện nhân viên đang bận đóng hàng nên chưa nghe kịp máy. Bác cần gấp vui lòng gọi Hotline: 0986.646.845 - 0948.686.946 - 0946.686.474 để được hỗ trợ ngay nhé ạ!";
    }
    
    await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, message);
    await saveState(`${pageId}_${sender_psid}`, "[Khách gọi nhỡ]", message);
}

// -------------------------------------------------------------------
// HÀM GỬI MAIL CẢNH BÁO
// -------------------------------------------------------------------
async function sendAlertEmail(userName, userMessage) {
    const mailOptions = {
        from: 'vngenmart@gmail.com',
        to: 'vngenmart@gmail.com',
        subject: `[CẢNH BÁO] Khách Hàng ${userName} Muốn HỦY ĐƠN!`,
        text: `Khách hàng: ${userName}\nNội dung tin nhắn: "${userMessage}"\n\n-> Hãy vào kiểm tra và cứu đơn ngay!`
    };
    try { await transporter.sendMail(mailOptions); } catch (e) {}
}

// -------------------------------------------------------------------
// HÀM XỬ LÝ CHÍNH
// -------------------------------------------------------------------
async function processMessage(pageId, sender_psid, userMessage, imageUrl = null) {
    const FB_PAGE_TOKEN = pageTokenMap.get(pageId);
    if (!FB_PAGE_TOKEN) return;
    
    const uniqueStorageId = `${pageId}_${sender_psid}`;
    if (processingUserSet.has(uniqueStorageId)) return;
    processingUserSet.add(uniqueStorageId);

    try {
      const userState = await loadState(uniqueStorageId);
      if (userState.is_paused) {
          await saveState(uniqueStorageId, userMessage, null);
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
      let userName = await getFacebookUserName(FB_PAGE_TOKEN, sender_psid);
      
      const lowerMsg = userMessage.toLowerCase();
      if (lowerMsg.includes("hủy đơn") || lowerMsg.includes("không lấy nữa") || lowerMsg.includes("trả hàng") || lowerMsg.includes("bom hàng")) {
          sendAlertEmail(userName, userMessage);
          const retentionMsg = "Dạ Bác ơi, Bác cho Shop hỏi là mình đang gặp vấn đề gì hay muốn thay đổi sản phẩm khác ạ? Bác cho Shop xin chút thông tin để hỗ trợ Bác tốt nhất nhé! | Dạ để Shop kiểm tra lại tình trạng đơn hàng xem đã đi chưa ạ. Bác chờ Shop một lát nhé!";
          await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ Bác ơi, Bác cho Shop hỏi là mình đang gặp vấn đề gì hay muốn thay đổi sản phẩm khác ạ? Bác cho Shop xin chút thông tin để hỗ trợ Bác tốt nhất nhé!");
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sendFacebookMessage(FB_PAGE_TOKEN, sender_psid, "Dạ để Shop kiểm tra lại tình trạng đơn hàng xem đã đi chưa ạ. Bác chờ Shop một lát nhé!");
          await saveState(uniqueStorageId, userMessage, retentionMsg);
          processingUserSet.delete(uniqueStorageId);
          return; 
      }

      let productKnowledge;
      let geminiResult;

      if (pageId === process.env.PAGE_ID_THAO_KOREA || pageId === process.env.PAGE_ID_TRANG_MOI) {
          productKnowledge = getProductKnowledge_ThaoKorea();
          geminiResult = await callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge, imageUrl);
      } 
      else if (pageId === PAGE_ID_TUYEN_SI) {
          productKnowledge = getProductKnowledge_TuyenSiNghe();
          geminiResult = await callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge);
      }
      else {
          processingUserSet.delete(uniqueStorageId);
          return;
      }

      console.log(`[Gemini]: ${geminiResult.response_message}`);

      await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, false);
      await saveState(uniqueStorageId, userMessage, geminiResult.response_message);

      if (geminiResult.image_url_to_send && geminiResult.image_url_to_send.length > 0) {
          const imageUrls = geminiResult.image_url_to_send.split(',').map(url => url.trim()).filter(url => url.length > 0);
          for (const imgUrl of imageUrls) {
              await sendFacebookTyping(FB_PAGE_TOKEN, sender_psid, true);
              await new Promise(resolve => setTimeout(resolve, 500));
              try { await sendFacebookImage(FB_PAGE_TOKEN, sender_psid, imgUrl); } catch (e) {}
          }
      }
      
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
// BỘ NÃO 1: THẢO KOREA (BÁN LẺ)
// =================================================================
function getProductKnowledge_ThaoKorea() {
    let knowledgeString = "**KHỐI KIẾN THỨC SẢN PHẨM (THẢO KOREA):**\n\n";
    knowledgeString += "- Shop CHỈ BÁN ONLINE. Kho Hà Đông, VP Long Biên.\n";
    knowledgeString += "- Hotline gấp: 0986.646.845 - 0948.686.946 - 0946.686.474\n";
    
    knowledgeString += "**CHÍNH SÁCH QUÀ TẶNG (CẤM TẶNG THÊM):**\n";
    knowledgeString += "- **An Cung Samsung/Kwangdong:** Tặng 1 Dầu Lạnh (hoặc Cao Dán).\n";
    knowledgeString += "- **Tinh Dầu Thông Đỏ:** Tặng 1 Cao Dán (hoặc Dầu Lạnh).\n";
    knowledgeString += "- **Cao Hắc Sâm:** Tặng 1 Gói Cao Dán.\n";
    knowledgeString += "- **Nghệ Nano:** Tặng 1 Gói Kẹo Sâm.\n";
    knowledgeString += "- **KHÔNG QUÀ (Dù khách xin cũng từ chối):** Cao Sâm 365, Sâm Nước, Mát Gan, Đạm Sâm, Canxi, Bổ Mắt, Royal.\n\n";
    
    knowledgeString += "**QUY ĐỊNH SHIP:** Tất cả sản phẩm chính đều FREESHIP. Trừ Dầu Nóng & Dầu Lạnh vẫn tính ship.\n\n";

    knowledgeString += "---[DANH SÁCH SẢN PHẨM]---\n";
    knowledgeString += "1. AN CUNG SAMSUNG HỘP GỖ 60 VIÊN (780k) - Freeship - Tặng 1 Dầu/Cao\n";
    knowledgeString += "   - Thành phần: Có Trầm Hương (ít), chủ yếu Ngưu Hoàng.\n";
    knowledgeString += "   - Date: Tháng 10/2027 (Hàng mới). Ảnh Date: \"https://i.ibb.co/yFwbzwGS/z7379237606061-c93c7bafd60a14c6641d71244bc05b4a.jpg\"\n";
    knowledgeString += "   - Image_URL: \"https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg\"\n";
    
    knowledgeString += "2. HỘP CAO HỒNG SÂM 365 (DẠNG CAO SỆT - 240g/LỌ)\n";
    knowledgeString += "   - Hộp 2 Lọ: 470k (Freeship) - KHÔNG QUÀ.\n";
    knowledgeString += "   - Hộp 4 Lọ: 850k (Freeship) - KHÔNG QUÀ.\n";
    knowledgeString += "   - Image_URL (2 Lọ): \"https://ghshop.vn/images/upload/images/Cao-H%E1%BB%93ng-S%C3%A2m-365-H%C3%A0n-Qu%E1%BB%91c-Lo%E1%BA%A1i-2-L%E1%BB%8D.png\"\n";
    knowledgeString += "   - Image_URL (4 Lọ): \"https://thuoc365.vn/wp-content/uploads/2017/12/cao-hong-sam-4.jpg\"\n";

    knowledgeString += "3. HỘP TINH DẦU THÔNG ĐỎ KWANGDONG 120 VIÊN (1.150k) - Freeship - Tặng 1 Cao/Dầu\n";
    knowledgeString += "   - Image_URL: \"https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg\"\n";

    knowledgeString += "7. AN CUNG KWANGDONG 60 VIÊN (1.290k) - Freeship - Tặng 1 Dầu/Cao\n";
    knowledgeString += "   - Thành phần: 15% Trầm Hương (Cao cấp).\n";
    knowledgeString += "   - Image_URL: \"https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg\"\n";
    
    knowledgeString += "8. AN CUNG ROYAL 32 VIÊN (690k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Thành phần: 5% Trầm Hương.\n";
    knowledgeString += "   - Image_URL: \"https://ikute.vn/wp-content/uploads/2022/11/An-cung-nguu-tram-huong-hoan-Royal-Family-Chim-Hyang-Hwan-1-ikute.vn_.jpg\"\n";

    knowledgeString += "13. TINH CHẤT HỒNG SÂM 365 NƯỚC (690k) - HỘP 100 GÓI - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://nhungnheng.com/uploads/shops/2024_04/555439700_24765749976387672_8906127611892730086_n.jpg\"\n";

    knowledgeString += "11. NGHỆ NANO CURCUMIN 365 CARE (990k) - 32 TÉP - Freeship - Tặng 1 Kẹo\n";
    knowledgeString += "   - Image_URL: \"https://scontent.fhan15-2.fna.fbcdn.net/v/t39.30808-6/589158835_122096348745142019_9083802807600819254_n.jpg\"\n";

    knowledgeString += "12. VIÊN ĐẠM SÂM KANA 120 VIÊN (480k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://shopsunflower.vn/wp-content/uploads/2025/07/Dam-Sam-Kana-Hong-Sam-Nhung-Huou-Linh-Chi-Han-Quoc.webp\"\n";

    knowledgeString += "14. VIÊN CANXI SMS BIO PHARM 120 VIÊN (380k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://hanquocgiare.com/wp-content/uploads/2025/09/vien-uong-bo-sung-canxi-sms-bio-pharm-signatune-power-cacium-gold-4.jpg\"\n";

    knowledgeString += "15. VIÊN BỔ MẮT SAMSUNG 120 VIÊN (380k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://hanquocgiare.com/wp-content/uploads/2022/12/vien-uong-bo-mat-han-quoc-samsung-bio-pharm-120-vien-4.jpg\"\n";
    
    knowledgeString += "16. CAO HẮC SÂM TRẦM HƯƠNG HANJEONG 500g (690k) - Freeship - Tặng 1 Cao Dán\n";
    knowledgeString += "   - Image_URL: \"https://huyenviet.com.vn/storage/products/July2025/36bECKNzZcANZO0ba11G.jpg\"\n";

    knowledgeString += "4. NƯỚC HỒNG SÂM NHUNG HƯƠU 30 GÓI (440k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg\"\n";
    
    knowledgeString += "17. NƯỚC SÂM NHUNG HƯƠU 20 GÓI MỚI (360k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"(Gửi ảnh SP 4 tạm)\"\n"; 
    
    knowledgeString += "5. NƯỚC HỒNG SÂM NHUNG HƯƠU 20 GÓI MẪU CŨ (TẠM HẾT HÀNG)\n";
    
    knowledgeString += "6. NƯỚC MÁT GAN SAMSUNG (410k) - Freeship - KHÔNG QUÀ\n";
    knowledgeString += "   - Image_URL: \"https://hueminhkorea.com/wp-content/uploads/2025/02/mat-gan-nghe-dong-trung-tw-han-quoc-3-1.jpg\"\n";
    
    knowledgeString += "9. DẦU NÓNG ANTIPHLAMINE (89k) - VẪN TÍNH SHIP 20k\n";
    knowledgeString += "   - Image_URL: \"https://wowmart.vn/wp-content/uploads/2017/03/dau-nong-xoa-diu-cac-co-xuong-khop-antiphlamine-han-quoc-221024-ka.jpg\"\n";
    
    knowledgeString += "10. DẦU LẠNH GLUCOSAMINE (50k/tuýp) - Mua lẻ từ 2 tuýp (+20k ship). Mua kèm SP khác thì 1 tuýp (Free).\n";
    knowledgeString += "   - Image_URL: \"https://glucosamin.com.vn/storage/uploads/images/dau-lanh-glucosamine.jpg\"\n";
    
    knowledgeString += "99. QUÀ TẶNG: CAO DÁN HỒNG SÂM (20 miếng)\n";
    knowledgeString += "Image_URL: \"https://samyenthinhphat.com/uploads/Images/cao-dan-hong-sam-han-quoc-20-mieng-02.jpg\"\n";
    
    return knowledgeString;
}

async function callGemini_ThaoKorea(userMessage, userName, userState, productKnowledge, imageUrl = null) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Shop'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Bác " + userName : "Bác";

    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const hour = now.getHours();
    let timeContext = (hour >= 8 && hour < 17) ? "GIỜ HÀNH CHÍNH" : "NGOÀI GIỜ";

    let prompt = `**Nhiệm vụ:** Bạn là chuyên viên tư vấn của Shop Thảo Korea. Xưng hô 'Shop' và gọi khách là '${greetingName}'.
    
**LUẬT CẤM (TUÂN THỦ TUYỆT ĐỐI):**
1. CẤM dùng từ 'Admin', 'Bot'. CẤM gửi link text.
2. CẤM bịa quà. CẤM giảm giá. CẤM nói lặp.
3. CẤM dùng ký tự đặc biệt như dấu * để bôi đậm.

**LUẬT XỬ LÝ ẢNH (VISION - QUAN TRỌNG):**
- Nếu khách gửi ảnh sản phẩm **KHÁC VỚI** danh sách của Shop (hoặc ảnh lạ, không rõ):
  -> **TUYỆT ĐỐI KHÔNG TƯ VẤN BỪA.**
  -> **HÀNH ĐỘNG:** Trả lời: "Dạ mẫu này nhìn lạ quá, Bác chờ xíu để Shop kiểm tra lại kho xem có hàng không rồi báo lại Bác ngay nhé ạ!".

**LUẬT TRẢ LỜI DATE:**
- **An Cung Samsung (60v):** "Date 10/2027" + GỬI ẢNH DATE.
- **SP Khác:** "Dạ để Shop kiểm tra kho báo lại Bác sau ạ".

**QUY TRÌNH CHỐT ĐƠN (CHECK SĐT):**
- Bước 1: Soi tin nhắn khách.
- Bước 2: **Chưa có SĐT:** "Dạ vâng, Bác ưng mã này rồi thì cho Shop xin **Số Điện Thoại** và **Địa Chỉ** để nhân viên lên đơn Freeship cho Bác nhé ạ!".
- Bước 3: **Đã có SĐT:** Xác nhận đã nhận số và báo nhân viên gọi lại (Theo giờ HC/Ngoài giờ).

**LUẬT SHIP:** SP Chính: Freeship. Dầu Nóng/Lạnh mua lẻ: Ship 20k.

**NGỮ CẢNH:** ${timeContext}

${productKnowledge}

**Lịch sử chat:**
${historyString}

**Khách nhắn:** "${userMessage}"
${imageUrl ? "[Khách có gửi kèm 1 hình ảnh]" : ""}

**Yêu cầu JSON:**
{
  "response_message": "Câu trả lời text | tách ý bằng dấu |",
  "image_url_to_send": "link1, link2" (Nếu cần gửi ảnh)
}
`;

    // Chuẩn bị dữ liệu gửi lên Gemini
    let parts = [{ text: prompt }];
    
    // Nếu có ảnh, tải ảnh về và gửi lên Gemini
    if (imageUrl) {
        try {
            const imageResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResp.data).toString('base64');
            parts.push({
                inlineData: {
                    data: base64Image,
                    mimeType: "image/jpeg"
                }
            });
        } catch (imgErr) {
            console.error("Lỗi tải ảnh:", imgErr);
        }
    }

    const result = await model.generateContent(parts);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ Bác chờ Shop xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ mạng lag, Bác chờ xíu ạ.", image_url_to_send: "" }; }
}

// ... (Giữ nguyên phần Tuyển Sỉ và Helper Functions)
function getProductKnowledge_TuyenSiNghe() {
    return "**KHỐI KIẾN THỨC (TUYỂN SỈ NGHỆ NANO):**\n\n**MỤC TIÊU:** Xin SĐT để kết bạn Zalo báo giá. KHÔNG báo giá sỉ trên chat.";
}

async function callGemini_TuyenSiNghe(userMessage, userName, userState, productKnowledge) {
  if (!model) return { response_message: "..." };
  try {
    const historyString = userState.history.map(h => `${h.role === 'user' ? 'Khách' : 'Kho'}: ${h.content}`).join('\n');
    const greetingName = userName ? "Anh/Chị " + userName : "Anh/Chị";
    let prompt = `**Nhiệm vụ:** Bạn là Trợ lý Tuyển sỉ Nghệ Nano.\n**LUẬT:** KHÔNG BÁO GIÁ. Mục tiêu: Xin SĐT để Zalo.\n${productKnowledge}\n**Lịch sử:** ${historyString}\n**Khách nhắn:** "${userMessage}"\n**JSON:** { "response_message": "...", "image_url_to_send": "" }`;
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : { response_message: "Dạ bạn chờ kho xíu ạ." };
    return { response_message: json.response_message || "Dạ.", image_url_to_send: json.image_url_to_send || "" };
  } catch (e) { return { response_message: "Dạ hệ thống bận, bạn chờ xíu nhé.", image_url_to_send: "" }; }
}

async function loadState(uniqueStorageId) { 
  if (!db) return { history: [], is_paused: false }; 
  try {
      const doc = await db.collection('users').doc(uniqueStorageId).get();
      if (doc.exists) {
          const data = doc.data();
          return { history: data.history ? data.history.slice(-20) : [], is_paused: data.is_paused || false };
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
  console.log(`Bot v10.5 (Fix Vision Hallucination) chạy tại port ${PORT}`);
});