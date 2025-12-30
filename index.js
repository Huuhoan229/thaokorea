// File: index.js (Phiên bản "MULTI-BOT v12.0" - CMS Edition: Web Admin + Vision AI)

// 1. KHAI BÁO THƯ VIỆN
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

// 2. CẤU HÌNH HỆ THỐNG
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // Mật khẩu Web Admin
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Cấu hình Email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'vngenmart@gmail.com', 
        pass: 'mat_khau_ung_dung_cua_ban' // Thay mã ứng dụng vào đây nếu cần fix cứng
    }
});

// Bộ chống lặp tin nhắn
const processingUserSet = new Set();

// 3. KẾT NỐI FIRESTORE
let db;
try {
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("✅ Đã kết nối Firestore thành công.");
} catch (error) {
    console.error("❌ LỖI FIRESTORE:", error);
    process.exit(1);
}

// 4. KHỞI TẠO GEMINI (MODEL 2.0 FLASH)
let model;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    console.log("✅ Đã kết nối Gemini AI (Vision Ready).");
} catch(error) {
    console.error("❌ LỖI GEMINI:", error);
}

// 5. CẤU HÌNH SERVER & WEB VIEW
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Để đọc dữ liệu từ Form
app.set('view engine', 'ejs'); // Sử dụng EJS làm giao diện
app.set('views', path.join(__dirname, 'views')); // Thư mục chứa file giao diện

// Cấu hình Session (Đăng nhập)
app.use(session({
    secret: 'bot-secret-key-2025',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // Phiên đăng nhập 1 tiếng
}));

// 6. CẤU HÌNH FANPAGE (MAPPING)
const pageTokenMap = new Map();
// Page Thảo Korea
if (process.env.PAGE_ID_THAO_KOREA && process.env.FB_PAGE_TOKEN_THAO_KOREA) {
    pageTokenMap.set(process.env.PAGE_ID_THAO_KOREA, process.env.FB_PAGE_TOKEN_THAO_KOREA);
}
if (process.env.PAGE_ID_TRANG_MOI && process.env.FB_PAGE_TOKEN_TRANG_MOI) {
    pageTokenMap.set(process.env.PAGE_ID_TRANG_MOI, process.env.FB_PAGE_TOKEN_TRANG_MOI);
}
// Page Tuyển Sỉ
const PAGE_ID_TUYEN_SI = "833294496542063";
const TOKEN_TUYEN_SI = "EAAP9uXbATjwBQG27LFeffPcNh2cZCjRebBML7ZAHcMGEvu5ZBws5Xq5BdP6F2qVauF5O1UZAKjch5KVHIb4YsDXQiC7hEeJpsn0btLApL58ohSU8iBmcwXUgEprH55hikpj8sw16QAgKbUzYQxny0vZAWb0lM9SvwQ5SH0k6sTpCHD6J7dbtihUJMsZAEWG0NoHzlyzNDAsROHr8xxycL0g5O4DwZDZD";
pageTokenMap.set(PAGE_ID_TUYEN_SI, TOKEN_TUYEN_SI);


// =================================================================
// PHẦN A: WEB ADMIN ROUTES (XỬ LÝ GIAO DIỆN QUẢN LÝ)
// =================================================================

// Middleware chặn truy cập chưa đăng nhập
function checkAuth(req, res, next) {
    if (req.session.loggedIn) { next(); } else { res.redirect('/login'); }
}

