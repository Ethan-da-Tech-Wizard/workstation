'use strict';

const { AppError } = require('./file-transfer.cjs');

class DesktopTransfers {
  constructor(window, powerSaveBlocker) { this.window = window; this.powerSaveBlocker = powerSaveBlocker; this.progress = null; this.controller = null; this.sequence = 0; }

  async run(work) {
    if (this.controller) throw new AppError(409, 'Wait for the current transfer or cancel it first.');
    const controller = this.controller = new AbortController();
    const blocker = this.powerSaveBlocker.start('prevent-app-suspension');
    const onProgress = value => {
      this.progress = { ...value, sequence: ++this.sequence };
      if (!this.window.isDestroyed()) this.window.webContents.send('workstation:progress', this.progress);
    };
    onProgress({ phase: 'preparing', name: 'Preparing transfer…', percent: null });
    try { return await work({ signal: controller.signal, onProgress }); }
    catch (error) {
      if (controller.signal.aborted) throw new AppError(499, 'Transfer canceled.');
      if (error.code === 'ENOSPC') throw new AppError(507, 'The drive ran out of free space. Free some space and try again.');
      throw error;
    } finally {
      this.controller = null; this.progress = null;
      this.powerSaveBlocker.stop(blocker);
      if (!this.window.isDestroyed()) this.window.webContents.send('workstation:progress', { phase: 'idle', sequence: ++this.sequence });
    }
  }

  cancel() { this.controller?.abort(new AppError(499, 'Transfer canceled.')); }
}

module.exports = { DesktopTransfers };
