// Floating Recorder Toolbar - FINAL COMPLETE (SPA persistence + reports + safe selectors)
(function () {
  if (window.__floating_recorder_loaded__) return;
  window.__floating_recorder_loaded__ = true;
  console.log("Floating Recorder loaded (FINAL COMPLETE)");

  // State
  let recording = false;
  let events = [];
  let initialUrl = location.href;

  // -----------------------
  // SPA navigation detector
  // -----------------------
  (function setupSpaDetector() {
    let lastUrl = location.href;
    // patch history APIs
    const _push = history.pushState;
    history.pushState = function () {
      _push.apply(this, arguments);
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        window.dispatchEvent(new Event("recorder:navigation"));
      }
    };
    const _replace = history.replaceState;
    history.replaceState = function () {
      _replace.apply(this, arguments);
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        window.dispatchEvent(new Event("recorder:navigation"));
      }
    };
    // fallback mutation observer for some SPAs
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        window.dispatchEvent(new Event("recorder:navigation"));
      }
    }).observe(document, { subtree: true, childList: true });
  })();

  // -----------------------------
  // Utilities
  // -----------------------------
  function isHidden(el) {
    if (!el) return true;
    if (el.type === "hidden") return true;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return true;
    const s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden" || s.opacity === "0";
  }

  function getBestSelector(el) {
    if (!el) return null;
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      if (el.getAttribute && el.getAttribute("name"))
        return `[name="${CSS.escape(el.getAttribute("name"))}"]`;
      if (el.getAttribute && el.getAttribute("data-testid"))
        return `[data-testid="${CSS.escape(el.getAttribute("data-testid"))}"]`;

      if (el.className && typeof el.className === "string") {
        const classes = el.className
          .trim()
          .split(/\s+/)
          .slice(0, 3)
          .map((c) => CSS.escape(c))
          .join(".");
        if (classes) return "." + classes;
      }

      const p = el.parentElement;
      if (p) {
        const idx = Array.from(p.children).indexOf(el) + 1;
        return `${p.tagName.toLowerCase()} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
      }
    } catch (e) {}
    return el.tagName ? el.tagName.toLowerCase() : null;
  }

  function describe(el) {
    return {
      tag: el?.tagName?.toLowerCase(),
      type: el?.getAttribute?.("type") || null,
      selector: getBestSelector(el),
      hidden: isHidden(el),
    };
  }

  // -----------------------------
  // Persistence helpers
  // -----------------------------
  function saveStateToStorage() {
    try {
      chrome.storage.local.set({
        recorder_state: {
          recording: recording,
          events: events,
          initialUrl: initialUrl,
        },
      });
    } catch (e) {
      console.warn("Storage save failed", e);
    }
  }

  function clearStateFromStorage() {
    try {
      chrome.storage.local.remove("recorder_state");
    } catch (e) {}
  }

  function loadStateFromStorage(cb) {
    try {
      chrome.storage.local.get("recorder_state", (data) => {
        const s = data?.recorder_state;
        if (s) {
          recording = !!s.recording;
          events = s.events || [];
          initialUrl = s.initialUrl || initialUrl;
        }
        if (cb) cb(s);
      });
    } catch (e) {
      if (cb) cb(null);
    }
  }

  // -----------------------------
  // Build toolbar (but only after we read storage)
  // -----------------------------
  function buildToolbar() {
    // if exists, return element
    const existing = document.getElementById("__floating_recorder_toolbar__");
    if (existing) return existing;

    const container = document.createElement("div");
    container.id = "__floating_recorder_toolbar__";

    const css = document.createElement("style");
    css.textContent = `
      #__floating_recorder_toolbar__ {
        position: fixed; left: 12px; top: 80px; width: 360px;
        z-index: 2147483647; background: #fff; border:1px solid #ccc;
        box-shadow:0 6px 18px rgba(0,0,0,0.12); padding:10px;
        font-family: Arial, sans-serif; border-radius:6px;
      }
      #__floating_recorder_toolbar__ h4{ margin:0 0 8px 0; font-size:16px }
      #__floating_recorder_toolbar__ button{ width:48%; padding:8px; margin:4px 1% }
      #__floating_recorder_toolbar__ select, #__floating_recorder_toolbar__ textarea { width:100%; box-sizing:border-box }
      #__floating_recorder_toolbar__ textarea { height:220px; margin-top:8px; font-family:monospace; white-space:pre }
      #__floating_recorder_toolbar__ .close-btn { position:absolute; right:6px; top:6px; background:transparent; border:0; font-weight:bold; cursor:pointer; font-size:20px }
      #__floating_recorder_toolbar__ label{ display:block; margin-top:6px; font-size:12px }
      #__floating_recorder_toolbar__ .footer{ display:flex; gap:6px; margin-top:8px }
    `;
    document.head.appendChild(css);

    container.innerHTML = `
      <button class="close-btn" title="Close">×</button>
      <h4>Recorder</h4>
      <div class="controls">
        <button id="rec_start">Start Recording</button>
        <button id="rec_stop" disabled>Stop Recording</button>
      </div>
      <label>Format:</label>
      <select id="rec_format">
        <option value="selenium">Selenium (Python)</option>
        <option value="pw-python">Playwright (Python)</option>
        <option value="pw-js">Playwright (JS)</option>
        <option value="cypress">Cypress (JS)</option>
      </select>
      <div class="footer">
        <button id="rec_generate" disabled>Generate</button>
        <button id="rec_download" disabled>Download</button>
        <button id="rec_report" disabled>Download Report</button>
      </div>
      <textarea id="rec_output" placeholder="Generated script appears here..."></textarea>
    `;
    // attach to documentElement so SPA DOM replaces won't remove head/styles easily
    document.documentElement.appendChild(container);
    return container;
  }

  // -----------------------------
  // Selector / quoting helpers
  // -----------------------------
  function safe(v) {
    return (v || "").replace(/"/g, '\\"');
  }
  function py(sel) {
    if (!sel) return "''";
    return "'" + sel.replace(/'/g, "\\'") + "'";
  }

  // -----------------------------
  // Normalizer and generators
  // -----------------------------
  function normalizeEvents(list) {
    const steps = [];
    let typing = null;
    let lastSelector = null;
    let prevUrl = list.length ? list[0].url : initialUrl;

    function flush() {
      if (typing) {
        steps.push({ action: "type", target: typing.selector, value: typing.value, ts: typing.ts, page: typing.url });
        typing = null;
      }
    }

    for (const e of list) {
      if (!e.selector) continue;
      if (e.url && e.url !== prevUrl) {
        steps.push({ action: "page_wait", page: e.url, ts: e.ts });
        prevUrl = e.url;
        lastSelector = null;
      }

      if (e.kind === "input") {
        typing = { selector: e.selector, value: e.value, ts: e.ts, url: e.url };
      } else if (e.kind === "click") {
        flush();
        if (lastSelector !== e.selector) {
          steps.push({ action: "click", target: e.selector, ts: e.ts, page: e.url });
          lastSelector = e.selector;
        }
      }
    }
    flush();
    return steps;
  }

  function generateScriptText(format) {
    const steps = normalizeEvents(events || []);
    const startUrl = initialUrl || location.href;

    if (format === "selenium") {
      let code = `
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time

driver = webdriver.Chrome()
driver.maximize_window()
wait = WebDriverWait(driver, 15)
driver.get(${py(startUrl)})

`;
      for (const s of steps) {
        if (s.action === "page_wait") {
          code += `
wait.until(lambda d: d.execute_script("return document.readyState") == "complete")
time.sleep(0.2)

`;
        }
        if (s.action === "click") {
          code += `wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, ${py(s.target)}))).click()
