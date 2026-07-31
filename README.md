# 平仄格律查询站 · 智谱 GLM-5.2

[![Node](https://img.shields.io/badge/Node-22%2B-339933)](https://nodejs.org)
[![GLM](https://img.shields.io/badge/LLM-Zhipu%20GLM--5.2-9e2f2f)](https://open.bigmodel.cn)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](./README.md)		[English](./README.en.md)

> 基于 **GLM-5.2 大模型实时推断** 进行格律平仄分析。
> 参考网站：`http://www.zhgc.com/pz/pz.asp`

## ✨ 功能特性

- **逐字平仄标注**：平（绿）/ 仄（红）/ 符（灰）逐字符对齐原诗，标点与空格也占位。
- **文体自动判定**：依据句数、字数、对仗、押韵给出五言律诗 / 七言绝句 / 词牌 等。
- **《平水韵》韵部溯源**：按平水韵给出韵部（如上平一东、下平七阳）。
- **密钥前端输入**：API Key 由网页输入框提供，服务端不再硬编码。
- **进度可见**：分析等待期间前端轮播提示，不白屏。
- **一键复制**：完整结果可整段复制到剪贴板。

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS（零依赖，宣纸底 + 楷体 + 印泥红 古风） |
| 后端 | Node.js 22 原生 `http` + `fetch` |
| 大模型 | 智谱 GLM-5.2（`glm-5.2`） |

## 📜 许可证

MIT — 可自由用于学习与二次开发。
