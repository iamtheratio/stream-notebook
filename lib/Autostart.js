'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * "Start automatically when I log in", as a dashboard toggle.
 *
 * The manual version of this is Win+R -> shell:startup -> right-drag a shortcut,
 * which is far beyond what this project's audience should ever be asked to do.
 * So we create and delete that shortcut for them.
 *
 * A .lnk needs COM to create, so we shell out to PowerShell's WScript.Shell
 * rather than take a dependency. Windows-only; everything here degrades to
 * "unsupported" elsewhere and the dashboard hides the toggle.
 */

const SHORTCUT_NAME = 'Stream Notebook.lnk';
const APP_DIR = path.join(__dirname, '..');
const BAT = path.join(APP_DIR, 'start.bat');

function startupDir() {
    if (process.platform !== 'win32' || !process.env.APPDATA) return null;
    return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function shortcutPath() {
    const dir = startupDir();
    return dir ? path.join(dir, SHORTCUT_NAME) : null;
}

function supported() {
    return process.platform === 'win32' && !!startupDir() && fs.existsSync(BAT);
}

function isEnabled() {
    const p = shortcutPath();
    return !!p && fs.existsSync(p);
}

function runPowerShell(script) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { windowsHide: true, timeout: 15000 },
            (err, stdout, stderr) => {
                if (err) return reject(new Error((stderr || err.message || '').trim()));
                resolve((stdout || '').trim());
            });
    });
}

async function enable() {
    if (!supported()) throw new Error('Only available on Windows.');
    const dir = startupDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // WindowStyle 7 = minimized, so logging in doesn't throw a console window
    // over whatever they're doing. It still sits in the taskbar, which matters —
    // that window is the only way to stop the notebook.
    const q = s => "'" + String(s).replace(/'/g, "''") + "'";
    await runPowerShell([
        '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(shortcutPath()) + ')',
        '$s.TargetPath = ' + q(BAT),
        '$s.WorkingDirectory = ' + q(APP_DIR),
        '$s.WindowStyle = 7',
        '$s.Description = ' + q('Stream Notebook - on-stream notes from chat'),
        '$s.Save()',
    ].join('; '));

    if (!isEnabled()) throw new Error('The shortcut was not created.');
}

async function disable() {
    const p = shortcutPath();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = { supported, isEnabled, enable, disable, shortcutPath };
