# build/ 打包资源

本目录存放 electron-builder 打包时需要的图标资源。

## 文件

- `icon-source.png`:手绘的应用图标原图,1060×1060,圆角外透明。这是唯一要改的文件。
- `icon.png`:1024×1024,Linux 与跨平台打包用。
- `icon.ico`:16 / 24 / 32 / 48 / 64 / 128 / 256 共 7 档,exe 和 NSIS 安装器用。
- `icon.svg`:旧的几何图标(海青底、白色 ">"),已不再使用,留作历史参考。

`icon.png`、`icon.ico` 与 Win11 右键菜单的图标(`native/context-menu/package/assets/`)都是从
`icon-source.png` 缩放出来的,不要手改。

## 换图标

1. 把新原图放到 `build/icon-source.png`(正方形,圆角外透明)。
2. 用任何能写多尺寸 ICO 的工具重新生成上面列出的文件。256 以下的帧用 32 位 DIB,
   256 用 PNG,这是 Windows 图标的传统布局,NSIS 对全 PNG 的 ICO 支持不稳。
3. 同步 `src/main/tray.ts` 里的 `TRAY_BITMAP_16` / `TRAY_BITMAP_32`:16 与 32px 的
   BGRA、alpha 预乘位图,base64 编码。

`scripts/generate-icon.cjs` 画的是旧几何图标,现在只在加 `--legacy` 时运行,免得
`npm run generate-icon` 把这里的文件覆盖回去。
