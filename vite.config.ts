import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001, // 前端 dev server
    proxy: {
      '/api': {
        target: 'http://localhost:3001', // 后端 API（与生产部署对齐）
        changeOrigin: true
      }
    }
  }
})
