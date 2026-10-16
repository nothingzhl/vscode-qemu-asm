// Actual VS Code profile editor and QuickPick, with the same live guest kept paused.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { connect, freePort, resizeWindow, until, inView } = require('./demos/common.cjs');

async function main() {
  const repository = path.resolve(__dirname, '..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu profiles UI, '));
  const output = path.resolve(
    process.env.QEMU_ASM_PROFILES_SCREENSHOT_DIRECTORY || path.join(repository, '../qemu-profile-screenshots')
  );
  const first = path.join(directory, 'first workspace'),
    second = path.join(directory, 'second workspace');
  const profile = path.join(directory, 'profile'),
    ready = path.join(directory, 'ready.json');
  const clients = [];
  let host,
    hostError,
    finished = false;
  try {
    await Promise.all(
      [first, second, path.join(profile, 'User'), output].map((p) => fs.mkdir(p, { recursive: true }))
    );
    const workspace = path.join(directory, 'profiles.code-workspace');
    await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: first }, { path: second }] }));
    await fs.writeFile(
      path.join(profile, 'User/settings.json'),
      JSON.stringify({
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'workbench.enableExperiments': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'chat.disableAIFeatures': true,
        'window.commandCenter': false,
        'editor.fontSize': 16,
        'editor.minimap.enabled': false,
        'workbench.colorTheme': 'Default Dark Modern'
      })
    );
    const executable =
      process.env.VSCODE_EXECUTABLE_PATH ||
      (await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable'));
    const port = await freePort();
    host = runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: repository,
      extensionTestsPath: path.join(repository, 'test/host/index.cjs'),
      extensionTestsEnv: {
        QEMU_ASM_HOST_PHASE: 'machine-profiles',
        QEMU_ASM_HOST_ROOT: first,
        QEMU_ASM_HOST_OTHER_ROOT: second,
        QEMU_ASM_MACHINE_PROFILES_UI_READY: ready,
        VSCODE_PORTABLE: path.join(directory, 'portable')
      },
      launchArgs: [
        workspace,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--user-data-dir',
        profile,
        '--extensions-dir',
        path.join(directory, 'extensions'),
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1'
      ]
    })
      .catch((error) => {
        hostError = error;
      })
      .finally(() => {
        finished = true;
      });
    const evidence = await until(async () => {
      if (hostError) throw hostError;
      if (finished) throw new Error('Profile host ended before capture');
      try {
        return JSON.parse(await fs.readFile(ready, 'utf8'));
      } catch {
        return false;
      }
    }, 'real selected-profile guest and configuration editor');
    assert(
      evidence.args.includes('64M') && evidence.args.includes('pentium3') && evidence.args.includes('-qmp')
    );
    resizeWindow();
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const workbenchTarget = targets.find((t) => t.type === 'page' && /workbench/i.test(t.url));
    assert(workbenchTarget, 'Actual workbench must be inspectable');
    const workbench = await connect(workbenchTarget.webSocketDebuggerUrl);
    clients.push(workbench);
    await until(() => workbench.evaluate('innerWidth >= 1700 && innerHeight >= 1100'), 'full native window');
    let frame;
    const connected = new Map();
    await until(async () => {
      const current = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      for (const target of current.filter(
        (t) => t.type === 'iframe' && /extensionId=nothingzhl\.vscode-qemu-asm/.test(t.url)
      )) {
        let client = connected.get(target.id);
        if (!client) {
          client = await connect(target.webSocketDebuggerUrl);
          connected.set(target.id, client);
          clients.push(client);
        }
        // The inspector and monitor share an extension ID. Inspect the actual frame,
        // rather than relying on Chromium's target order or selecting a hidden view.
        const candidate = await client.evaluate(
          inView(`(() => {
      const image=d.getElementById('frame');return image&&!image.hidden&&image.naturalWidth>0
        ? {width:image.naturalWidth,height:image.naturalHeight,connected:d.getElementById('status-dot').classList.contains('connected')}:null;
    })()`)
        );
        if (candidate?.connected) {
          frame = candidate;
          return true;
        }
      }
      return false;
    }, 'actual live QEMU display');
    assert(frame.connected);
    const capture = async (name, details) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const image = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const filename = path.join(output, `${name}.png`);
      await fs.writeFile(filename, Buffer.from(image.data, 'base64'));
      await fs.writeFile(
        `${filename}.json`,
        JSON.stringify(
          {
            ...evidence,
            frame,
            ...details,
            sourceOfScreenshot:
              'Actual VS Code profile controls and real paused QEMU; no substituted data or compositing.'
          },
          null,
          2
        )
      );
      console.log(`PASS: actual startup-profile screenshot ${filename}`);
    };
    const editor = await until(
      () =>
        workbench.evaluate(`(() => {
      const text=document.body.innerText;
      return text.includes('qemu-asm.json')&&text.includes('machineProfiles')&&text.includes('memoryMiB')
        ? {text}:null;
    })()`),
      'real project profile JSON editor'
    );
    await capture('machine-profiles-configuration', { editor });
    await fs.writeFile(`${ready}.pick`, 'open the public profile picker');
    const picker = await until(
      () =>
        workbench.evaluate(`(() => {
      const widget=document.querySelector('.quick-input-widget');
      if(!widget||widget.getBoundingClientRect().height===0)return null;
      const text=widget.innerText;
      return text.includes('normal')&&text.includes('small')&&text.includes('64 MiB')
        ? {text}:null;
    })()`),
      'actual startup profile QuickPick'
    );
    await capture('machine-profiles-selection', { picker });
    await workbench.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await workbench.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await fs.writeFile(`${ready}.continue`, 'both actual profile controls captured');
    clients.forEach((client) => client.close());
    clients.length = 0;
    await host;
    if (hostError) throw hostError;
  } finally {
    for (const client of clients) client.close();
    await fs.writeFile(`${ready}.continue`, 'cleanup').catch(() => {});
    await host;
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