// Trang Đăng Nhập
app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.redirect('/admin');
    } else {
        res.send('<h3>Sai mật khẩu! <a href="/login">Thử lại</a></h3>');
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Trang Dashboard Chính
app.get('/admin', checkAuth, async (req, res) => {
    try {
        // 1. Lấy Luật Chung từ DB
        let rulesDoc = await db.collection('settings').doc('generalRules').get();
        let generalRules = "";
        
        if (rulesDoc.exists) {
            generalRules = rulesDoc.data().content;
        } else {
            // Nếu DB chưa có, lấy mặc định và lưu lại ngay
            generalRules = getDefaultRules();
            await db.collection('settings').doc('generalRules').set({ content: generalRules });
        }

        // 2. Lấy Danh Sách Sản Phẩm từ DB
        let productsSnap = await db.collection('products').get();
        let products = [];
        
        if (productsSnap.empty) {
            // Nếu DB chưa có, lấy danh sách mặc định và lưu lại ngay
            products = getDefaultProducts();
            for (let p of products) {
                await db.collection('products').add(p);
            }
            // Load lại để có ID
            let newSnap = await db.collection('products').get();
            newSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        } else {
            productsSnap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
        }

        res.render('admin', { generalRules, products });
    } catch (e) {
        res.send("Lỗi tải dữ liệu: " + e.message);
    }
});

// Lưu Luật Chung
app.post('/admin/save-rules', checkAuth, async (req, res) => {
    await db.collection('settings').doc('generalRules').set({ content: req.body.generalRules });
    res.redirect('/admin');
});

// Lưu Sản Phẩm (Thêm mới hoặc Sửa)
app.post('/admin/save-product', checkAuth, async (req, res) => {
    const { id, name, price, image, gift, desc } = req.body;
    const data = { name, price, image, gift, desc };
    
    if (id) {
        // Cập nhật
        await db.collection('products').doc(id).update(data);
    } else {
        // Thêm mới
        await db.collection('products').add(data);
    }
    res.redirect('/admin');
});

// Xóa Sản Phẩm
app.post('/admin/delete-product', checkAuth, async (req, res) => {
    await db.collection('products').doc(req.body.id).delete();
    res.redirect('/admin');
});


// =================================================================
// PHẦN B: BOT ENGINE (XỬ LÝ TIN NHẮN FACEBOOK)
// =================================================================

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    let body = req.body;
    if (body.object === 'page' && body.entry) {
        body.entry.forEach(async (entry) => {
            const pageId = entry.id;
            if (fs.existsSync('PAUSE_MODE')) return;

            if (entry.messaging && entry.messaging.length > 0) {
                const webhook_event = entry.messaging[0];
                
                // 1. Xử lý Admin Chat (Bật/Tắt Bot)
                if (webhook_event.message && webhook_event.message.is_echo) {
                    if (webhook_event.message.metadata === "FROM_BOT_AUTO") return;
                    const adminText = webhook_event.message.text;
                    const recipientID = webhook_event.recipient.id;
                    const uid = `${pageId}_${recipientID}`;
                    
                    if (adminText) {
                        const lower = adminText.toLowerCase().trim();
                        if (lower === '.' || lower === '!tatbot') await setBotStatus(uid, true);
                        if (lower === ',' || lower === '!batbot') await setBotStatus(uid, false);
                        await saveHistory(uid, 'Shop', adminText);
                    }
                    return;
                }

                // 2. Xử lý Khách Chat
                if (webhook_event.message) {
                    const senderId = webhook_event.sender.id;
                    const uid = `${pageId}_${senderId}`;
                    
                    // Lọc Sticker
                    if (webhook_event.message.sticker_id) return;

                    const userState = await loadState(uid);
                    
                    // Nếu Bot đang tắt -> Chỉ lưu lịch sử
                    if (userState.is_paused) {
                        await saveHistory(uid, 'Khách', webhook_event.message.text || "[File/Ảnh]");
                        return;
                    }

                    // Check gọi nhỡ
                    if (isMissedCall(webhook_event)) {
                        await handleMissedCall(pageId, senderId);
                        return;
                    }

                    // Xử lý nội dung (Text hoặc Ảnh)
                    let userMessage = "";
                    let imageUrl = null;

                    if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                        userMessage = "[Khách gửi hình ảnh]";
                        imageUrl = webhook_event.message.attachments[0].payload.url;
                    } else if (webhook_event.message.text) {
                        userMessage = webhook_event.message.text;
                    }

                    if (userMessage) {
                        processMessage(pageId, senderId, userMessage, imageUrl, userState);
                    }
                }
            }
        });
    } else { res.sendStatus(404); }
});

