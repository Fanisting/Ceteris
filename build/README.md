# build/ 打包资源

本目录存放 electron-builder 打包时需要的图标资源。

## 文件

- `icon-source.png`:应用图标原图,1024×1024,圆角外透明。这是唯一要改的文件。由 Nano Banana 2.1 生成后裁切、套圆角蒙版,来历见 `scripts/generate-icon.cjs` 文件头。
- `icon.png`:1024×1024,Linux 与跨平台打包用。
- `icon.ico`:16 / 24 / 32 / 48 / 64 / 128 / 256 共 7 档,exe 和 NSIS 安装器用。
- `icon.svg`:旧的几何图标(海青底、白色 ">"),已不再使用,留作历史参考。

`icon.png`、`icon.ico`、Win11 右键菜单的图标(`native/context-menu/package/assets/`)和
`src/main/tray.ts` 里的托盘位图都是从 `icon-source.png` 缩放出来的,不要手改。

## 换图标

1. 把新原图放到 `build/icon-source.png`(正方形 RGBA PNG,至少 1024px,圆角外透明)。
2. 运行 `npm run generate-icon`。脚本不依赖任何 npm 包,用 Lanczos3 缩放,写出上面列出的
   文件,并改写 `src/main/tray.ts` 的 `TRAY_BITMAP_16` / `TRAY_BITMAP_32`。
