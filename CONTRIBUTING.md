# 贡献说明

欢迎报告问题和改进建议。提交 Issue 时，请附上 ComfyUI 版本、插件提交号、复现步骤和相关错误；发布日志前请遮盖本机路径、令牌及私人模型名称。

提交代码前请在现有 ComfyUI 环境中验证，并运行 `python test_backend.py` 和 `python test_civitai.py`。前端变更可在安装 Playwright 后运行 `node test_online_ui.cjs`；若使用系统 Chrome，可设置 `CHROME_PATH`。不要提交模型文件、工作流或缓存。
