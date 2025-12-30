# Sử dụng Node.js phiên bản mới
FROM node:18

# Tạo thư mục làm việc
WORKDIR /app

# Copy file package.json vào trước
COPY package.json ./

# Cài đặt thư viện (Lệnh này sẽ tự tạo lockfile ảo)
RUN npm install

# Copy toàn bộ code còn lại vào
COPY . .

# Mở cổng 3000
EXPOSE 3000

# Chạy Bot
CMD ["node", "index.js"]