// --- HÀM XỬ LÝ CHÍNH ---
async function processMessage(pageId, senderId, userMessage, imageUrl, userState) {
    const token = pageTokenMap.get(pageId);
    if (!token) return;
    
    const uid = `${pageId}_${senderId}`;
    if (processingUserSet.has(uid)) return;
    processingUserSet.add(uid);

    try {
        await sendTyping(token, senderId, true);
        let userName = await getFacebookUserName(token, senderId);

        // Check Hủy đơn
        if (userMessage.toLowerCase().includes("hủy đơn") || userMessage.toLowerCase().includes("bom hàng")) {
            sendAlertEmail(userName, userMessage);
        }

        let geminiResult;

        // --- ROUTER: CHỌN NÃO BOT ---
        if (pageId === PAGE_ID_TUYEN_SI) {
            // Logic Tuyển Sỉ (Đơn giản)
            const knowledge = "**KHỐI KIẾN THỨC (TUYỂN SỈ):** Mục tiêu: Xin SĐT Zalo. Không báo giá sỉ trên chat.";
            geminiResult = await callGeminiSimple(userMessage, userName, userState.history, knowledge);
        } else {
            // Logic Bán Lẻ (Thảo Korea) -> Lấy dữ liệu từ DB (CMS)
            let knowledgeBase = await buildKnowledgeBaseFromDB();
            geminiResult = await callGeminiRetail(userMessage, userName, userState.history, knowledgeBase, imageUrl);
        }

        console.log(`[Bot Reply]: ${geminiResult.response_message}`);
        
        // Lưu lịch sử
        await saveHistory(uid, 'Khách', userMessage);
        await saveHistory(uid, 'Bot', geminiResult.response_message);

        // Gửi Ảnh
        if (geminiResult.image_url_to_send) {
            const imgs = geminiResult.image_url_to_send.split(',');
            for (const img of imgs) {
                if (img.trim()) await sendImage(token, senderId, img.trim());
            }
        }

        // Gửi Text (Tách tin nhắn nếu có dấu |)
        const msgs = geminiResult.response_message.split('|');
        await sendTyping(token, senderId, false);
        for (const msg of msgs) {
            if (msg.trim()) {
                await sendTyping(token, senderId, true);
                await new Promise(r => setTimeout(r, 1000)); // Delay tạo cảm giác thật
                await sendMessage(token, senderId, msg.trim());
            }
        }

    } catch (e) {
        console.error("Lỗi xử lý:", e);
    } finally {
        processingUserSet.delete(uid);
    }
}

// --- HÀM BUILD KIẾN THỨC TỪ DB (GOM LUẬT + SẢN PHẨM) ---
async function buildKnowledgeBaseFromDB() {
    // 1. Lấy Luật Chung
    let rulesDoc = await db.collection('settings').doc('generalRules').get();
    let rules = rulesDoc.exists ? rulesDoc.data().content : getDefaultRules();

    // 2. Lấy Danh Sách Sản Phẩm
    let productsSnap = await db.collection('products').get();
    let productText = "\n=== 🛒 DANH SÁCH SẢN PHẨM & QUÀ TẶNG ===\n";
    
    if (productsSnap.empty) {
        // Fallback nếu DB lỗi
        let defProds = getDefaultProducts();
        defProds.forEach(p => {
            productText += `- ${p.name} | Giá: ${p.price} | Quà: ${p.gift} | Info: ${p.desc}\n`;
        });
    } else {
        productsSnap.forEach(doc => {
            let p = doc.data();
            productText += `- Tên: ${p.name}\n  + Giá: ${p.price}\n  + Quà Tặng: ${p.gift}\n  + Thông tin chi tiết: ${p.desc}\n  + Ảnh minh họa: "${p.image}"\n`;
        });
    }

    return rules + "\n" + productText;
}

