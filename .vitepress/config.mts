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
          { text: '第一章：M-Flow 认知记忆引擎综述', link: '/report/chapter1' },
          { text: '第二章：M_flow 架构总括', link: '/report/chapter2' },
          { text: '第三章：Pipeline 与 Stage 机制', link: '/report/chapter3' },
          { text: '第四章：add 指令调用链路', link: '/report/chapter4' },
          { text: '第五章：memorize 指令执行逻辑', link: '/report/chapter5' },
          { text: '第六章：记忆存储结构', link: '/report/chapter6' },
          { text: '第七章：搜索流程', link: '/report/chapter7' },
          { text: '第八章：本地部署情况报告', link: '/report/chapter8' },
          { text: '第九章：记忆存储结构实例分析', link: '/report/chapter9' }
        ]
      }
    ]
  }
})