time.sleep(0.3)

`;
        }
        if (s.action === "type") {
          code += `wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ${py(s.target)}))).send_keys("${safe(s.value)}")
time.sleep(0.3)

`;
        }
      }
      code += `print("Done!")\ndriver.quit()`;
      return code;
    }

    // Playwright Python
    if (format === "pw-python") {
      let code = `
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        page.goto(${py(startUrl)})

`;
      for (const s of steps) {
        if (s.action === "page_wait") code += `        page.wait_for_load_state("load")\n`;
        if (s.action === "click") code += `        page.click(${py(s.target)})\n`;
        if (s.action === "type") code += `        page.fill(${py(s.target)}, "${safe(s.value)}")\n`;
      }
      code += `
        browser.close()

if __name__ == "__main__":
    run()
`;
      return code;
    }

    // Playwright JS
    if (format === "pw-js") {
      let code = `
const { chromium } = require("playwright");

(async()=>{
  const browser = await chromium.launch({ headless:false });
  const page = await browser.newPage();
  await page.goto(${py(startUrl)});
`;
      for (const s of steps) {
        if (s.action === "page_wait") code += `  await page.waitForLoadState("load");\n`;
        if (s.action === "click") code += `  await page.click(${py(s.target)});\n`;
        if (s.action === "type") code += `  await page.fill(${py(s.target)}, "${safe(s.value)}");\n`;
      }
      code += `
  await browser.close();
})();
`;
      return code;
    }

    // Cypress
    if (format === "cypress") {
      let code = `
