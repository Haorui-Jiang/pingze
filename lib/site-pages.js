'use strict';
/**
 * lib/site-pages.js —— 站点可收录页面的**单一权威数据源**。
 *
 * 为什么需要它：页面清单原本散落在 tools/smoke-seo.js 的 PAGES 常量里，
 * 生成 sitemap 时若不共用同一份，就会出现「页面加了、sitemap 漏了」或
 * 「sitemap 里有、页面没建 → 404」两类事故（后者会直接损伤搜索引擎对
 * 整站的信任度）。这里统一一份，两个脚本都从这里读。
 *
 * 只登记**已经存在且已上线**的页面。未落地的原型页（P2/P3/P5–P8）不得写进来。
 *
 * 字段说明：
 *   path     对外 URL 的路径部分。必须与 <link rel="canonical"> 完全一致。
 *            ★ 用友好地址（/pingshui-yun），**不要**写物理文件 /pingshui-yun.html。
 *              站点已关闭 Pretty URLs，目录式 /xxx/ 会 404，但 200 重定向给出的
 *              友好地址就是权威地址，写它才能「首跳即 200」。
 *   file     源文件（相对工作区根）。lastmod 取它的 mtime，故必须是真实文件。
 *   main     主关键词（供 smoke-seo 校验）
 *   support  承接词（供 smoke-seo 校验）
 *   h1       页面计划表规定的 H1
 *   changefreq / priority  仅用于 sitemap 的提示性字段（百度会忽略，Google 参考）
 *
 * 与 URL 有关的硬约束（改这里前务必先读）：
 *   - 域名一律用 PRIMARY，即 https://www.pingze.site。
 *     apex（pingze.site）在 Netlify 侧是别名，会 301 到 www；sitemap 里写 apex
 *     等于让爬虫每抓一次多吃一跳重定向，浪费抓取配额。
 *   - admin.html / api / .netlify/functions 一律不得进入本清单（已 noindex）。
 */

/** 主域名（Netlify primary custom domain）。与 tools/check-domain.js 的 PRIMARY_DOMAIN 同义。 */
const SITE = 'https://www.pingze.site';

/**
 * 可收录页面清单（顺序 = sitemap 中的输出顺序，首页在最前）。
 * 新增页面时**只改这里**，然后跑：
 *   node tools/gen-sitemap.js && node tools/smoke-seo.js
 */
const PAGES = [
  {
    path: '/',
    file: '结果/index.html',
    main: '在线平仄检测',
    support: ['诗词格律检测工具', '免费平仄在线查询', '诗词格律检测',
      '格律检测哪个好用', '诗词格律软件哪个好用'],
    h1: '在线平仄格律查询',
    changefreq: 'weekly',
    priority: '1.0',
  },
  {
    path: '/pingshui-yun',
    file: '结果/pingshui-yun.html',
    main: '平水韵查询',
    support: ['平水韵韵部对照表', '平水韵是什么'],
    h1: '平水韵韵部对照表',
    changefreq: 'monthly',
    priority: '0.8',
  },
];

/** 页面 path → 完整 URL */
function urlOf(page) {
  return SITE + page.path;
}

module.exports = { SITE, PAGES, urlOf };
