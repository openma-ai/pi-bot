import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MacosVirtualDisplayHost } from '../src/daemon/macos-virtual-display.ts';
import { MacosHelperClient } from '../src/daemon/macos-helper-client.ts';
import { probeMacosNativeCapabilities } from '../src/daemon/macos-computer-use.ts';
import { discoverMacosComputerUse } from '../src/pi/macos-computer-use.ts';

const EVID = join(process.env.HOME!, 'pi-vd-evidence');
mkdirSync(EVID, { recursive: true });
const log: string[] = [];
const say = (...a: any[]) => { const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(line); log.push(line); };

function saveJpeg(name: string, b64: string, meta?: any) {
  writeFileSync(join(EVID, `${name}.jpg`), Buffer.from(b64, 'base64'));
  say('saved', name, meta ?? '');
}

async function findTextEdit(helper: MacosHelperClient) {
  const roots: any = await helper.listRoots();
  const apps = Array.isArray(roots) ? roots : (roots.roots ?? roots.apps ?? []);
  const te = apps.find((a: any) => /TextEdit/i.test(a.name ?? a.bundleId ?? a.title ?? '') || /com\.apple\.TextEdit/i.test(a.bundleId ?? ''));
  if (!te) throw new Error('TextEdit not in listRoots');
  const pid = te.pid ?? te.processIdentifier;
  const winsRaw: any = await helper.listWindows(pid);
  const wins: any[] = Array.isArray(winsRaw) ? winsRaw : (winsRaw.windows ?? []);
  return { pid, wins };
}

async function main() {
  const pkgCwd = join(process.env.HOME!, 'pi-computer-use-pkg');
  const discovery = discoverMacosComputerUse({ platform: 'darwin', cwd: pkgCwd, home: process.env.HOME });
  say('discovery', discovery);
  const caps = await probeMacosNativeCapabilities({ platform: 'darwin', discovery });
  writeFileSync(join(EVID, '50-daemon-probe-caps.json'), JSON.stringify(caps, null, 2));
  say('caps', { computerUse: caps.computerUse, screenCapture: caps.screenCapture, canOpenView: caps.canOpenView, vnc: caps.vnc });

  const helper = new MacosHelperClient();
  const perms = await helper.checkPermissions();
  writeFileSync(join(EVID, '50-daemon-perms.json'), JSON.stringify(perms, null, 2));
  say('perms', perms);

  const host = new MacosVirtualDisplayHost();
  say('binary', host.binaryPath);
  say('status-before', host.status);

  const companion = await host.ensureCompanion();
  say('companion', companion);
  say('status-after-ensure', host.status);

  const ba = await host.bind('bot-a');
  const bb = await host.bind('bot-b');
  writeFileSync(join(EVID, '50-daemon-bindings.json'), JSON.stringify({ ba, bb, status: host.status }, null, 2));
  say('bindings', { ba: { x: ba.x, y: ba.y, w: ba.width, h: ba.height, screen: ba.screen }, bb: { x: bb.x, y: bb.y, w: bb.width, h: bb.height, screen: bb.screen } });

  const before = await helper.captureDisplay(0, 1280);
  saveJpeg('50-main-before', before.image.jpegBase64, { w: before.image.width, h: before.image.height, displays: before.displays });
  saveJpeg('51-companion-before', (await host.captureTile('bot-a', 1600)).image.jpegBase64, {});

  const { pid, wins } = await findTextEdit(helper);
  say('textedit', { pid, titles: wins.map((w: any) => ({ title: w.title, frame: w.framePoints })) });
  let winA = wins.find((w: any) => /bot-a/i.test(w.title ?? '')) ?? wins[0];
  let winB = wins.find((w: any) => /bot-b/i.test(w.title ?? '')) ?? wins[1];
  if (!winA || !winB) throw new Error('need two TextEdit windows');

  await host.confineWindow('bot-a', pid, winA);
  const again = await findTextEdit(helper);
  winB = again.wins.find((w: any) => /bot-b/i.test(w.title ?? '')) ?? again.wins.find((w: any) => w.windowId !== winA.windowId) ?? winB;
  await host.confineWindow('bot-b', pid, winB);

  saveJpeg('52-companion-tiled', (await host.captureTile('bot-a', 1600)).image.jpegBase64, {});
  saveJpeg('53-main-after-tile', (await helper.captureDisplay(0, 1280)).image.jpegBase64, {});

  const tileA = host.tileFrame('bot-a');
  await host.clickInTile('bot-a', tileA.w / 2, 200);
  const marker = `DAEMON_E2E_A_${Date.now()}`;
  await host.typeInTile('bot-a', marker);
  saveJpeg('54-companion-typed-A', (await host.captureTile('bot-a', 1600)).image.jpegBase64, { marker });
  saveJpeg('55-main-after-type', (await helper.captureDisplay(0, 1280)).image.jpegBase64, {});

  writeFileSync(join(EVID, '50-daemon-marker.json'), JSON.stringify({ marker, companion, status: host.status }, null, 2));
  host.release('bot-a');
  host.release('bot-b');
  say('status-after-release', host.status);
  const afterRelease = await helper.captureDisplay(0, 64);
  writeFileSync(join(EVID, '50-displays-after-release.json'), JSON.stringify(afterRelease.displays, null, 2));
  say('displays-after-release', afterRelease.displays);
  writeFileSync(join(EVID, 'e2e-daemon-host.log'), log.join('\n'));
  say('DONE', marker);
}
main().catch(err => { console.error(err); writeFileSync(join(EVID, 'e2e-daemon-host.log'), log.concat([String(err?.stack || err)]).join('\n')); process.exit(1); });
