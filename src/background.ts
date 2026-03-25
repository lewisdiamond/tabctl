interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  windowIndex: number;
  faviconUrl?: string;
  favicon?: string;
}

interface Message {
  type: string;
  payload: unknown;
}

const HOST_NAME = "tabctl";

let port: chrome.runtime.Port | null = null;

function connectToNative(): void {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);

    port.onMessage.addListener(async (response: Message) => {
      console.log("Received from native:", response);

      if (response.type === "focus") {
        const payload = response.payload as { tab_id: number };
        const { windowId } = await chrome.tabs.get(payload.tab_id);
        chrome.tabs
          .update(payload.tab_id, { active: true })
          .then(() => {
            console.log("Focused tab:", payload.tab_id);
            return chrome.windows.getLastFocused();
          })
          .then(async (win) => {
            console.log("Last focused window:", win);
            const ret = await chrome.windows.update(windowId, {
              focused: true,
            });
            console.log(`window update return: ${ret}`);
          })
          .catch((e) => {
            console.error("Failed to focus tab:", e);
          });
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("Native messaging disconnected, reconnecting...");
      port = null;
      setTimeout(connectToNative, 1000);
    });

    console.log("Connected to native messaging host");
  } catch (e) {
    console.error("Failed to connect to native host:", e);
    setTimeout(connectToNative, 1000);
  }
}

function sendNativeMessage(message: Message): void {
  if (port) {
    port.postMessage(message);
  } else {
    console.error("Port not connected, cannot send message");
  }
}

async function getTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return Promise.all(
    tabs
      .sort((a, b) => a.windowId - b.windowId)
      .reduce((acc: Array<TabInfo>, t) => {
        const prev = acc.at(-1);
        let windowIndex = 0;
        if (prev) {
          windowIndex =
            prev.windowId === t.windowId
              ? prev.windowIndex
              : prev.windowIndex + 1;
        }
        const url = (() => {
          try {
            return (t.url && new URL(t.url)) || "N/A";
          } catch (e) {}
          return "N/A";
        })();
        const tab = {
          id: t.id ?? 0,
          title: t.title ?? "",
          url: url === "N/A" ? url : `${url.host}${url.pathname}`,
          active: t.active ?? false,
          windowId: t.windowId ?? 0,
          //faviconUrl: t.favIconUrl,
          windowIndex,
        };
        acc.push(tab);
        return acc;
      }, [] as Array<TabInfo>)
      .map(async (t) => {
        return t;
        //TODO: make this work reliably across browsers if fuzzel's icon support is worth it
        //try {
        //  return {
        //    ...t,
        //    favicon: t.faviconUrl
        //      ? await fetch(t.faviconUrl)
        //          .then((res) => res.blob())
        //          .then((blob) => blobToBase64(blob))
        //      : undefined,
        //  };
        //} catch (e) {
        //  return t;
        //}
      }),
  );
}
function faviconURL(url: string) {
  return `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function syncTabsToHost(): void {
  getTabs()
    .then((tabs) => {
      sendNativeMessage({
        type: "tabs_update",
        payload: tabs,
      });
    })
    .catch((e) => {
      console.error("Failed to get tabs:", e);
    });
}

chrome.tabs.onCreated.addListener(() => {
  syncTabsToHost();
});

chrome.tabs.onRemoved.addListener(() => {
  syncTabsToHost();
});

chrome.tabs.onUpdated.addListener(() => {
  syncTabsToHost();
});

chrome.tabs.onActivated.addListener(() => {
  syncTabsToHost();
});

chrome.runtime.onMessage.addListener(
  (
    request: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void,
  ) => {
    (async () => {
      try {
        if (request.type === "get_tabs") {
          const tabs = await getTabs();
          sendResponse({
            type: "tabs_response",
            payload: tabs,
          });
        } else {
          sendNativeMessage(request);
          sendResponse({ type: "ok", payload: null });
        }
      } catch (e) {
        sendResponse({
          type: "error",
          payload: { message: String(e) },
        });
      }
    })();
    return true;
  },
);

connectToNative();
syncTabsToHost();

async function fetchCommandsFromServer(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return;

    // Check if we have any pending focus commands
    // For now, just re-sync tabs which serves as a heartbeat
    syncTabsToHost();
  } catch (e) {
    // Ignore errors from polling
  }
}
