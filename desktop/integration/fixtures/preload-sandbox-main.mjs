import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
const preload = process.argv[2];
const helper = process.argv[3];
const output = process.argv[4];
app.setPath("userData", process.argv[5]);
app.disableHardwareAcceleration();
let timer;
app
  .whenReady()
  .then(async () => {
    const errors = [];
    const observed = [];
    ipcMain.handle("chat:observe-session", (_event, key) => {
      observed.push(key);
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.on("preload-error", (_event, _filename, error) => {
      errors.push({ name: error.name, message: error.message });
    });
    timer = setTimeout(() => app.exit(2), 15000);
    await win.loadURL("data:text/html,<title>Isolated preload boundary</title>");
    const bridge = await win.webContents.executeJavaScript(`({
    present: typeof window.openclaw !== "undefined",
    observeSession: typeof window.openclaw?.chat?.observeSession,
    onSessionUpdate: typeof window.openclaw?.chat?.onSessionUpdate
  })`);
    let received = null;
    if (bridge.present && !errors.length) {
      await win.webContents.executeJavaScript(`(async () => {
      window.received = [];
      window.stopUpdates = window.openclaw.chat.onSessionUpdate(value => window.received.push(value));
      await window.openclaw.chat.observeSession("agent:main:fixture");
    })()`);
      const { forwardGatewaySessionUpdate } = await import(pathToFileURL(helper).href);
      assert.equal(
        forwardGatewaySessionUpdate(
          {
            event: "session.message",
            payload: {
              sessionKey: "agent:main:fixture",
              message: "PRIVATE TEST BODY",
            },
          },
          (channel, payload) => win.webContents.send(channel, payload),
        ),
        true,
      );
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => window.received.length ? resolve() :
        Date.now() > deadline ? reject(new Error("No update")) : setTimeout(check, 10);
      check();
    })`);
      await win.webContents.executeJavaScript("window.stopUpdates()");
      assert.equal(
        forwardGatewaySessionUpdate(
          {
            event: "session.message",
            payload: {
              sessionKey: "agent:main:fixture",
            },
          },
          (channel, payload) => win.webContents.send(channel, payload),
        ),
        true,
      );
      await win.webContents.executeJavaScript("window.openclaw.chat.observeSession(null)");
      received = await win.webContents.executeJavaScript(
        "new Promise(resolve => setTimeout(() => resolve(window.received), 75))",
      );
    }
    const preferences = win.webContents.getLastWebPreferences();
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          electron: process.versions.electron,
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          preloadSha256: crypto.createHash("sha256").update(fs.readFileSync(preload)).digest("hex"),
          errors,
          bridge,
          observed,
          received,
          fixtureOnly: true,
        },
        null,
        2,
      ) + "\n",
    );
    clearTimeout(timer);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error.message);
    clearTimeout(timer);
    app.exit(1);
  });
