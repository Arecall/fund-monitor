import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000, // 前端 dev server；后端使用 3001，避免端口冲突
    proxy: {
      '/api': {
        target: 'http://localhost:3001', // 后端 API（与生产部署对齐）
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
            if (id.includes('motion')) {
              return 'vendor-motion';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            if (id.includes('axios') || id.includes('iconv-lite')) {
              return 'vendor-utils';
            }
          }
        }
      }
    }
  }
})
