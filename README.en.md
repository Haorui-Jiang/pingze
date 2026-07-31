# Pingze Meter & Rhyme Query Station · Zhipu GLM-5.2

[![Node](https://img.shields.io/badge/Node-22%2B-339933)](https://nodejs.org)
[![GLM](https://img.shields.io/badge/LLM-Zhipu%20GLM--5.2-9e2f2f)](https://open.bigmodel.cn)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> Real-time tonal (Pingze) and rhyme analysis powered by the **GLM-5.2 large language model**.
> Reference site: `http://www.zhgc.com/pz/pz.asp`

## ✨ Features

- **Per-character Pingze annotation**: Tonal marks (Ping/green, Ze/red, symbol/gray) aligned character-by-character with the original poem; punctuation and spaces are also reserved as slots.
- **Automatic genre detection**: Identifies forms such as Wuyan Lüshi (five-character regulated verse), Qiyan Jueju (seven-character quatrain), or Ci poetry based on line count, character count, antithesis, and rhyme.
- **Ping Shui Rhyme (平水韵) tracing**: Reports the rhyme category per the Ping Shui Rhyme system (e.g., Shangping Yidong, Xiaping Qiyang).
- **Front-end API key input**: The API key is supplied via a web form field; it is no longer hard-coded on the server side.
- **Visible progress**: The front end shows rotating status hints during analysis so the page never appears frozen.
- **One-click copy**: The complete result can be copied to the clipboard in one action.

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JS (zero dependencies; rice-paper background + Kai typeface + vermilion-red, classical style) |
| Backend | Node.js 22 native `http` + `fetch` |
| LLM | Zhipu GLM-5.2 (`glm-5.2`) |

## 📜 License

MIT — Free to use for learning and further development.
