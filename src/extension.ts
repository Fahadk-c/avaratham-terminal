import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|ogg)$/i;

let soundPool: string[] = [];
let lastPlayed: string | null = null;
let lastTriggerTime = 0;

let activePanel: vscode.WebviewPanel | undefined;
let webviewReady = false;
let pendingSrc: string | undefined;
let warnedAboutUnlock = false;

type SystemPlayer = { cmd: string; args: (file: string) => string[] };
// undefined = not probed yet, null = probed and none available
let systemPlayer: SystemPlayer | null | undefined;

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

/* ---------- playback: system audio player ---------- */

function hasCommand(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function powershellScript(file: string): string {
  const escaped = file.replace(/'/g, "''");
  if (/\.wav$/i.test(file)) {
    return `(New-Object Media.SoundPlayer '${escaped}').PlaySync();`;
  }
  // SoundPlayer is WAV-only, so mp3/ogg go through MediaPlayer, which plays
  // asynchronously — sleep for the clip's own length so the process lives long
  // enough to finish it.
  return [
    `Add-Type -AssemblyName presentationCore;`,
    `$p = New-Object System.Windows.Media.MediaPlayer;`,
    `$p.Open([uri]'${escaped}');`,
    `$p.Play();`,
    `Start-Sleep -Milliseconds 400;`,
    `$ms = 5000;`,
    `if ($p.NaturalDuration.HasTimeSpan) { $ms = $p.NaturalDuration.TimeSpan.TotalMilliseconds };`,
    `Start-Sleep -Milliseconds $ms;`
  ].join(' ');
}

function resolveSystemPlayer(): SystemPlayer | null {
  if (systemPlayer !== undefined) return systemPlayer;

  const candidates: SystemPlayer[] =
    process.platform === 'darwin'
      ? [{ cmd: 'afplay', args: (f) => [f] }]
      : process.platform === 'win32'
        ? [{
            cmd: 'powershell',
            args: (f) => ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', powershellScript(f)]
          }]
        : [
            // ffplay first: it is the only one here that handles wav, mp3 and ogg alike.
            { cmd: 'ffplay', args: (f) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', f] },
            { cmd: 'paplay', args: (f) => [f] },
            { cmd: 'play', args: (f) => ['-q', f] },
            { cmd: 'mpg123', args: (f) => ['-q', f] },
            { cmd: 'aplay', args: (f) => ['-q', f] }
          ];

  systemPlayer = candidates.find((c) => hasCommand(c.cmd)) ?? null;
  return systemPlayer;
}

function playViaSystem(context: vscode.ExtensionContext, filePath: string): boolean {
  const player = resolveSystemPlayer();
  if (!player) return false;

  try {
    const child = spawn(player.cmd, player.args(filePath), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {
      // The command resolved but could not actually run — stop trying it and
      // let the webview handle this and every later sound.
      systemPlayer = null;
      if (getConfig().get<string>('playbackMode', 'auto') !== 'system') {
        playViaWebview(context, filePath);
      }
    });
    child.unref();
    return true;
  } catch {
    systemPlayer = null;
    return false;
  }
}

/* ---------- playback: webview fallback ---------- */

function getNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function webviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; media-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body {
      margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
      text-align: center;
    }
    button {
      padding: 10px 16px; font-size: 13px; cursor: pointer; border: none; border-radius: 3px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    #status { margin-top: 10px; opacity: 0.75; }
  </style>
</head>
<body>
  <div>
    <button id="unlock">Enable fail sounds</button>
    <div id="status">Click once to allow audio in this panel.</div>
  </div>
  <audio id="clip"></audio>
  <script nonce="${nonce}">
    const api = acquireVsCodeApi();
    const clip = document.getElementById('clip');
    const unlock = document.getElementById('unlock');
    const status = document.getElementById('status');

    function markUnlocked() {
      unlock.style.display = 'none';
      status.textContent = 'Audio enabled. Leave this tab open.';
    }

    unlock.addEventListener('click', () => {
      // The click itself grants this document sticky user activation, which is
      // what the autoplay policy wants. Replaying the last clip is just feedback.
      markUnlocked();
      if (clip.src) {
        clip.currentTime = 0;
        clip.play().catch((e) => { status.textContent = 'Still blocked: ' + e.message; });
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'play') return;
      clip.src = msg.src;
      clip.currentTime = 0;
      clip.play().then(markUnlocked, (e) => {
        api.postMessage({ type: 'blocked', reason: e.name + ': ' + e.message });
      });
    });

    api.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function playViaWebview(context: vscode.ExtensionContext, filePath: string) {
  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel(
      'malayalamFailSoundPlayer',
      'Fail Sound',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(context.extensionPath),
          vscode.Uri.file(resolveSoundsFolder(context.extensionPath)),
          vscode.Uri.file(path.dirname(filePath))
        ]
      }
    );

    webviewReady = false;
    pendingSrc = undefined;

    activePanel.onDidDispose(() => {
      activePanel = undefined;
      webviewReady = false;
      pendingSrc = undefined;
    });

    activePanel.webview.onDidReceiveMessage((msg: any) => {
      if (msg?.type === 'ready') {
        webviewReady = true;
        if (pendingSrc && activePanel) {
          activePanel.webview.postMessage({ type: 'play', src: pendingSrc });
          pendingSrc = undefined;
        }
      } else if (msg?.type === 'blocked' && !warnedAboutUnlock) {
        warnedAboutUnlock = true;
        vscode.window.showWarningMessage(
          'Malayalam Fail Sounds: click "Enable fail sounds" once in the Fail Sound panel to allow audio playback.'
        );
      }
    });

    activePanel.webview.html = webviewHtml(activePanel.webview);
  }

  const src = activePanel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
  if (webviewReady) {
    activePanel.webview.postMessage({ type: 'play', src });
  } else {
    // The webview script has not signalled readiness yet; send it on 'ready'.
    pendingSrc = src;
  }
}

/* ---------- dispatch ---------- */

function playSound(context: vscode.ExtensionContext, filePath: string) {
  const mode = getConfig().get<string>('playbackMode', 'auto');

  if (mode === 'webview') {
    playViaWebview(context, filePath);
    return;
  }

  if (playViaSystem(context, filePath)) return;

  if (mode === 'system') {
    vscode.window.showWarningMessage(
      'Malayalam Fail Sounds: no system audio player found. Set malayalamFailSounds.playbackMode to "auto" to fall back to the built-in player.'
    );
    return;
  }

  playViaWebview(context, filePath);
}

let warnedInvalidPattern = false;

function isIgnoredFailure(e: vscode.TerminalShellExecutionEndEvent): boolean {
  const config = getConfig();

  const ignoredCodes = config.get<number[]>('ignoredExitCodes', [130]);
  if (e.exitCode !== undefined && ignoredCodes.includes(e.exitCode)) {
    return true;
  }

  const commandLine = e.execution.commandLine?.value?.trim() ?? '';
  if (!commandLine) return false;

  for (const pattern of config.get<string[]>('ignoredCommands', [])) {
    try {
      if (new RegExp(pattern).test(commandLine)) return true;
    } catch {
      // A bad user-supplied regex should not silence every sound; skip it and
      // say so once per session.
      if (!warnedInvalidPattern) {
        warnedInvalidPattern = true;
        vscode.window.showWarningMessage(
          `Malayalam Fail Sounds: ignoring invalid regex in malayalamFailSounds.ignoredCommands: ${pattern}`
        );
      }
    }
  }

  return false;
}

function triggerFailSound(context: vscode.ExtensionContext) {
  if (!getConfig().get<boolean>('enabled', true)) return;

  const cooldownMs = getConfig().get<number>('cooldownMs', 2000);
  const now = Date.now();
  if (now - lastTriggerTime < cooldownMs) return;

  // Re-read the folder each time so clips added or removed while VS Code is
  // running are picked up without a window reload.
  loadSounds(context.extensionPath);

  const sound = pickSound();
  if (!sound) return;

  lastTriggerTime = now;
  playSound(context, sound);
}

export function activate(context: vscode.ExtensionContext) {
  loadSounds(context.extensionPath);

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.exitCode !== undefined && e.exitCode !== 0 && !isIgnoredFailure(e)) {
        triggerFailSound(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('malayalamFailSounds.soundsFolder')) {
        loadSounds(context.extensionPath);
      }
      if (e.affectsConfiguration('malayalamFailSounds.playbackMode')) {
        systemPlayer = undefined; // re-probe on next play
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
      loadSounds(context.extensionPath);
      const sound = pickSound();
      if (sound) {
        playSound(context, sound);
      } else {
        vscode.window.showWarningMessage(
          'No sound files found. Add .mp3/.m4a/.wav files to the sounds/malayalam folder, or set malayalamFailSounds.soundsFolder.'
        );
      }
    })
  );
}

export function deactivate() {
  activePanel?.dispose();
}
