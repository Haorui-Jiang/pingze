/**
 * Supabase 前端配置
 *
 * 这个文件故意单独抽出来，不写死在 index.html 里，目的有两个：
 *   1. 可以加进 .gitignore，真实值不会进 Git 仓库
 *   2. 依然保持「零构建」——浏览器直接加载，不需要任何打包步骤
 *
 * 用法：把本文件复制为同目录下的 supabase-config.js，填入真实值。
 *
 * 取值位置：Supabase 后台 → Project Settings → API
 *   · Project URL       → url
 *   · anon / public key → anonKey
 *
 * 关于 anonKey 的安全性：
 *   它是「公开可见」就被设计好的 key，本身不是秘密。
 *   真正保护数据的是表上的 RLS 策略（已按严格隔离配置）。
 *   注意绝对不要把 service_role key 填到这里 —— 那个 key 绕过一切权限，
 *   一旦进了前端就等于把数据库全库开放给所有人。
 */
window.PINGZE_SUPABASE = {
  url: '',
  anonKey: '',
};
