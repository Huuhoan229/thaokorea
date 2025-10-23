// File: index.js

// 1. Nạp các thư viện
require('dotenv').config(); // Nạp file .env ngay từ đầu
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generativeai');

// 2. Khởi tạo các biến
const app = express();
app.use(express.json()); // Cho phép server đọc JSON

const PORT = process.env.PORT || 3000; // Cổng cho Railway hoặc 3000 ở máy
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 3. Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Dùng 1.5-flash cho nhanh

// -------------------------------------------------------------------
// Endpoint 1: Xác thực Webhook (Facebook sẽ gọi đến đây đầu tiên)
// -------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// -------------------------------------------------------------------
// Endpoint 2: Nhận tin nhắn từ người dùng (Facebook sẽ gọi đến đây)
// -------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  let body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(async (entry) => {
      let webhook_event = entry.messaging[0];
      
      // Lấy ID người gửi (để biết gửi trả lời cho ai)
      let sender_psid = webhook_event.sender.id;
      
      // Lấy nội dung tin nhắn
      if (webhook_event.message && webhook_event.message.text) {
        let userMessage = webhook_event.message.text;

        try {
          // GỌI GEMINI ĐỂ LẤY CÂU TRẢ LỜI
          console.log(`[User]: ${userMessage}`);
          let geminiResponse = await callGemini(userMessage);
          console.log(`[Gemini]: ${geminiResponse}`);
          
          // GỬI CÂU TRẢ LỜI LẠI CHO NGƯỜI DÙNG
          await sendFacebookMessage(sender_psid, geminiResponse);

        } catch (error) {
          console.error("Lỗi xử lý:", error);
          await sendFacebookMessage(sender_psid, "Dạ, Shop xin lỗi, hệ thống đang có chút bận rộn. Bác vui lòng thử lại sau ạ.");
        }
      }
    });

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// -------------------------------------------------------------------
// HÀM GỌI GEMINI (Bộ não AI)
// -------------------------------------------------------------------
async function callGemini(userMessage) {
  try {
    // **QUAN TRỌNG: Đây là "Prompt" (Câu lệnh) cho Gemini**
    const prompt = `Bạn là chatbot chuyên gia tư vấn An Cung Ngưu Hoàng Hoàn Samsung 60 viên.
    Xưng hô với khách là "Bác" và tự xưng là "Shop".
    Khách hàng (độ tuổi 45+) đang hỏi: "${userMessage}"
    
    Hãy trả lời một cách từ tốn, chuyên nghiệp. 
    Nếu câu hỏi phức tạp hoặc cần tư vấn sâu về bệnh lý, hãy khéo léo hướng khách để lại SĐT để Dược sĩ của Shop gọi lại tư vấn kỹ hơn.
    Ví dụ: "Dạ để tư vấn kỹ hơn về trường hợp của Bác, Bác có tiện để lại SĐT không ạ, Dược sĩ bên Shop sẽ gọi lại cho Bác ngay ạ."
    
    Câu trả lời của bạn:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Lỗi khi gọi Gemini API:", error);
    return "Lỗi: Không thể kết nối với AI.";
  }
}

// -------------------------------------------------------------------
// HÀM GỬI TIN NHẮN TRẢ LỜI QUA MESSENGER
// -------------------------------------------------------------------
async function sendFacebookMessage(sender_psid, responseText) {
  const request_body = {
    "recipient": {
      "id": sender_psid
    },
    "message": {
      "text": responseText
    }
  };

  try {
    await axios.post('https://graph.facebook.com/v18.0/me/messages', request_body, {
      params: { "access_token": FB_PAGE_TOKEN }
    });
    console.log(`Đã gửi tin nhắn trả lời tới ID: ${sender_psid}`);
  } catch (error) {
    console.error("Lỗi khi gửi tin nhắn Facebook:", error.response.data.error);
  }
}

// -------------------------------------------------------------------
// 4. Khởi động server
app.listen(PORT, () => {
  console.log(`Bot đang chạy ở cổng ${PORT}`);
});