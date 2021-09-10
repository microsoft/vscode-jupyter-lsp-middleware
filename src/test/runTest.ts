import { spawnSync } from 'child_process';
import * as path from 'path';

import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from 'vscode-test';

const workspacePath = process.env.CODE_TESTS_WORKSPACE
    ? process.env.CODE_TESTS_WORKSPACE
    : path.join(__dirname, '..', '..', 'src', 'test');

const channel = (process.env.VSC_JUPYTER_CI_TEST_VSC_CHANNEL || '').toLowerCase().includes('insiders')
    ? 'insiders'
    : 'stable';

function computePlatform() {
    switch (process.platform) {
        case 'darwin':
            return 'darwin';
        case 'win32':
            return process.arch === 'x32' || process.arch === 'ia32' ? 'win32-archive' : 'win32-x64-archive';
        default:
            return 'linux-x64';
    }
}

/**
 * We use pylance so install python and pylance.
 */
async function installPythonExtension(vscodeExecutablePath: string) {
    console.info('Installing Python Extension');
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    spawnSync(cliPath, ['--install-extension', 'ms-python.python'], {
        encoding: 'utf-8',
        stdio: 'inherit'
    });

    // Make sure pylance is there too as we'll use it for intellisense tests
    console.info('Installing Pylance Extension');
    spawnSync(cliPath, ['--install-extension', 'ms-python.vscode-pylance'], {
        encoding: 'utf-8',
        stdio: 'inherit'
    });
}

async function main() {
    try {
        const platform = computePlatform();
        // Install VS code and python extension. We use pylance to run the tests
        const vscodeExecutablePath = await downloadAndUnzipVSCode(channel, platform);
        await installPythonExtension(vscodeExecutablePath);

        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../../out/test/');

        // The path to the extension test script
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Run the integration tests
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspacePath,
                '--enable-proposed-api',
                '--skip-welcome',
                '--skip-release-notes',
                '--disable-workspace-trust'
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();