describe("Recorded Test", ()=>{ 
  it("runs", ()=>{
    cy.visit(${py(startUrl)})
`;
      for (const s of steps) {
        if (s.action === "page_wait") code += `    cy.document().its("readyState").should("eq","complete")\n`;
        if (s.action === "click") code += `    cy.get(${py(s.target)}).click()\n`;
        if (s.action === "type") code += `    cy.get(${py(s.target)}).type("${safe(s.value)}")\n`;
      }
      code += `
  });
});
`;
      return code;
    }

    return "";
  }

  // -----------------------------
  // Report builder (HTML)
  // -----------------------------
  function buildReportHtml(steps, meta) {
    const start = meta.startedAt || new Date().toISOString();
    const end = meta.endedAt || new Date().toISOString();
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const clicks = steps.filter((s) => s.action === "click").length;
    const types = steps.filter((s) => s.action === "type").length;
    const pagesVisited = Array.from(new Set(steps.map((s) => s.page || meta.initialUrl))).length;

    const rows = steps
      .map((st, i) => {
        const when = st.ts ? new Date(st.ts).toLocaleString() : "";
        const page = esc(st.page || meta.initialUrl || "");
        if (st.action === "click") {
          return `<tr>
    <td>${i + 1}</td>
    <td>Click</td>
    <td><code>${esc(st.target)}</code></td>
    <td>-</td>
    <td>${when}</td>
    <td>${page}</td>
  </tr>`;
        } else if (st.action === "type") {
          return `<tr>
    <td>${i + 1}</td>
    <td>Type</td>
    <td><code>${esc(st.target)}</code></td>
    <td><code>${esc(st.value)}</code></td>
    <td>${when}</td>
    <td>${page}</td>
  </tr>`;
        } else if (st.action === "page_wait") {
          return `<tr>
    <td>${i + 1}</td>
    <td>Navigation / Wait</td>
    <td>-</td>
    <td>-</td>
    <td>${when}</td>
    <td>${page}</td>
  </tr>`;
        } else {
          return `<tr>
    <td>${i + 1}</td>
    <td>${esc(st.action)}</td>
    <td><code>${esc(st.target || "-")}</code></td>
    <td><code>${esc(st.value || "-")}</code></td>
    <td>${when}</td>
    <td>${page}</td>
  </tr>`;
        }
      })
      .join("\n");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Automation Report</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222}
  h1{font-size:20px;margin-bottom:6px}
  .meta{margin-bottom:12px;color:#444}
  .meta div{margin:4px 0}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  table thead th{background:#f4f6f8;padding:8px;text-align:left;border-bottom:1px solid #ddd}
  table tbody td{padding:8px;border-bottom:1px solid #eee;font-size:13px}
  code{background:#f7f7f7;padding:2px 6px;border-radius:4px;font-family:monospace}
  .summary{margin-top:12px;padding:8px;border:1px solid #eee;background:#fafafa}
  .actions{margin-top:12px}
  .actions a{display:inline-block;padding:8px 12px;background:#1976d2;color:#fff;border-radius:5px;text-decoration:none;margin-right:6px}
</style>
</head>
<body>
  <h1>Automation Report</h1>
  <div class="meta">
    <div><strong>Started:</strong> ${esc(start)}</div>
    <div><strong>Ended:</strong> ${esc(end)}</div>
    <div><strong>Start URL:</strong> <code>${esc(meta.initialUrl || "")}</code></div>
  </div>

  <div class="summary">
    <strong>Summary:</strong>
    <div>Steps recorded: ${steps.length} • Clicks: ${clicks} • Types: ${types} • Pages visited: ${pagesVisited}</div>
  </div>

  <table>
    <thead>
      <tr><th>#</th><th>Action</th><th>Selector</th><th>Value</th><th>Timestamp</th><th>Page URL</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="actions">
    <a id="openPreview" href="#" onclick="return false;">Open in new tab</a>
    <a id="downloadFile" href="#" onclick="return false;">Download HTML</a>
  </div>

<script>
  document.getElementById('openPreview').addEventListener('click', function(){
    var w = window.open();
    w.document.write(document.documentElement.outerHTML);
    w.document.close();
  });
  document.getElementById('downloadFile').addEventListener('click', function(){
    var blob = new Blob([document.documentElement.outerHTML], {type: 'text/html'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'automation_report.html';
    document.body.appendChild(a);
    a.click(); a.remove(); URL.revokeObjectURL(url);
  });
</script>

</body>
</html>`;
    return html;
  }

  function downloadHtmlReport(steps, meta) {
    const html = buildReportHtml(steps, meta);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "automation_report.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openHtmlReportInTab(steps, meta) {
    const html = buildReportHtml(steps, meta);
    const w = window.open();
    w.document.write(html);
    w.document.close();
  }

  // -----------------------------
  // Attach UI and wire handlers AFTER loading storage
  // -----------------------------
  loadStateFromStorage(function () {
    const toolbar = buildToolbar();
    const startBtn = toolbar.querySelector("#rec_start");
    const stopBtn = toolbar.querySelector("#rec_stop");
    const genBtn = toolbar.querySelector("#rec_generate");
    const dlBtn = toolbar.querySelector("#rec_download");
    const repBtn = toolbar.querySelector("#rec_report");
    const fmt = toolbar.querySelector("#rec_format");
    const out = toolbar.querySelector("#rec_output");

    // restore UI according to current state
    function restoreUI() {
      if (recording) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        genBtn.disabled = true;
        dlBtn.disabled = true;
        repBtn.disabled = true;
        out.value = "Recording...";
      } else {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        genBtn.disabled = events.length === 0;
        dlBtn.disabled = false && out.value;
        repBtn.disabled = events.length === 0;
      }
    }
    restoreUI();

    // ignore toolbar interactions
    toolbar.querySelector(".close-btn").onclick = function () {
      toolbar.style.display = "none";
    };

    // event handlers
    function onClick(e) {
      if (!recording) return;
      if (e.target.closest("#__floating_recorder_toolbar__")) return;
      const d = describe(e.target);
      if (!d.selector || d.hidden) return;
      const ev = {
        kind: "click",
        selector: d.selector,
        text: (e.target.innerText || "").trim(),
        ts: Date.now(),
        url: location.href,
      };
      events.push(ev);
      saveStateToStorage();
    }
    function onInput(e) {
      if (!recording) return;
      if (e.target.closest("#__floating_recorder_toolbar__")) return;
      const d = describe(e.target);
      if (!d.selector || d.hidden) return;
      const ev = {
        kind: "input",
        selector: d.selector,
        value: e.target.value,
        ts: Date.now(),
        url: location.href,
      };
      events.push(ev);
      saveStateToStorage();
    }

    // Start
    startBtn.onclick = function () {
      recording = true;
      events = [];
      initialUrl = location.href;
      saveStateToStorage();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      genBtn.disabled = true;
      dlBtn.disabled = true;
      repBtn.disabled = true;
      out.value = "Recording...";
      document.addEventListener("click", onClick, true);
      document.addEventListener("input", onInput, true);
    };

    // Stop
    stopBtn.onclick = function () {
      recording = false;
      saveStateToStorage();
      startBtn.disabled = false;
      stopBtn.disabled = true;
      genBtn.disabled = events.length === 0;
      repBtn.disabled = events.length === 0;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("input", onInput, true);
      out.value = "Recording stopped. Click Generate.";
    };

    // Generate script
    genBtn.onclick = function () {
      out.value = generateScriptText(fmt.value);
      dlBtn.disabled = false;
      repBtn.disabled = false;
    };

    // Download script (always .py)
    dlBtn.onclick = function () {
      const blob = new Blob([out.value], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "automation.py";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    };

    // Report button
    repBtn.onclick = function () {
      const steps = normalizeEvents(events || []);
      const meta = {
        initialUrl: initialUrl,
        startedAt: events && events.length ? new Date(events[0].ts).toISOString() : new Date().toISOString(),
        endedAt: new Date().toISOString(),
      };
      downloadHtmlReport(steps, meta);
    };

    // Re-attach when SPA navigation happens
    window.addEventListener("recorder:navigation", function () {
      // If recording, ensure listeners attached and UI shows recording
      if (recording) {
        document.addEventListener("click", onClick, true);
        document.addEventListener("input", onInput, true);
        out.value = "Recording...";
        startBtn.disabled = true;
        stopBtn.disabled = false;
        genBtn.disabled = true;
        dlBtn.disabled = true;
        repBtn.disabled = true;
      } else {
        // non-recording: update UI only
        restoreUI();
      }
    });

    // Monitor DOM removal: if toolbar gets removed by SPA, recreate and restore
    new MutationObserver(() => {
      if (!document.getElementById("__floating_recorder_toolbar__")) {
        console.log("Recorder toolbar removed — restoring");
        const t = buildToolbar();
        // re-bind handlers by reloading current script state
        loadStateFromStorage(function () {
          // slight timeout allow DOM settle
          setTimeout(() => {
            // re-run attachment logic by re-calling this attach function
            // easiest approach: reload page's toolbar by forcing a script re-init
            // but here we'll simply re-run restoreUI and reattach listeners
            const startBtn2 = t.querySelector("#rec_start");
            const stopBtn2 = t.querySelector("#rec_stop");
            const genBtn2 = t.querySelector("#rec_generate");
            const dlBtn2 = t.querySelector("#rec_download");
            const repBtn2 = t.querySelector("#rec_report");
            const fmt2 = t.querySelector("#rec_format");
            const out2 = t.querySelector("#rec_output");
            // update UI state
            if (recording) {
              startBtn2.disabled = true;
              stopBtn2.disabled = false;
              genBtn2.disabled = true;
              dlBtn2.disabled = true;
              repBtn2.disabled = true;
              out2.value = "Recording...";
              document.addEventListener("click", onClick, true);
              document.addEventListener("input", onInput, true);
            } else {
              startBtn2.disabled = false;
              stopBtn2.disabled = true;
              genBtn2.disabled = events.length === 0;
              dlBtn2.disabled = false && out2.value;
              repBtn2.disabled = events.length === 0;
            }
            // re-bind handlers for the recreated buttons
            startBtn2.onclick = startBtn.onclick;
            stopBtn2.onclick = stopBtn.onclick;
            genBtn2.onclick = genBtn.onclick;
            dlBtn2.onclick = dlBtn.onclick;
            repBtn2.onclick = repBtn.onclick;
          }, 250);
        });
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

  }); // end loadStateFromStorage & toolbar wiring

  // Expose debug API
  window.__floating_recorder = {
    isRecording: () => recording,
    getEvents: () => events.slice(),
    getInitialUrl: () => initialUrl,
    clear: () => {
      events = [];
      initialUrl = location.href;
      clearStateFromStorage();
    },
  };
})(); // IIFE end
