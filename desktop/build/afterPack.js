const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
    const appPath = context.appOutDir;

    const remove = [
        path.join(appPath, 'resources', 'app', 'icons'),
        path.join(appPath, 'resources', 'app', 'favicon.ico'),
        path.join(appPath, 'resources', 'app', 'apple-touch-icon.png'),
        path.join(appPath, 'resources', 'app', 'icon-192.png'),
        path.join(appPath, 'resources', 'app', 'icon-512.png'),
    ];

    for (const target of remove) {
        if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
    }

    console.log('afterPack: веб-иконки удалены из desktop-сборки');
};