// --- HÀM GỌI GEMINI BÁN LẺ (THÔNG MINH + VISION) ---
async function callGeminiRetail(userMessage, userName, history, knowledgeBase, imageUrl = null) {
    if (!model) return { response_message: "Dạ mạng bên Shop đang lag, Bác chờ xíu nha." };
    try {
        const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');
        const greetingName = userName ? "Bác " + userName : "Bác";
        const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
        const timeContext = (now.getHours() >= 8 && now.getHours() < 17) ? "GIỜ HÀNH CHÍNH" : "NGOÀI GIỜ";

        // PROMPT SIÊU CẤP
        let prompt = `**VAI TRÒ:** Bạn là chuyên viên tư vấn cấp cao của Shop Thảo Korea. Bạn đang nói chuyện với khách hàng tên là '${greetingName}'.

**DỮ LIỆU & LUẬT LỆ CỦA SHOP (BẮT BUỘC TUÂN THỦ 100%):**
${knowledgeBase}

**THÔNG TIN NGỮ CẢNH:**
- Thời gian hiện tại: ${timeContext}
- Nếu khách gửi ảnh sản phẩm KHÁC với danh sách trên -> Báo chờ kiểm tra kho (Luật Vision).

**LỊCH SỬ TRÒ CHUYỆN:**
${historyText}

**INPUT CỦA KHÁCH:** "${userMessage}"
${imageUrl ? "[Khách có gửi kèm 1 hình ảnh]" : ""}

**YÊU CẦU OUTPUT (JSON):**
{
  "response_message": "Câu trả lời của bạn (dùng dấu | để tách dòng)",
  "image_url_to_send": "Link ảnh sản phẩm nếu cần gửi (lấy từ dữ liệu)"
}`;

        // Chuẩn bị dữ liệu gửi (Text + Image nếu có)
        let parts = [{ text: prompt }];
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
            } catch (imgErr) { console.error("Lỗi tải ảnh:", imgErr); }
        }

        const result = await model.generateContent(parts);
        const text = result.response.text();
        
        // Parse JSON an toàn
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { response_message: text }; // Fallback nếu AI không trả về JSON
        
        return JSON.parse(jsonMatch[0]);

    } catch (e) {
        console.error("Gemini Error:", e);
        return { response_message: "Dạ Shop đang kiểm tra lại thông tin, Bác chờ xíu nhé.", image_url_to_send: "" };
    }
}

// --- HÀM GỌI GEMINI TUYỂN SỈ (ĐƠN GIẢN) ---
async function callGeminiSimple(userMessage, userName, history, knowledge) {
    // (Giữ nguyên logic cũ cho nhẹ)
    if (!model) return { response_message: "..." };
    const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');
    let prompt = `Vai trò: Trợ lý tuyển sỉ.\n${knowledge}\nLịch sử:\n${historyText}\nKhách: "${userMessage}"\nJSON Output: { "response_message": "..." }`;
    
    try {
        const result = await model.generateContent(prompt);
        const json = JSON.parse(result.response.text().match(/\{[\s\S]*\}/)[0]);
        return json;
    } catch(e) { return { response_message: "Dạ bạn để lại SĐT nhé." }; }
}

// =================================================================
// CÁC HÀM HỖ TRỢ (HELPER FUNCTIONS)
// =================================================================

