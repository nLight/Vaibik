'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async context => {
    if (context.electronPlatformName !== 'darwin') return;
    const { productFilename } = context.packager.appInfo;
    const prebuilds = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources',
        'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
    for (const arch of ['arm64', 'x64']) {
        await fs.chmod(path.join(prebuilds, `darwin-${arch}`, 'spawn-helper'), 0o755);
    }
};
