import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg)$/i;

let soundPool: string[] = [];
let lastPlayed: string | null = null;
let lastTriggerTime = 0;
let activePanel: vscode.WebviewPanel | undefined;

function getConfig() {
  return vscode.workspace.getConfiguration('malayalamFailSounds');
}

function resolveSoundsFolder(extensionPath: string): string {
  const customFolder = getConfig().get<string>('soundsFolder', '').trim();
  if (customFolder && fs.existsSync(customFolder)) {
    return customFolder;
  }
  return path.join(extensionPath, 'sounds', 'malayalam');
}

function loadSounds(extensionPath: string) {
  const dir = resolveSoundsFolder(extensionPath);
  soundPool = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((f) => AUDIO_EXTENSIONS.test(f))
        .map((f) => path.join(dir, f))
    : [];
}

function pickSound(): string | null {
  if (!soundPool.length) return null;
  let options = soundPool;
  if (options.length > 1 && lastPlayed) {
    options = options.filter((f) => f !== lastPlayed);
  }
  const choice = options[Math.floor(Math.random() * options.length)];
  lastPlayed = choice;
  return choice;
}

function getNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function playSound(context: vscode.ExtensionContext, filePath: string) {
  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel(
      'malayalamFailSoundPlayer',
      'Fail Sound',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(filePath)), vscode.Uri.file(context.extensionPath)]
      }
    );
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage((msg: string) => {
      vscode.window.showInformationMessage(`Fail Sound debug: ${msg}`);
    });
  }

  const webview = activePanel.webview;
  const audioUri = webview.asWebviewUri(vscode.Uri.file(filePath));
  const nonce = getNonce();

  webview.html = `<!DOCTYPE html>
    <html>
    <head>
      <meta http-equiv="Content-Security-Policy"
            content="default-src 'none'; media-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    </head>
    <body style="margin:0;background:transparent;">
      <audio id="clip" src="${audioUri}?t=${nonce}"></audio>
      <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const clip = document.getElementById('clip');
        clip.onerror = () => {
          const err = clip.error;
          vscodeApi.postMessage('LOAD FAILED code=' + (err ? err.code : '?') + ' ' + (err ? err.message : ''));
        };
        clip.onplaying = () => vscodeApi.postMessage('PLAYING (audio started)');
        clip.play().then(
          () => vscodeApi.postMessage('play() resolved OK'),
          (e) => vscodeApi.postMessage('play() REJECTED ' + e.name + ': ' + e.message)
        );
      </script>
    </body>
    </html>`;
}

function triggerFailSound(context: vscode.ExtensionContext) {
  if (!getConfig().get<boolean>('enabled', true)) return;

  const cooldownMs = getConfig().get<number>('cooldownMs', 2000);
  const now = Date.now();
  if (now - lastTriggerTime < cooldownMs) return;

  const sound = pickSound();
  if (!sound) return;

  lastTriggerTime = now;
  playSound(context, sound);
}

export function activate(context: vscode.ExtensionContext) {
  loadSounds(context.extensionPath);

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.exitCode !== undefined && e.exitCode !== 0) {
        triggerFailSound(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('malayalamFailSounds.soundsFolder')) {
        loadSounds(context.extensionPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('malayalamFailSounds.toggle', async () => {
      const config = getConfig();
      const current = config.get<boolean>('enabled', true);
      await config.update('enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Malayalam Fail Sounds: ${!current ? 'enabled' : 'disabled'}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('malayalamFailSounds.testSound', () => {
      const sound = pickSound();
      if (sound) {
        playSound(context, sound);
      } else {
        vscode.window.showWarningMessage(
          'No sound files found. Add .mp3/.wav files to the sounds/malayalam folder, or set malayalamFailSounds.soundsFolder.'
        );
      }
    })
  );
}

export function deactivate() {
  activePanel?.dispose();
}
