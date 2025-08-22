# Wix Site Mirror

此仓库使用 GitHub Actions 自动抓取并镜像 [Wix 站点](https://cssy2672.wixsite.com/my-site-1)，并发布到 GitHub Pages。

## 部署步骤
1. 建立一个新仓库，例如 `wix-mirror`
2. 将此文件夹内容上传到仓库根目录
3. 在仓库 Settings → Pages 启动 GitHub Pages
4. 访问 `https://你的用户名.github.io/wix-mirror/`

## 工作流程
- 每天凌晨 3 点自动执行一次，抓取最新页面
- 或在 Actions 页面手动触发
- 抓取结果会自动发布到 GitHub Pages
