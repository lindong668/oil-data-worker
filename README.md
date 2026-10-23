# 部署说明

## B6 变更（2026-10-24）— 修复 Workers Builds 预览构建红叉

**根因**：CF 的 Workers Builds 对同一次提交跑两套构建——
生产 `wrangler deploy` 成功（绿），预览 `wrangler preview` 要求
配置中存在 `[previews]` 块，缺失即失败（GitHub 上红叉）。
与 2号 A17、5号 D16 同源。

**本站情况**：wrangler.toml 有 1 个 vars，故补 `[previews.vars]`
并把该变量写入（留空占位，preview-safe）。

**部署**：无增删 → 覆盖上传，实际只需替换 wrangler.toml。