// 1. Dữ liệu mặc định (Cho lần đầu chạy)
function getDefaultRules() {
    return `**LUẬT CẤM (TUÂN THỦ TUYỆT ĐỐI):**
1. CẤM dùng từ 'Admin', 'Bot'. Xưng hô 'Shop' - 'Bác'.
2. CẤM bịa đặt giá cả, quà tặng không có trong danh sách.
3. CẤM TẶNG THÊM QUÀ nếu khách xin.

**QUY TRÌNH CHỐT ĐƠN & XIN SĐT (CHECK KỸ):**
- Bước 1: Soi tin nhắn xem có dãy số (SĐT) chưa.
- Bước 2: **Nếu CHƯA CÓ SĐT:** "Dạ vâng, Bác ưng mã này rồi thì cho Shop xin **Số Điện Thoại** và **Địa Chỉ** để nhân viên lên đơn Freeship cho Bác nhé ạ!".
- Bước 3: **Nếu ĐÃ CÓ SĐT:**
  + Giờ HC: "Dạ Shop đã nhận SĐT ạ. Nhân viên sẽ gọi lại chốt đơn ngay bây giờ ạ."
  + Ngoài giờ: "Dạ Shop đã nhận SĐT ạ. Nhân viên sẽ gọi lại hỗ trợ Bác sớm nhất (hoặc sáng mai) ạ."

**LUẬT SHIP:**
- SP Chính: FREESHIP (Đã bao gồm trong giá).
- Dầu Nóng/Lạnh mua lẻ: Ship 20k.

**LUẬT DẦU LẠNH (50k):**
- Mua lẻ: Từ 2 tuýp.
- Mua kèm SP khác: Được mua 1 tuýp.

**LUẬT XỬ LÝ ẢNH (VISION):**
- Nếu khách gửi ảnh lạ -> "Dạ mẫu này nhìn lạ quá, Bác chờ xíu để Shop kiểm tra kho rồi báo lại Bác nhé!".`;
}

function getDefaultProducts() {
    return [
        { 
            name: "An Cung Samsung Gỗ 60v", 
            price: "780k", 
            gift: "Tặng 1 Dầu Lạnh/Cao Dán", 
            image: "https://samhanquoconglee.vn/wp-content/uploads/2021/08/an-cung-nguu-hoang-hoan-han-quoc-hop-go-den-loai-60-vien-9.jpg",
            desc: "Thành phần: Có Trầm Hương (ít). Date: 10/2027. Freeship. Gửi ảnh Date khi được hỏi: 'https://i.ibb.co/yFwbzwGS/z7379237606061-c93c7bafd60a14c6641d71244bc05b4a.jpg'" 
        },
        { 
            name: "An Cung Kwangdong 60v", 
            price: "1.290k", 
            gift: "Tặng 1 Dầu Lạnh/Cao Dán", 
            image: "https://nhansamthinhphat.com/storage/uploads/2025/product/images/An-Cung-Nguu/an-cung-kwangdong-hop-60-vien-3.jpg",
            desc: "Thành phần: 15% Trầm Hương (Cao cấp). Freeship." 
        },
        { 
            name: "Tinh Dầu Thông Đỏ 120v", 
            price: "1.150k", 
            gift: "Tặng 1 Cao Dán/Dầu", 
            image: "https://product.hstatic.net/1000260265/product/tinh_dau_thong_do_tai_da_nang_5b875a5a4c114cb09455e328aee71b97_master.jpg",
            desc: "Thanh lọc máu. Freeship." 
        },
        { 
            name: "Cao Hắc Sâm Hanjeong 500g", 
            price: "690k", 
            gift: "Tặng 1 Gói Cao Dán", 
            image: "https://huyenviet.com.vn/storage/products/July2025/36bECKNzZcANZO0ba11G.jpg",
            desc: "Freeship." 
        },
        { 
            name: "Nghệ Nano 365 Care (32 tép)", 
            price: "990k", 
            gift: "Tặng 1 Gói Kẹo Sâm", 
            image: "https://scontent.fhan15-2.fna.fbcdn.net/v/t39.30808-6/589158835_122096348745142019_9083802807600819254_n.jpg",
            desc: "Freeship." 
        },
        { 
            name: "Cao Hồng Sâm 365 (2 lọ)", 
            price: "470k", 
            gift: "KHÔNG CÓ QUÀ", 
            image: "https://ghshop.vn/images/upload/images/Cao-H%E1%BB%93ng-S%C3%A2m-365-H%C3%A0n-Qu%E1%BB%91c-Lo%E1%BA%A1i-2-L%E1%BB%8D.png",
            desc: "Freeship. Tuyệt đối không tặng thêm." 
        },
        { 
            name: "Nước Sâm Nhung Hươu (30 gói)", 
            price: "440k", 
            gift: "KHÔNG CÓ QUÀ", 
            image: "https://samyenthinhphat.com/uploads/Images/sam-nuoc/tinh-chat-hong-sam-nhung-huou-hop-30-goi-006.jpg",
            desc: "Freeship." 
        },
        { 
            name: "Dầu Lạnh Glucosamine", 
            price: "50k/tuýp", 
            gift: "KHÔNG", 
            image: "https://glucosamin.com.vn/storage/uploads/images/dau-lanh-glucosamine.jpg",
            desc: "Mua lẻ từ 2 tuýp. Mua kèm được 1 tuýp. Ship 20k nếu mua lẻ." 
        },
        {
            name: "Dầu Nóng Antiphlamine",
            price: "89k",
            gift: "KHÔNG",
            image: "https://wowmart.vn/wp-content/uploads/2017/03/dau-nong-xoa-diu-cac-co-xuong-khop-antiphlamine-han-quoc-221024-ka.jpg",
            desc: "Ship 20k."
        }
    ];
}

