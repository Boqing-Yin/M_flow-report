import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/M_flow-report/',
  title: "m_flow report",
  description: "这是一份关于m_flow仓库的调研报告",
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      // 这里可以配置顶部导航
    ],

    sidebar: [
      {
        text: '调研报告正文',
        items: [
          { text: '第一章：综述', link: '/report/chapter1' },
          { text: '第二章：架构浅析', link: '/report/chapter2' },
          { text: '第三章：本地部署实践', link: '/report/chapter3' }
        ]
      }
    ]
  }
})