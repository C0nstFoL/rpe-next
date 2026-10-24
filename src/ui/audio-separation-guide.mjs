import { showDialog } from './dialog.mjs';

const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
const steps = (host, title, items) => { host.append(node('h3', title)); const list = node('ol', ''); for (const text of items) list.append(node('li', text)); host.append(list); };

export function showAudioSeparationGuide(desktop) {
  const host = showDialog('声部分离使用指南', '入口：谱面工具 → 音频分析 → 声部与分析音源'); host.classList.add('audio-separation-guide');
  host.closest('dialog').addEventListener('close', () => host.classList.remove('audio-separation-guide'), { once: true });
  if (desktop) steps(host, 'Windows / macOS / Linux 桌面端', [
    '首次点击“一键准备分离环境”，选择 CPU 或 NVIDIA 加速。无需先安装 Python，也不用输入命令；CPU 适用于支持的桌面系统。',
    '等待下载、安装和检查完成。首次使用需要网络及数 GB 可用空间；升级编辑器后会继续使用已安装环境。',
    '选择“四声部”或“六声部”，点击“分离当前音乐”。首次分离下载所选模型，后续使用缓存。',
    '勾选人声、鼓、贝斯等音源，至少保留一项。播放按钮会播放勾选声部的混合，倍速和保调照常生效；不同声部的波形/频谱以各自颜色显示。',
  ]);
  else steps(host, '网页端：导入声部后分析', [
    '目前网页端不直接运行本机 Demucs。最省事的方法是在 RPEN 桌面端分离同一首音乐，再导出需要的声部 WAV。',
    '也可使用已安装的 UVR / Demucs 等工具，选择同一首完整音乐并导出声部。不要裁掉开头静音、变速或另做剪辑。',
    '回到本页面，点击“导入声部”，可一次选择多个音频文件。手机和平板也可从文件应用选择这些结果。',
    '勾选需要播放和分析的一个或多个声部，直接使用编辑器播放按钮。所有文件从原音乐开头对齐，沿用同一谱面延迟，不另设声部起点。',
    '勾选结果同时用于播放、波形、频谱及默认 AI 采音，退出谱面后恢复原音频。网页端无需安装 Python；DDC / Mapperatorinator 本机模型仍需桌面端。',
  ]);
  const other = node('details', ''); other.append(node('summary', desktop ? '网页、手机和平板如何使用？' : '没有桌面电脑怎么办？'));
  other.append(node('p', desktop ? '在桌面端分离后，使用各声部右侧的“导出”保存需要的 WAV，将文件传到另一设备，然后在网页端“导入声部”。原音乐文件保持不变，播放音源的切换只在本次打开谱面有效。' : '当前版本需要先获得外部分离结果：可在另一台电脑处理并传送 WAV，或使用自行信任的分离工具后下载结果。RPEN 网页不会自动将音乐上传到第三方服务。')); host.append(other);
  steps(host, '设备与常见问题', [
    '一键安装面向 Windows x64、Apple 芯片 macOS 和 Linux x64。Intel Mac、ARM Linux、ARM Windows 当前优先使用已有环境或导入外部分离结果。macOS 选择 CPU，NVIDIA 加速用于兼容的 Windows / Linux 显卡。',
    '下载失败：检查网络和磁盘空间，再点一次“一键准备”。已经下载的文件尽量复用；失败不会改动谱面或原音乐。高级设置可选择已有环境或用已有 Python 安装。',
    '四声部为人声、鼓、贝斯、其他。六声部另含吉他、钢琴，但仍可能串音；需要不同模型时可导入外部结果。',
    '分离结果属于当前音乐的分析会话，不写进谱面包。需要保留或跨设备使用时请导出 WAV；本机再次分离相同音乐可复用缓存。',
  ]);
  host.append(node('p', '本机分离不需要 AI API Key，音频不会上传。联网仅用于下载环境、依赖和模型。'));
}
