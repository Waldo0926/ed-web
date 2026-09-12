# ed-web

[English](README.md) · **中文**

在**你自己的浏览器里**抓取、整理、总结 Ed Discussion 的课程论坛。

线上： https://monashed.secureview.tech/app/

## 它不碰你的什么

这个页面是**纯静态**的，没有后端。具体来说：

- 你的 Ed token **只存在你自己的浏览器**（`sessionStorage`，关掉标签页就没了）。
它不会被发送到 monashed.secureview.tech 或任何其他服务器。
- 抓下来的帖子存在你浏览器的 **IndexedDB** 里，同样不上传。
- 页面直接从你的浏览器调 `edstem.org/api/*`。Ed 的 API 返回
`Access-Control-Allow-Origin: *`，所以这样是可行的，中间不需要任何代理。

这个仓库是公开的，就是为了让你能自己核对上面这几条 —— 全文搜 `fetch(` 一共只有两个
去处：`edstem.org` 和相对路径。

## 怎么用

1. 打开 https://monashed.secureview.tech/app/
2. 按页面提示把你的 Ed token 填进去（有两种方式，页面里都写了）
3. 勾选要抓的课程，点「开始抓取」
4. 抓完就能搜索、按分类浏览、看每帖的一句话结论

## 总结是怎么做的

不用 LLM，纯规则：

- 有老师/助教回复的帖子 → 取第一条教职工回复的头一两句，前面标「老师答」
- 没有的话 → 取正文第一句
- 关键词打标签：截止/延期、时间地点变动、成绩发布、考试安排
- 未解答的提问、48 小时内的新帖单独高亮

质量当然不如 AI 写的，但对绝大多数"老师就回了一句 Sure / Up to you"的帖子来说，
这已经够你判断要不要点开了。

## 相关

抓取逻辑与本地版（`ed-digest`，私有）同源。本地版多了 `claude -p` 生成的 AI 摘要
和每日定时任务。
