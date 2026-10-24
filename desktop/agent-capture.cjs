function installAgentCapture({ ipcMain, origin, window: getWindow }) {
  let capturing = false;
  ipcMain.handle('rpen-agent-capture', async (event, rect) => {
    try {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw Error('无权截图');
      if (capturing) throw Error('已有截图正在进行');
      if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.width > 16384 || rect.height > 16384) throw Error('截图范围无效');
      const [width, height] = window.getContentSize();
      const zoom = window.webContents.getZoomFactor?.() ?? 1;
      const captureRect = { x: Math.floor(rect.x * zoom), y: Math.floor(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) };
      if (captureRect.x + captureRect.width > width || captureRect.y + captureRect.height > height) throw Error('截图范围超出编辑器窗口');
      capturing = true;
      let image;
      try { image = await window.webContents.capturePage(captureRect); } finally { capturing = false; }
      if (image.isEmpty()) throw Error('截图为空');
      if (image.getSize().width > 1600) image = image.resize({ width: 1600 });
      return { ok: true, image: image.toDataURL() };
    } catch (error) { return { ok: false, message: error.message }; }
  });
}
module.exports = { installAgentCapture };