// 2. Các hàm tương tác Database & Facebook
async function setBotStatus(uid, status) { 
    try { await db.collection('users').doc(uid).set({ is_paused: status }, { merge: true }); } catch(e){} 
}
async function loadState(uid) { 
    try { 
        let d = await db.collection('users').doc(uid).get(); 
        return d.exists ? d.data() : { history: [], is_paused: false }; 
    } catch(e){ return { history: [], is_paused: false }; } 
}
async function saveHistory(uid, role, content) { 
    try { 
        await db.collection('users').doc(uid).set({ 
            history: admin.firestore.FieldValue.arrayUnion({ role, content }),
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }); 
    } catch(e){} 
}
function isMissedCall(event) {
    if (event.message.text && event.message.text.toLowerCase().includes("bỏ lỡ cuộc gọi")) return true;
    if (event.message.attachments && event.message.attachments[0].type === 'fallback') return true;
    return false;
}
async function handleMissedCall(pageId, senderId) {
    const token = pageTokenMap.get(pageId);
    if(token) await sendMessage(token, senderId, "Dạ Shop thấy Bác gọi nhỡ. Bác cần gấp vui lòng gọi Hotline 0986.646.845 ạ!");
}
async function sendAlertEmail(name, msg) {
    try { await transporter.sendMail({ from: 'vngenmart@gmail.com', to: 'vngenmart@gmail.com', subject: `KHÁCH ${name} HỦY ĐƠN`, text: msg }); } catch(e){}
}

// 3. Các hàm gửi tin nhắn Facebook
async function sendTyping(token, id, status) { 
    try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, sender_action: status ? "typing_on" : "typing_off" }); } catch(e){} 
}
async function sendMessage(token, id, text) { 
    try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { text, metadata: "FROM_BOT_AUTO" } }); } catch(e){} 
}
async function sendImage(token, id, url) { 
    try { await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id }, message: { attachment: { type: "image", payload: { url, is_reusable: true } }, metadata: "FROM_BOT_AUTO" } }); } catch(e){} 
}
async function getFacebookUserName(token, id) {
    try { const res = await axios.get(`https://graph.facebook.com/${id}?fields=first_name,last_name&access_token=${token}`); return res.data ? res.data.last_name : "Bác"; } catch(e){ return "Bác"; }
}

// 7. KHỞI ĐỘNG SERVER
app.listen(PORT, () => {
    console.log(`🚀 Bot v12.0 (CMS Edition) đang chạy tại port ${PORT}`);
});