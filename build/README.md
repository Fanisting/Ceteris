# build/ 打包资源

本目录存放 electron-builder 打包时需要的图标资源。

## 文件

- `icon.svg`:矢量源图,256×256。
- `icon.png`:1024×1024,Linux 与跨平台打包用。
- `icon.ico`:16 / 24 / 32 / 48 / 64 / 128 / 256 共 7 档,exe 和 NSIS 安装器用。

这三个文件都由脚本生成,不要手改。Win11 右键菜单的图标(`native/context-menu/package/assets/`)由同一脚本一并生成。

## 重新生成

```bash
npm run generate-icon
```

脚本不依赖任何 npm 包。要改设计,改 `scripts/generate-icon.cjs` 里的几何和配色,然后同步以下两处:

- `src/renderer/components/icons.tsx` 的 `MarinaMark`(标题栏)
- `src/main/tray.ts` 的 `TRAY_PIXELS`(托盘,16px 像素图)
