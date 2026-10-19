// Plain browser JS, no build step. All text from the server is inserted with textContent, never innerHTML.
import { dueList, describeRule, isoDay, nextDue, WEEKDAYS } from "./recurrence.js";
import { fillTemplate, leftoverPlaceholders, placeholdersOf } from "./template-text.js";
import { formatCount, metricsPresent, summarise } from "./stats-sum.js";

const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  providers: [],
  connectors: [],
  status: {},
  settings: {},
  items: [], // images and videos in the media library
  selected: null, // { id, name, kind } where id is null for a text-only post
  pendingToken: null,
  me: null, // { mode, user: { email, name, role }, csrf }
  templates: [],
  skips: {}, // template id -> days (YYYY-MM-DD) it is skipped
  posts: [], // the latest list from the server, for "coming up"
  templateLink: null, // { id, name } while the post being written came from a template
};

// ------------------------------------------------------------------ helpers

async function api(route, { method = "GET", body } = {}) {
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  if (state.me?.csrf && method !== "GET") headers["X-CSRF-Token"] = state.me.csrf;
  const res = await fetch(route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 401 && state.me?.mode === "google") showLogin("Your session ended. Please sign in again.");
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** Shows the sign-in screen in place of the app. */
function showLogin(message = "") {
  document.body.classList.add("signed-out");
  $("login").hidden = false;
  $("login-msg").textContent = message;
}

const isAdmin = () => state.me?.user?.role === "admin";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

function say(id, message, ok) {
  const node = $(id);
  node.textContent = message;
  node.className = `small ${message ? (ok ? "ok" : "err") : ""}`;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];

/** Counts the way each platform does, so the counters match what it will accept. */
function countText(text, kind) {
  if (kind === "x") {
    const urls = (text.match(/https?:\/\/\S+/g) ?? []).length;
    let n = urls * 23;
    for (const { segment } of segmenter.segment(text.replace(/https?:\/\/\S+/g, ""))) {
      const light = [...segment].every((ch) => LIGHT.some(([lo, hi]) => ch.codePointAt(0) >= lo && ch.codePointAt(0) <= hi));
      n += light ? 1 : 2;
    }
    return n;
  }
  if (kind === "threads") {
    let n = 0;
    for (const ch of text) n += ch.codePointAt(0) > 0xffff ? 4 : 1;
    return n;
  }
  const normalized = kind === "mastodon" ? text.replace(/https?:\/\/\S+/g, "x".repeat(23)) : text;
  let n = 0;
  for (const _ of segmenter.segment(normalized)) n++;
  return n;
}

function toLocalInput(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ tabs + status

function showTab(name) {
  if (name === "settings" && !isAdmin()) name = "schedule"; // members have no settings
  for (const button of document.querySelectorAll("#tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== `tab-${name}`;
  if (name === "queue") loadQueue();
  if (name === "templates") loadTemplates();
  if (name === "stats") loadStats();
  if (name === "settings") loadSettings();
  try { localStorage.setItem("tab", name); } catch { /* storage unavailable */ }
}

function renderChips() {
  const chips = $("status-chips");
  chips.replaceChildren();
  if (state.status.platform === "darwin") {
    chips.append(
      el("span", { class: `chip ${state.status.keepAwake ? "" : "off"}` },
        state.status.keepAwake ? "Mac kept awake" : "Mac may sleep"),
    );
  }
  chips.append(
    el("span", { class: `chip ${state.status.claudeConfigured ? "" : "off"}` },
      state.status.claudeConfigured ? "Claude ready" : "Claude: add API key"),
  );
}

async function refreshStatus() {
  state.status = await api("/api/status");
  $("version").textContent = state.status.version ? `v${state.status.version}` : "";
  renderChips();
  $("draft-btn").disabled = !state.status.claudeConfigured;
  $("alt-btn").disabled = !state.status.claudeConfigured;
  const hint = state.status.claudeConfigured ? "" : "Add your Anthropic API key in Settings to enable";
  $("draft-btn").title = hint;
  $("alt-btn").title = hint;
}

async function refreshAccounts() {
  state.accounts = await api("/api/accounts");
  renderAccountChecks();
}

// ------------------------------------------------------------------ schedule tab

async function loadLibrary() {
  try {
    const data = await api("/api/library");
    state.items = data.items;
    if (state.selected?.id && !data.items.some((i) => i.id === state.selected.id)) {
      state.selected = null;
      $("compose").hidden = true;
    }
    renderGrid();
    const videos = data.items.filter((i) => i.kind === "video").length;
    if (!state.uploading) {
      $("library-msg").className = "muted";
      $("library-msg").textContent = data.items.length
        ? `${data.items.length} file${data.items.length === 1 ? "" : "s"}` + (videos ? ` (${videos} video${videos === 1 ? "" : "s"})` : "") + ", newest first"
        : "";
    }
  } catch (e) {
    say("library-msg", e.message, false);
  }
}

/** Sends one file with a progress callback (fetch can't report upload progress, XMLHttpRequest can). */
function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/library?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (state.me?.csrf) xhr.setRequestHeader("X-CSRF-Token", state.me.csrf);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* no body */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(file);
  });
}

async function uploadFiles(files) {
  const list = [...files];
  if (!list.length || state.uploading) return;
  const max = state.status?.maxUploadBytes ?? Infinity;
  state.uploading = true;
  const bar = $("upload-bar");
  $("upload-progress").hidden = false;
  const problems = [];
  let added = 0;
  let last = null;
  for (const [index, file] of list.entries()) {
    const label = `Uploading ${index + 1} of ${list.length}: ${file.name}`;
    $("library-msg").className = "muted";
    $("library-msg").textContent = label;
    bar.style.width = "0%";
    if (file.size > max) { problems.push(`${file.name}: larger than the ${Math.floor(max / 1048576)} MB limit`); continue; }
    try {
      const result = await uploadOne(file, (fraction) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
        $("library-msg").textContent = `${label} (${Math.round(fraction * 100)}%)`;
      });
      added += result.duplicate ? 0 : 1;
      last = result.item;
    } catch (e) {
      problems.push(`${file.name}: ${e.message}`);
    }
  }
  state.uploading = false;
  $("upload-progress").hidden = true;
  $("file-input").value = "";
  await loadLibrary();
  if (problems.length) say("library-msg", `${added ? `Added ${added}. ` : ""}${problems.join(" · ")}`, false);
  else if (added === 0 && last) say("library-msg", "That file is already in the library.", true);
  else say("library-msg", `Added ${added} file${added === 1 ? "" : "s"}.`, true);
}

async function removeFromLibrary(item) {
  if (!confirm(`Remove "${item.name}" from the library? Posts already scheduled with it are not affected.`)) return;
  try {
    await api(`/api/library/${item.id}`, { method: "DELETE", body: {} });
    await loadLibrary();
  } catch (e) {
    toast(e.message);
  }
}

function renderGrid() {
  const grid = $("grid");
  grid.replaceChildren();
  $("grid-empty").hidden = state.items.length > 0;
  const labels = { scheduled: "Scheduled", posted: "Posted", attention: "Needs attention" };
  for (const item of state.items) {
    grid.append(
      el(
        "div",
        { class: "tilewrap" },
        el(
          "button",
          {
            class: "tile",
            "aria-pressed": String(state.selected?.id === item.id),
            onclick: () => selectItem(item),
            title: item.name,
          },
          el("img", { src: `/api/library/${item.id}/thumb`, alt: "", loading: "lazy" }),
          item.kind === "video" && el("span", { class: "vbadge" }, "▶ video"),
          item.state !== "new" && el("span", { class: `tag ${item.state}` }, labels[item.state]),
          el("span", { class: "name" }, item.name),
        ),
        el("button", { class: "remove", title: "Remove from the library", "aria-label": `Remove ${item.name} from the library`, onclick: () => removeFromLibrary(item) }, "✕"),
      ),
    );
  }
}

/** "image", "video", or null for a text-only post. */
const currentKind = () => state.selected?.kind ?? null;

/** Switches the compose panel between image, video and text-only, keeping what's been typed. */
function showComposeMode() {
  const kind = currentKind();
  const hasMedia = kind !== null;
  $("image-block").hidden = !hasMedia;
  $("alt-group").hidden = kind !== "image";
  $("textonly-note").hidden = hasMedia;
  $("brief-label").replaceChildren(
    hasMedia ? "What should the post be about? " : "What should the post say? ",
    el("em", { class: "muted" }, hasMedia ? "(optional, for Claude)" : "(for Claude, if you want a draft)"),
  );
  if (hasMedia) {
    $("compose-img").src = `/api/library/${state.selected.id}/thumb`; // small thumbnail is plenty
    $("compose-name").textContent = state.selected.name;
  }
  renderAccountChecks();
}

function resetComposeExtras() {
  $("options").hidden = true;
  $("options").replaceChildren();
  say("draft-msg", "", true);
  say("schedule-msg", "", true);
  if (!$("when").value) setQuick("tomorrow9");
}

function startTextOnly() {
  if ($("compose").hidden) setTemplateLink(null); // a fresh post isn't from a template unless one is applied after this
  const keepText = $("compose").hidden ? "" : $("text").value;
  const keepTitle = $("compose").hidden ? "" : $("title").value;
  state.selected = { id: null, name: "", kind: null };
  renderGrid();
  $("compose").hidden = false;
  $("text").value = keepText;
  $("title").value = keepTitle;
  $("alt").value = "";
  resetComposeExtras();
  showComposeMode();
  $("text").focus();
}

function selectItem(item) {
  // Choosing a file while writing a text-only post adds it and keeps the text.
  const adding = !$("compose").hidden && state.selected && !state.selected.id;
  if (!adding) setTemplateLink(null);
  const keepText = adding ? $("text").value : "";
  const keepTitle = adding ? $("title").value : "";
  state.selected = item;
  renderGrid();
  $("compose").hidden = false;
  $("text").value = keepText;
  $("title").value = keepTitle;
  $("alt").value = "";
  $("brief").value = "";
  resetComposeExtras();
  showComposeMode();
  $("text").focus();
}

function checkedAccountIds() {
  // Only the account boxes count; the "post without the image" switches share this list but aren't accounts.
  return [...document.querySelectorAll("#account-checks input[data-account]:checked")].map((i) => Number(i.dataset.account));
}

/** Why this account can't take what's being composed, or null. */
function refusalFor(account) {
  const kind = currentKind();
  return kind === null ? account.noText : kind === "image" ? account.noImage : account.noVideo;
}

/**
 * A channel that can't take this picture or video but can take the text (Bluesky with a video). It isn't blocked:
 * it simply posts the text on its own, and the person is told so.
 */
function textOnlyFallback(account) {
  return currentKind() !== null && Boolean(refusalFor(account)) && !account.noText;
}

/** Channels the person never wants the image on (for example Mastodon), remembered between posts. */
function loadNoMedia() {
  try { return new Set(JSON.parse(localStorage.getItem("noMedia") ?? "[]")); } catch { return new Set(); }
}
const noMediaIds = loadNoMedia();

/** YouTube channels the person wants the video's first frame used as the thumbnail for. Remembered between posts. */
const thumbFrameIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem("thumbFrame") ?? "[]")); } catch { return new Set(); }
})();
function saveThumbFrame() {
  try { localStorage.setItem("thumbFrame", JSON.stringify([...thumbFrameIds])); } catch { /* ignore */ }
}
function saveNoMedia() {
  try { localStorage.setItem("noMedia", JSON.stringify([...noMediaIds])); } catch { /* ignore */ }
}

function renderAccountChecks() {
  let remembered = [];
  try { remembered = JSON.parse(localStorage.getItem("accounts") ?? "[]"); } catch { /* ignore */ }
  const box = $("account-checks");
  const hadChecks = box.querySelector("input") !== null;
  const currentlyChecked = new Set(checkedAccountIds());
  box.replaceChildren();
  if (state.accounts.length === 0) {
    box.append(el("p", { class: "muted small" }, "No accounts yet. Add or connect one in Settings."));
  }
  const kind = currentKind();
  for (const account of state.accounts) {
    const textOnly = textOnlyFallback(account);
    const why = textOnly ? null : refusalFor(account);
    const wanted = hadChecks ? currentlyChecked.has(account.id) : remembered.includes(account.id);
    // A channel that can post without the picture gets its own switch for that.
    const canSkipMedia = kind !== null && !why && !textOnly && !account.noText;
    box.append(
      el("div", { class: `acct ${why ? "disabled" : ""}`, style: "display:block" },
        el("label", { style: "display:flex;gap:8px;align-items:center" },
          el("input", { type: "checkbox", "data-account": account.id, checked: wanted && !why, disabled: Boolean(why), onchange: onAccountChange }),
          `${account.label} `,
          el("span", { class: "muted small" }, `(${account.kindLabel})`),
        ),
        why && el("span", { class: "why" }, why),
        textOnly && el("span", { class: "why" }, `${refusalFor(account)} It will post the text only, without the ${kind}.`),
        account.kind === "youtube" && kind === "video" && !why && el("label", { class: "opts" },
          el("input", {
            type: "checkbox", checked: thumbFrameIds.has(account.id), "aria-label": `Use the first frame of the video as the thumbnail on ${account.label}`,
            onchange: (e) => { e.target.checked ? thumbFrameIds.add(account.id) : thumbFrameIds.delete(account.id); saveThumbFrame(); },
          }),
          "use the first frame as the thumbnail",
        ),
        canSkipMedia && el("label", { class: "opts" },
          el("input", {
            type: "checkbox", checked: noMediaIds.has(account.id), "aria-label": `Post to ${account.label} without the ${kind}`,
            onchange: (e) => { e.target.checked ? noMediaIds.add(account.id) : noMediaIds.delete(account.id); saveNoMedia(); },
          }),
          `post without the ${kind}`,
        ),
      ),
    );
  }
  renderCounters();
  renderTitleField();
}

function onAccountChange() {
  try { localStorage.setItem("accounts", JSON.stringify(checkedAccountIds())); } catch { /* ignore */ }
  renderCounters();
  renderTitleField();
}

function chosenAccounts() {
  const ids = checkedAccountIds();
  return state.accounts.filter((a) => ids.includes(a.id));
}

function renderTitleField() {
  const chosen = chosenAccounts().filter((a) => a.needsTitle);
  $("title-field").hidden = chosen.length === 0;
  if (!chosen.length) return;
  // Manual accounts can be given their title later, in the Queue, so only automatic platforms insist now.
  const required = chosen.some((a) => a.needsTitle === "required" && !a.manual);
  const limit = Math.min(...chosen.map((a) => a.titleLimit ?? Infinity));
  $("title-label").replaceChildren("Title ", el("em", { class: "muted" }, required ? "(required)" : "(optional now; you can add it later in the Queue)"));
  $("title").maxLength = Number.isFinite(limit) ? limit : 524288;
  $("title-hint").textContent = `Used by ${chosen.map((a) => a.label).join(", ")}${Number.isFinite(limit) ? `. Up to ${limit} characters.` : "."}`;
}

function renderCounters() {
  const box = $("counters");
  box.replaceChildren();
  const text = $("text").value;
  for (const account of chosenAccounts()) {
    const used = countText(text, account.kind);
    box.append(
      el("span", { class: `count ${used > account.textLimit ? "over" : ""}` }, `${account.label}: ${used}/${account.textLimit}`),
    );
  }
}

function minLimit() {
  const chosen = chosenAccounts();
  return chosen.length ? Math.min(...chosen.map((a) => a.textLimit)) : 300;
}

function setQuick(kind) {
  const d = new Date();
  if (kind === "tomorrow9" || kind === "tomorrow17") {
    d.setDate(d.getDate() + 1);
    d.setHours(kind === "tomorrow9" ? 9 : 17, 0, 0, 0);
  } else {
    d.setMinutes(d.getMinutes() + Number(kind), 0, 0);
  }
  $("when").value = toLocalInput(d);
}

async function draftWithClaude(kind) {
  if (!state.selected) return;
  const button = kind === "text" ? $("draft-btn") : $("alt-btn");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Thinking…";
  say("draft-msg", "", true);
  try {
    const { options } = await api("/api/draft", {
      method: "POST",
      body: {
        kind,
        libraryId: state.selected.id ?? null,
        brief: $("brief").value,
        accountIds: checkedAccountIds(),
        currentText: kind === "text" ? $("text").value : "",
      },
    });
    if (kind === "alt") {
      $("alt").value = options[0];
    } else {
      showOptions(options);
    }
  } catch (e) {
    say("draft-msg", e.message, false);
  } finally {
    button.textContent = original;
    button.disabled = !state.status.claudeConfigured;
  }
}

function showOptions(options) {
  const box = $("options");
  box.replaceChildren();
  const limit = minLimit();
  for (const option of options) {
    const used = countText(option, "bluesky");
    box.append(
      el("button", {
        type: "button",
        class: `option ${used > limit ? "over" : ""}`,
        onclick: () => {
          $("text").value = option;
          renderCounters();
        },
      }, option, el("span", { class: "len" }, `${used} characters${used > limit ? ` (over the ${limit} limit)` : ""} · click to use`)),
    );
  }
  box.hidden = false;
}

/** Which of the ticked channels should post without the picture. */
function skippedMedia() {
  const overrides = {};
  if (!state.selected?.id) return overrides;
  for (const id of checkedAccountIds()) {
    const account = state.accounts.find((a) => a.id === id);
    if (account && (noMediaIds.has(id) || textOnlyFallback(account)) && !account.noText) overrides[id] = { noMedia: true };
    else if (account?.kind === "youtube" && state.selected.kind === "video" && thumbFrameIds.has(id)) overrides[id] = { thumbFirstFrame: true };
  }
  return overrides;
}

async function schedule() {
  if (!state.selected) return;
  const button = $("schedule-btn");
  button.disabled = true;
  say("schedule-msg", "", true);
  try {
    const when = $("when").value;
    if (!when) throw new Error("Choose a date and time.");
    const hasMedia = Boolean(state.selected.id);
    const uploading = chosenAccounts().some((a) => a.heldByPlatform) && state.selected.kind === "video";
    if (uploading) say("schedule-msg", "Uploading the video to the platform. This can take a few minutes…", true);
    await api("/api/posts", {
      method: "POST",
      body: {
        libraryId: state.selected.id ?? null,
        text: $("text").value,
        title: $("title-field").hidden ? "" : $("title").value,
        altText: state.selected.kind === "image" ? $("alt").value : "",
        scheduledAt: new Date(when).toISOString(),
        accountIds: checkedAccountIds(),
        overrides: skippedMedia(),
        templateId: state.templateLink?.id ?? null,
        templateValues: state.templateLink?.values ?? null,
      },
    });
    setTemplateLink(null);
    say("schedule-msg", "", true);
    toast(`Scheduled for ${formatWhen(new Date(when).toISOString())}`);
    if (!hasMedia) {
      // Text-only: clear the form for the next one, but leave the panel open.
      $("text").value = "";
      $("title").value = "";
      $("options").hidden = true;
      renderCounters();
      refreshQueueBadge();
      return;
    }
    await loadLibrary();
    // Move on to the next file that hasn't been scheduled yet.
    const index = state.items.findIndex((i) => i.id === state.selected.id);
    const next = state.items.slice(index + 1).concat(state.items.slice(0, index)).find((i) => i.state === "new");
    if (next) selectItem(next);
    else { state.selected = null; $("compose").hidden = true; renderGrid(); }
    refreshQueueBadge();
  } catch (e) {
    say("schedule-msg", e.message, false);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ queue tab

const STATUS_LABEL = {
  scheduled: "Scheduled", posting: "Posting…", posted: "Posted", failed: "Failed", missed: "Missed",
  ready: "Ready: post it by hand",
};

const PENDING = ["scheduled", "missed", "failed", "ready"];

function postBucket(post) {
  const s = post.targets.map((t) => t.status);
  if (s.some((x) => x === "failed" || x === "missed" || x === "ready")) return "attention";
  if (s.some((x) => x === "scheduled" || x === "posting")) return "upcoming";
  return "done";
}

async function refreshQueueBadge() {
  try {
    const posts = await api("/api/posts");
    state.posts = posts;
    renderDue();
    const n = posts.filter((p) => postBucket(p) === "attention").length;
    $("queue-badge").hidden = n === 0;
    $("queue-badge").textContent = String(n);
    return posts;
  } catch {
    return [];
  }
}

async function loadQueue() {
  const posts = await refreshQueueBadge();
  const root = $("queue");
  root.replaceChildren();
  const groups = [
    ["attention", "Needs attention", posts.filter((p) => postBucket(p) === "attention")],
    ["upcoming", "Upcoming", posts.filter((p) => postBucket(p) === "upcoming").sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))],
    ["done", "Posted", posts.filter((p) => postBucket(p) === "done")],
  ];
  let any = false;
  for (const [, title, items] of groups) {
    if (items.length === 0) continue;
    any = true;
    root.append(el("h2", {}, title), ...items.map(renderPost));
  }
  if (!any) root.append(el("p", { class: "empty" }, "Nothing scheduled yet. Pick an image or video on the Schedule tab."));
}

/** Posted items show when they actually went out; the rest show when they're due. */
function whenLabel(post) {
  const done = post.targets.length > 0 && post.targets.every((t) => t.status === "posted");
  const postedAt = post.targets.map((t) => t.postedAt).filter(Boolean).sort().pop();
  return done && postedAt ? `Posted ${formatWhen(postedAt)}` : formatWhen(post.scheduledAt);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy automatically. Select the text in Edit and copy it by hand.");
  }
}

/** The "do this by hand" box for platforms with no API, using this channel's own text and title. */
function manualBox(post, target) {
  const hasFile = post.mediaFile && !target.noMedia;
  const early = Date.parse(post.scheduledAt) > Date.now(); // prepared before its time
  return el("div", { class: "manual" },
    target.handedOff
      ? el("p", {}, `You scheduled this on ${target.accountLabel} yourself for this time. Check that it went out, then mark it as posted.`)
      : el("p", {}, `${early ? "Getting ready to post" : "Time to post"} on ${target.accountLabel}. Copy the text${hasFile ? ", find the file" : ""}, ${early ? "then either post it there now, or schedule it on their own tool and press \"I've scheduled it there\" below" : "post it there"}, then mark it done.`),
    target.titleMissing && el("p", { class: "err" }, "This one needs a title first. Press its Edit button above to add one."),
    el("div", { class: "buttons" },
      target.title && el("button", { onclick: () => copyToClipboard(target.title) }, "Copy title"),
      el("button", { onclick: () => copyToClipboard(target.text) }, "Copy text"),
      hasFile && el("a", {
        class: "button",
        href: `/api/media/${encodeURIComponent(post.mediaFile)}?download=1`,
        download: "",
      }, `Download the ${post.mediaKind ?? "file"}`),
      target.manualUrl && el("a", { class: "button", href: target.manualUrl, target: "_blank", rel: "noreferrer" }, "Open the page"),
      early && !target.handedOff && el("button", { class: "primary", onclick: () => setScheduledThere(target, true) }, "I've scheduled it there"),
      el("button", {
        class: early && !target.handedOff ? "" : "primary",
        onclick: () => markPostedByHand(target),
      }, "Mark as posted"),
    ),
  );
}

/** Asks for the link (optional) and marks a hand-posted channel as posted. */
async function markPostedByHand(target) {
  const link = prompt("Paste the link to your post (optional), then press OK to mark it as posted.", "");
  if (link === null) return;
  try {
    await api(`/api/targets/${target.id}/mark-posted`, { method: "POST", body: { url: link.trim() || undefined } });
    toast("Marked as posted");
  } catch (e) { toast(e.message); }
  loadQueue();
}

function renderPost(post) {
  const sharedEditable = post.targets.every((t) => t.status !== "posted" && t.status !== "posting");
  const thumb = post.mediaUrl
    ? el("div", { style: "position:relative" }, el("img", { src: post.mediaUrl, alt: "" }), post.mediaKind === "video" && el("span", { class: "vbadge" }, "▶"))
    : el("div", { class: "noimg" }, "Text only");
  return el("div", { class: "post" },
    thumb,
    el("div", {},
      el("div", { class: "when" }, whenLabel(post)),
      post.title && el("div", { class: "title" }, post.title),
      el("div", { class: "text" }, post.text),
      el("div", { class: "channels" }, post.targets.map((t) => renderChannel(post, t))),
    ),
    el("div", { class: "actions" },
      sharedEditable && el("button", { onclick: () => openEdit(post) }, "Edit shared text & time"),
      post.targets.some((t) => t.status === "posted") &&
        el("button", { onclick: () => openWiki({ post: post.id }) }, "Wiki table row"),
      post.targets.some((t) => PENDING.includes(t.status)) &&
        el("button", { class: "danger", onclick: () => removePost(post) }, "Cancel what's not posted"),
    ),
  );
}

/** One channel of a post: its status, what makes it different from the shared post, and its own buttons. */
function renderChannel(post, t) {
  const held = t.mode === "remote" && t.status === "scheduled";
  const byYou = t.handedOff && t.status === "scheduled";
  const label = `${t.accountLabel}: ${held ? `Scheduled on ${cap(t.kind)}` : byYou ? "Scheduled there by you" : (STATUS_LABEL[t.status] ?? t.status)}`;
  const chip = t.url && t.url.startsWith("http")
    ? el("a", { class: `target ${t.status}`, href: t.url, target: "_blank", rel: "noreferrer" }, label)
    : el("span", { class: `target ${t.status}` }, label);
  const pending = PENDING.includes(t.status);
  return el("div", { class: "channel" },
    el("div", { class: "chead" },
      chip,
      t.customText && el("span", { class: "badge-note" }, "own text"),
      t.noMedia && el("span", { class: "badge-note" }, `no ${post.mediaKind ?? "image"}`),
      t.customTitle && el("span", { class: "badge-note" }, "own title"),
      t.titleMissing && pending && el("span", { class: "badge-note warn" }, "needs a title"),
      el("div", { class: "cbtns" },
        pending && el("button", { onclick: () => openChannelEdit(post, t) }, "Edit"),
        t.status === "posted" && t.manualUrl && el("button", { onclick: () => editPostedLink(t) }, "Edit link"),
        t.status === "posted" && t.manualUrl && el("button", { class: "link", onclick: () => unmarkPosted(t) }, "Not posted after all"),
        byYou && el("button", { class: "link", onclick: () => setScheduledThere(t, false) }, "Not scheduled there after all"),
        // Already scheduled by hand on the platform's own tool: the next step is to say it went out, not to prepare it again.
        byYou && el("button", { class: "primary", onclick: () => markPostedByHand(t) }, "Mark as posted"),
        !byYou && ["scheduled", "missed", "failed"].includes(t.status) &&
          el("button", { onclick: (e) => postNow(t, e.currentTarget) },
            t.manualUrl ? "Prepare now" : t.status === "scheduled" ? "Post now" : "Retry"),
      ),
    ),
    t.customText && t.status !== "posted" && el("div", { class: "ctext" }, t.text),
    t.error && t.status !== "posted" && el("div", { class: "errors" }, t.error),
    t.error && t.status === "posted" && el("div", { class: "note" }, t.error),
    t.status === "ready" && manualBox(post, t),
  );
}

/** For a hand-posted channel that was marked posted: fix its link, or take "posted" back (for a slip). */
async function editPostedLink(t) {
  const link = prompt(`The link to the post on ${t.accountLabel} (leave empty to remove it):`, t.url ?? "");
  if (link === null) return;
  try {
    await api(`/api/targets/${t.id}/posted-link`, { method: "POST", body: { url: link.trim() } });
    toast("Link saved");
  } catch (e) { toast(e.message); }
  loadQueue();
}

async function unmarkPosted(t) {
  if (!confirm(`Take "posted" back for ${t.accountLabel}? It goes back to being a reminder for you to post by hand.`)) return;
  try {
    await api(`/api/targets/${t.id}/unmark-posted`, { method: "POST", body: {} });
    toast("Back to a reminder");
  } catch (e) { toast(e.message); }
  loadQueue();
}

/** Says (or takes back) that a post for a hand-posted platform has been scheduled on that platform's own tool. */
async function setScheduledThere(target, on) {
  try {
    await api(`/api/targets/${target.id}/handed-off`, { method: "POST", body: on ? {} : { undo: true } });
    toast(on ? `Noted. ${target.accountLabel} won't ask until its time.` : "Back to a reminder for you to post by hand.");
  } catch (e) {
    toast(e.message);
  }
  loadQueue();
}

async function postNow(target, button) {
  const message = target.manualUrl
    ? `Get ${target.accountLabel} ready now? (You'll post it there by hand.)`
    : `Post to ${target.accountLabel} right now?`;
  if (!confirm(message)) return;
  button.disabled = true;
  try {
    const result = await api(`/api/targets/${target.id}/post-now`, { method: "POST", body: {} });
    toast(result.status === "posted" ? "Posted" : result.status === "ready" ? "Ready for you to post" : `Failed: ${result.error}`);
  } catch (e) {
    toast(e.message);
  }
  loadQueue();
}

async function removePost(post) {
  if (!confirm("Cancel this scheduled post? Anything already published stays published.")) return;
  try {
    await api(`/api/posts/${post.id}`, { method: "DELETE", body: {} });
  } catch (e) {
    toast(e.message);
  }
  loadQueue();
  loadLibrary();
}

let editing = null;
function openEdit(post) {
  editing = post;
  $("edit-text").value = post.text;
  $("edit-alt").value = post.altText;
  $("edit-alt-field").hidden = post.mediaKind !== "image";
  $("edit-title").value = post.title ?? "";
  $("edit-title-field").hidden = !(post.title || post.targets.some((t) => ["reddit", "youtube", "tiktok"].includes(t.kind)));
  $("edit-when").value = toLocalInput(new Date(post.scheduledAt));
  say("edit-msg", "", true);
  $("edit-dialog").showModal();
}

// ---- editing one channel

let editingChannel = null;

function updateChannelCount() {
  const { post, t } = editingChannel;
  const shared = $("channel-use-shared").checked;
  $("channel-text").disabled = shared;
  if (shared) $("channel-text").value = post.text;
  const used = countText($("channel-text").value, t.kind);
  $("channel-count").textContent = `${used} of ${t.textLimit} characters`;
  $("channel-count").style.color = used > t.textLimit ? "var(--bad)" : "";
}

function openChannelEdit(post, t) {
  editingChannel = { post, t };
  $("channel-title").textContent = `Edit for ${t.accountLabel}`;
  const held = t.mode === "remote" && t.status === "scheduled";
  $("channel-note").textContent = held
    ? `${cap(t.kind)} is holding this one. Saving takes it back and hands over the new version, which can take a few seconds.`
    : "Only this channel changes. The other channels keep the shared post.";

  $("channel-use-shared").checked = !t.customText;
  $("channel-text").value = t.customText ? t.text : post.text;
  $("channel-use-shared").onchange = () => {
    if (!$("channel-use-shared").checked) $("channel-text").value = post.text; // start from the shared text
    updateChannelCount();
  };
  $("channel-text").oninput = updateChannelCount;

  // Title, for the platforms that have one.
  const hasTitle = Boolean(t.needsTitle) || Boolean(t.title);
  $("channel-title-field").hidden = !hasTitle;
  $("channel-title-input").value = t.customTitle ? t.title : (post.title ?? "");
  $("channel-title-input").maxLength = t.titleLimit ?? 524288;
  $("channel-title-label").replaceChildren("Title ", el("em", { class: "muted" },
    t.needsTitle === "required" ? "(this channel needs one)" : "(optional)"));

  // Dropping the picture, if there is one and this channel can post without it.
  const hasMedia = Boolean(post.mediaFile);
  const kindWord = post.mediaKind ?? "image";
  $("channel-nomedia-row").hidden = !hasMedia;
  $("channel-nomedia-label").textContent = `Post this channel without the ${kindWord}`;
  $("channel-nomedia").checked = t.noMedia;
  $("channel-nomedia").disabled = Boolean(t.textOnlyRefusal);
  $("channel-nomedia-why").textContent = t.textOnlyRefusal ?? "";

  say("channel-msg", "", true);
  updateChannelCount();
  $("channel-dialog").showModal();
}

async function saveChannel(event) {
  event.preventDefault();
  const { post, t } = editingChannel;
  const useShared = $("channel-use-shared").checked;
  const title = $("channel-title-field").hidden ? undefined : $("channel-title-input").value;
  const body = {
    // Same as the shared text means "no override", so later edits to the shared text reach this channel too.
    text: useShared || $("channel-text").value.trim() === post.text.trim() ? "" : $("channel-text").value,
    noMedia: $("channel-nomedia-row").hidden ? false : $("channel-nomedia").checked,
  };
  if (title !== undefined) body.title = title.trim() === (post.title ?? "").trim() ? "" : title;
  const button = $("channel-save");
  button.disabled = true;
  say("channel-msg", t.mode === "remote" && t.status === "scheduled" ? "Updating on the platform…" : "", true);
  try {
    await api(`/api/targets/${t.id}`, { method: "PATCH", body });
    $("channel-dialog").close();
    toast(`Saved for ${t.accountLabel}`);
    loadQueue();
  } catch (e) {
    say("channel-msg", e.message, false);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ stats tab

function statsTable(headerLabel, rows, columns, cells) {
  const head = el("tr", {}, el("th", {}, headerLabel), ...columns.map((c) => el("th", {}, c.label)));
  const body = rows.map((r) => el("tr", {}, ...cells(r)));
  return el("div", { class: "stats-scroll" }, el("table", { class: "stats-table" }, el("thead", {}, head), el("tbody", {}, ...body)));
}

function totalsCells(group, columns) {
  return columns.map((c) => {
    const value = group.totals[c.key];
    return el("td", { class: value === undefined ? "none" : "" }, formatCount(value));
  });
}

async function loadStats() {
  const days = Number($("stats-days").value) || 30;
  let data;
  try {
    data = await api(`/api/stats?days=${days}`);
  } catch (e) {
    toast(e.message);
    return;
  }
  state.statsArchive = data.archive;
  const archiveButton = $("stats-archive");
  archiveButton.textContent = `⬇ Export ${data.archive.label} (CSV)`;
  archiveButton.title = `${data.archive.posts} posts. The month before last, as one row per day per channel. Run it early each month: by then every post has its month-old reading.`;
  const root = $("stats");
  root.replaceChildren();
  const rows = data.rows;
  const columns = metricsPresent(rows);
  const read = rows.filter((r) => r.takenAt).length;
  $("stats-note").textContent = rows.length
    ? `${rows.length} posts, numbers read for ${read}. Each is read about a day, a week and a month after it goes out; a blank dash means that channel doesn't report that number.`
    : "Nothing posted in this time yet.";

  const problems = $("stats-problems");
  problems.replaceChildren(
    ...data.problems.map((p) => el("div", { class: "stats-problem" }, el("strong", {}, p.channel), `: ${p.note}`)),
    ...[...new Map(rows.filter((r) => r.error).map((r) => [`${r.channel}|${r.error}`, r])).values()].slice(0, 5).map((r) =>
      el("div", { class: "stats-problem" }, el("strong", {}, r.channel), `: couldn't read a post's numbers (${r.error})`)),
  );
  if (!rows.length) return;

  root.append(el("h3", {}, "By channel"));
  root.append(
    statsTable("Channel", summarise(rows, (r) => r.channel), columns, (g) => [
      el("td", {}, `${g.key} (${g.withNumbers}/${g.posts} posts)`),
      ...totalsCells(g, columns),
    ]),
  );
  root.append(el("h3", {}, "By regular post"));
  root.append(
    statsTable("Template", summarise(rows, (r) => r.template ?? "(not from a template)"), columns, (g) => [
      el("td", {}, `${g.key} (${g.posts})`),
      ...totalsCells(g, columns),
    ]),
  );
  root.append(el("h3", {}, "Every post"));
  root.append(
    statsTable("Post", rows, columns, (r) => {
      const snippet = r.text.replace(/\s+/g, " ").slice(0, 80);
      return [
        el("td", { class: "snip" },
          el("div", { class: "muted" }, `${formatWhen(r.postedAt)} · ${r.channel}`),
          r.url ? el("a", { href: r.url, target: "_blank", rel: "noopener" }, snippet || "(no text)") : snippet || "(no text)"),
        ...columns.map((c) => el("td", { class: typeof r.metrics[c.key] === "number" ? "" : "none" }, formatCount(r.metrics[c.key]))),
      ];
    }),
  );
}

$("stats-days").addEventListener("change", () => loadStats());

$("stats-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Reading…";
  try {
    const r = await api("/api/stats/refresh", { method: "POST", body: {} });
    toast(`Read ${r.read} post${r.read === 1 ? "" : "s"}${r.failed ? `, ${r.failed} couldn't be read` : ""}`);
    await loadStats();
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh numbers now";
  }
});

/** Downloads the month before last as daily totals, then offers to clear those numbers from the app. */
$("stats-archive").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const info = state.statsArchive;
  if (!info) return;
  button.disabled = true;
  try {
    const res = await fetch(`/api/export/stats?month=${info.month}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Export failed (${res.status})`);
    }
    const url = URL.createObjectURL(await res.blob());
    const link = el("a", { href: url, download: `post-stats-${info.month}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Downloaded ${info.label}`);

    if (!isAdmin()) return toast(`Downloaded ${info.label}. An administrator can clear those numbers from the app once the file is saved.`);
    // A separate, deliberate step: only after the file is safely on this computer.
    const clear = confirm(
      `${info.label} has been downloaded as post-stats-${info.month}.csv.\n\n` +
      `Make sure the file is saved somewhere safe, then press OK to clear ${info.label}'s numbers from the app (the posts themselves stay). This can't be undone.\n\n` +
      `Press Cancel to keep them for now.`,
    );
    if (!clear) return;
    const r = await api("/api/stats/clear-month", { method: "POST", body: { month: info.month, confirm: true } });
    toast(`Cleared ${r.readings} readings for ${r.posts} posts from ${r.label}`);
    await loadStats();
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
});

$("stats-import").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const r = await api("/api/stats/import", { method: "POST", body: { csv: await file.text() } });
    if (r.problem) {
      toast(r.problem);
    } else {
      const lost = r.unmatched ? `; ${r.unmatched} row${r.unmatched === 1 ? "" : "s"} matched no TikTok post made here (${r.unmatchedExamples.join(", ")})` : "";
      toast(`Matched ${r.matched} of ${r.rows} videos${lost}`);
    }
    await loadStats();
  } catch (e) {
    toast(e.message);
  }
});

// ------------------------------------------------------------------ settings tab

async function loadSettings() {
  state.settings = await api("/api/settings");
  const s = state.settings;
  $("set-style").value = s.styleGuide;
  $("set-model").value = s.claudeModel;
  $("set-grace").value = s.missedGraceMinutes;
  $("set-awake").checked = s.keepAwake;
  $("set-key").value = "";
  $("set-key").placeholder = s.apiKeySet ? "•••••••• (saved, type to replace)" : "sk-ant-…";
  $("key-state").textContent = s.apiKeyFromEnv ? "(using ANTHROPIC_API_KEY from your environment)" : s.apiKeySet ? "(saved)" : "";
  state.wikiColumns = await api("/api/wiki-columns").catch(() => null);
  renderAccountList();
  const teamShown = state.me.mode === "google";
  for (const card of document.querySelectorAll(".team-only")) card.hidden = !teamShown;
  for (const card of document.querySelectorAll(".admin-only")) card.hidden = false;
  await Promise.all([loadConnectors(), loadHost(), teamShown ? loadTeam() : null, teamShown ? loadBackup() : null, loadActivity()]);
}

// ------------------------------------------------------------------ team + activity (administrators)

async function loadTeam() {
  const { users } = await api("/api/users");
  const box = $("team");
  box.replaceChildren();
  for (const u of users) {
    const mine = u.email === state.me.user.email;
    const status = u.status === "disabled" ? "access off" : u.signedIn ? "signed in now" : u.linked ? "" : "hasn't signed in yet";
    const change = async (body, doneMessage) => {
      try {
        await api(`/api/users/${u.id}`, { method: "PATCH", body });
        if (doneMessage) toast(doneMessage);
      } catch (e) {
        toast(e.message);
      }
      loadTeam();
    };
    const role = el("select", { "aria-label": `Role for ${u.email}`, onchange: (e) => change({ role: e.target.value }, "Role changed") },
      el("option", { value: "member" }, "Member"), el("option", { value: "admin" }, "Administrator"));
    role.value = u.role;
    box.append(
      el("div", { class: "team-row" },
        el("div", { class: "who-is" }, el("strong", {}, u.name || u.email), u.name && el("span", { class: "muted" }, ` ${u.email}`), mine && el("span", { class: "muted" }, " (you)"), status && el("div", { class: "muted small" }, status)),
        role,
        el("button", { onclick: () => change({ status: u.status === "disabled" ? "active" : "disabled" }, u.status === "disabled" ? "Access turned on" : "Access turned off") }, u.status === "disabled" ? "Turn on" : "Turn off"),
        el("button", {
          onclick: async () => {
            if (!confirm(`Remove ${u.email}? They will no longer be able to sign in.`)) return;
            try { await api(`/api/users/${u.id}`, { method: "DELETE", body: {} }); } catch (e) { toast(e.message); }
            loadTeam();
          },
        }, "Remove"),
      ),
    );
  }
}

const megabytes = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`);

async function loadBackup() {
  const b = await api("/api/backup");
  const when = b.lastAt ? new Date(b.lastAt).toLocaleString() : "";
  let line = "";
  if (!b.configured) line = "Automatic backups aren't set up, so nothing protects the queue if the server's disk is lost. See docs/DEPLOY.md.";
  else if (b.lastOk === null) line = `Automatic backups run every night around ${b.hour}:00 (server time) and keep the newest ${b.keep}. None has run yet.`;
  else if (b.lastOk) line = `Last backup: ${when}, ${megabytes(b.lastBytes)}, encrypted. Runs every night around ${b.hour}:00 and keeps the newest ${b.keep}.`;
  else line = `The last backup failed (${when}): ${b.lastError}. It retries every half hour.`;
  $("backup-state").textContent = line;
  $("backup-state").className = `small ${b.configured && b.lastOk === false ? "err" : ""}`;
  $("memory-state").textContent = b.memory
    ? `Memory: ${b.memory.usedMb} MB in use now, ${b.memory.peakMb} MB at the most since the server last started (of ${b.memory.totalMb} MB). The server is billed by its size, so this shows whether a smaller one would do.`
    : "";
  $("disk-state").textContent = b.disk ? `Data disk: ${b.disk.usedPercent}% full, ${(b.disk.freeBytes / 1e9).toFixed(1)} GB free.` : "";
  $("backup-now").disabled = !b.configured || b.running;
}

async function loadActivity() {
  const { entries } = await api("/api/audit?limit=100");
  $("activity").replaceChildren(
    ...entries.map((e) =>
      el("div", {}, el("span", { class: "when" }, new Date(e.at).toLocaleString()), el("span", {}, el("strong", {}, e.email), ` ${e.action}`, e.detail && el("span", { class: "muted" }, ` · ${e.detail}`))),
    ),
  );
  if (!entries.length) $("activity").textContent = "Nothing yet.";
}

function accountDetail(account) {
  const c = account.config;
  return [
    account.kindLabel,
    c.handle && `@${String(c.handle).replace(/^@/, "")}`,
    c.username && `@${String(c.username).replace(/^@/, "")}`,
    c.instance,
    c.pageName,
    c.organizationName && `Page ${c.organizationName}`,
    c.channelTitle,
    c.subreddit && `r/${c.subreddit}`,
    c.url,
    account.heldByPlatform && account.kind !== "dryrun" ? "the platform holds the schedule" : "",
    account.manual ? "reminder; you post by hand" : "",
  ].filter(Boolean).join(" · ");
}

/** Which column of the wiki's social media posts table this account's links go in. */
function wikiColumnChoice(account) {
  const info = state.wikiColumns?.accounts.find((a) => a.id === account.id);
  if (!info) return null;
  const select = el("select", { "aria-label": `Wiki table column for ${account.label}` },
    el("option", { value: "" }, "not in the table"),
    ...state.wikiColumns.columns.map((c) => el("option", { value: c.key }, c.label)));
  select.value = info.column;
  select.addEventListener("change", async () => {
    info.column = select.value;
    try {
      state.wikiColumns = await api("/api/wiki-columns", { method: "PUT", body: { map: Object.fromEntries(state.wikiColumns.accounts.map((a) => [a.id, a.column])) } });
      toast("Saved");
    } catch (e) {
      toast(e.message);
    }
  });
  return el("label", { class: "wikicol" }, "Wiki table column:", select);
}

function renderAccountList() {
  const root = $("accounts");
  root.replaceChildren();
  if (state.accounts.length === 0) root.append(el("p", { class: "muted" }, "No accounts yet. Connect a platform below or add one by hand."));
  for (const account of state.accounts) {
    const result = el("span", { class: "small" });
    root.append(
      el("div", { class: "account" },
        el("div", { class: "grow" }, el("strong", {}, account.label), el("div", { class: "detail" }, accountDetail(account)), result, wikiColumnChoice(account)),
        el("button", {
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            const r = await api(`/api/accounts/${account.id}/test`, { method: "POST", body: {} });
            result.textContent = r.detail;
            result.className = `small ${r.ok ? "ok" : "err"}`;
            e.currentTarget.disabled = false;
          },
        }, "Test"),
        el("button", {
          class: "danger",
          onclick: async () => {
            if (!confirm(`Remove ${account.label}?`)) return;
            try {
              await api(`/api/accounts/${account.id}`, { method: "DELETE", body: {} });
              await refreshAccounts();
              renderAccountList();
            } catch (e2) {
              toast(e2.message);
            }
          },
        }, "Remove"),
      ),
    );
  }
}

function renderProviderFields() {
  const provider = state.providers.find((p) => p.kind === $("acc-kind").value);
  const box = $("acc-fields");
  box.replaceChildren();
  for (const field of provider?.fields ?? []) {
    if (field.type === "checkbox") {
      box.append(
        el("label", { class: "check field" },
          el("input", { type: "checkbox", "data-field": field.name, checked: field.default === true }),
          el("span", {}, field.label, field.help && el("small", { class: "muted" }, field.help)),
        ),
      );
      continue;
    }
    box.append(
      el("label", { class: "field" },
        el("span", {}, field.label),
        el("input", {
          type: field.type, "data-field": field.name, placeholder: field.placeholder ?? "",
          autocomplete: "off", required: field.required,
        }),
        field.help && el("small", { class: "muted" }, field.help),
      ),
    );
  }
}

async function addAccount(event) {
  event.preventDefault();
  say("acc-msg", "Checking…", true);
  const config = {};
  for (const input of document.querySelectorAll("#acc-fields input")) {
    config[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value.trim();
  }
  try {
    const r = await api("/api/accounts", {
      method: "POST",
      body: { kind: $("acc-kind").value, label: $("acc-label").value, config },
    });
    say("acc-msg", r.detail, true);
    $("acc-label").value = "";
    renderProviderFields();
    await refreshAccounts();
    renderAccountList();
  } catch (e) {
    say("acc-msg", e.message, false);
  }
}

// ---- connecting platforms

async function loadConnectors() {
  state.connectors = await api("/api/connectors");
  const open = new Set([...document.querySelectorAll("details.connector[open]")].map((d) => d.dataset.id));
  const moreWasOpen = document.querySelector("details.more")?.open ?? false;
  const root = $("connectors");
  const main = state.connectors.filter((c) => !c.optional);
  const more = state.connectors.filter((c) => c.optional);
  root.replaceChildren(
    ...main.map((c) => renderConnector(c, open.has(c.id))),
    more.length > 0 &&
      el("details", { class: "more", open: moreWasOpen || more.some((c) => open.has(c.id)) },
        el("summary", { class: "small" }, "More platforms (each needs a paid plan or an approval; a Manual account covers them in the meantime)"),
        ...more.map((c) => renderConnector(c, open.has(c.id))),
      ),
  );
}

function renderConnector(c, isOpen) {
  const inputs = c.appFields.map((f) =>
    el("label", { class: "field" },
      el("span", {}, f.label),
      el("input", {
        type: f.type === "password" ? "password" : "text",
        "data-app": f.name,
        value: f.value,
        autocomplete: "off",
        placeholder: f.hasValue && f.type === "password" ? "•••••••• (saved; type to replace)" : (f.placeholder ?? ""),
      }),
      f.help && el("small", { class: "muted" }, f.help),
    ),
  );
  const msg = el("span", { class: "small" });
  const pasteInput = el("input", { type: "text", placeholder: "Paste the whole address here", style: "margin-top:6px" });

  const save = async () => {
    const body = {};
    for (const input of inputs.flatMap((l) => [...l.querySelectorAll("input")])) body[input.dataset.app] = input.value;
    try {
      await api(`/api/connectors/${c.id}/app`, { method: "PUT", body });
      msg.textContent = "Saved";
      msg.className = "small ok";
      await loadConnectors();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "small err";
    }
  };

  const connect = async () => {
    try {
      await save();
      const { url } = await api(`/api/connectors/${c.id}/start`, { method: "POST", body: {} });
      location.href = url; // the platform sends you back here when you approve
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "small err";
    }
  };

  const tokenInput = el("input", { type: "password", placeholder: "Paste the access token here", autocomplete: "off", style: "margin-top:6px" });
  const useToken = async () => {
    try {
      const { token } = await api(`/api/connectors/${c.id}/token`, { method: "POST", body: { token: tokenInput.value } });
      tokenInput.value = "";
      await showPending(token);
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "small err";
    }
  };

  const finishPasted = async () => {
    try {
      const { token } = await api(`/api/connectors/${c.id}/paste`, { method: "POST", body: { url: pasteInput.value } });
      await showPending(token);
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "small err";
    }
  };

  return el("details", { class: "connector", "data-id": c.id, open: isOpen },
    el("summary", {},
      el("span", { class: "name" }, c.label),
      el("span", { class: "provides" }, c.provides),
      el("span", { class: `pill ${c.configured ? "ok" : ""}` }, c.configured ? "Ready to connect" : "Needs setup"),
    ),
    el("div", { class: "body" },
      el("p", { class: "small", style: "margin:10px 0 4px" }, c.help),
      el("div", { class: "small muted" }, "Register this address on the platform:"),
      el("code", { class: "addr" }, c.redirectUri),
      ...inputs,
      el("div", { class: "row" },
        el("button", { onclick: save }, "Save"),
        el("button", {
          class: "primary", onclick: connect, disabled: c.connectBlocked,
          title: c.connectBlocked ? "This platform's sign-in page refuses http:// addresses. Use the token option below." : "",
        }, `Connect ${c.label}`),
        c.connectBlocked && el("span", { class: "small muted" }, "Needs https, so use the token option below"),
        msg,
      ),
      c.acceptsToken && c.tokenHelp && el("details", { style: "margin-top:10px", open: c.connectBlocked },
        el("summary", { class: "small" }, c.tokenHelp.summary),
        el("ol", { class: "small muted", style: "padding-left:18px" }, c.tokenHelp.steps.map((step) => el("li", {}, step))),
        tokenInput,
        el("div", { class: "row" }, el("button", { class: "primary", onclick: useToken }, "Use this token")),
      ),
      el("details", { style: "margin-top:10px" },
        el("summary", { class: "small" }, "The platform wouldn't send me back here?"),
        el("p", { class: "small muted" }, "After you approve, copy the address from the browser's address bar (even if the page failed to load) and paste it here."),
        pasteInput,
        el("div", { class: "row" }, el("button", { onclick: finishPasted }, "Finish connecting")),
      ),
    ),
  );
}

async function showPending(token) {
  state.pendingToken = token;
  const items = await api(`/api/pending/${encodeURIComponent(token)}`);
  const list = $("connect-list");
  $("connect-results").replaceChildren();
  list.replaceChildren(
    ...items.map((item) =>
      el("div", { class: "connect-item", "data-index": item.index },
        el("input", { type: "checkbox", checked: true, "aria-label": `Add ${item.label}` }),
        el("div", { class: "grow" },
          el("strong", {}, item.label),
          el("div", { class: "small muted" }, item.alreadyAdded ? "Already added, will be refreshed with the new sign-in" : item.detail),
          el("input", { type: "text", "data-role": "label", value: item.label, "aria-label": "Name shown in this app" }),
          ...item.extraFields.map((f) =>
            el("label", { class: "field" },
              el("span", {}, f.label),
              el("input", { type: "text", "data-extra": f.name, value: typeof f.default === "string" ? f.default : "" }),
              f.help && el("small", { class: "muted" }, f.help),
            ),
          ),
        ),
      ),
    ),
  );
  $("connect-add").disabled = false;
  $("connect-dialog").showModal();
}

async function addSelected() {
  const picks = [...document.querySelectorAll("#connect-list .connect-item")]
    .filter((row) => row.querySelector('input[type="checkbox"]').checked)
    .map((row) => ({
      index: Number(row.dataset.index),
      label: row.querySelector('[data-role="label"]').value,
      extra: Object.fromEntries([...row.querySelectorAll("[data-extra]")].map((i) => [i.dataset.extra, i.value])),
    }));
  if (!picks.length) return toast("Tick at least one account.");
  $("connect-add").disabled = true;
  try {
    const results = await api(`/api/pending/${encodeURIComponent(state.pendingToken)}/add`, { method: "POST", body: { picks } });
    $("connect-results").replaceChildren(
      ...results.map((r) => el("div", { class: `result ${r.ok ? "ok" : "err"}` }, `${r.ok ? "Added" : "Couldn't add"} ${r.label}: ${r.detail}`)),
    );
    await refreshAccounts();
    renderAccountList();
    if (results.every((r) => r.ok)) {
      $("connect-list").replaceChildren();
    } else {
      $("connect-add").disabled = false;
    }
  } catch (e) {
    toast(e.message);
    $("connect-add").disabled = false;
  }
}

// ---- image host

async function loadHost() {
  const h = await api("/api/host");
  $("host-endpoint").value = h.endpoint;
  $("host-bucket").value = h.bucket;
  $("host-public").value = h.publicBaseUrl;
  $("host-key").value = h.accessKeyId;
  $("host-region").value = h.region;
  $("host-secret").value = "";
  $("host-secret").placeholder = h.secretSet ? "•••••••• (saved; type to replace)" : "";
  $("host-secret-state").textContent = h.secretSet ? "(saved)" : "";
}

async function saveHost() {
  try {
    await api("/api/host", {
      method: "PUT",
      body: {
        endpoint: $("host-endpoint").value,
        bucket: $("host-bucket").value,
        publicBaseUrl: $("host-public").value,
        accessKeyId: $("host-key").value,
        secretAccessKey: $("host-secret").value,
        region: $("host-region").value,
      },
    });
    say("host-msg", "Saved", true);
    await loadHost();
    await refreshStatus();
  } catch (e) {
    say("host-msg", e.message, false);
  }
}

async function testHost() {
  say("host-msg", "Testing…", true);
  await saveHost();
  const r = await api("/api/host/test", { method: "POST", body: {} });
  say("host-msg", r.detail, r.ok);
}

async function saveSettings() {
  say("settings-msg", "", true);
  const body = {
    styleGuide: $("set-style").value,
    claudeModel: $("set-model").value,
    missedGraceMinutes: Number($("set-grace").value),
    keepAwake: $("set-awake").checked,
  };
  if ($("set-key").value.trim()) body.apiKey = $("set-key").value;
  try {
    await api("/api/settings", { method: "PUT", body });
    say("settings-msg", "Saved", true);
    await refreshStatus();
    await loadSettings();
  } catch (e) {
    say("settings-msg", e.message, false);
  }
}

// ------------------------------------------------------------------ wiki table rows

let wikiQuery = null; // { post: id } or { days: n }
let wikiTyped = {}; // answers typed for the subject cell's blanks, kept while the dialog is open

async function refreshWiki() {
  const params = new URLSearchParams(wikiQuery);
  params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (Object.keys(wikiTyped).length) params.set("values", JSON.stringify(wikiTyped));
  try {
    const data = await api(`/api/export/wiki?${params}`);
    $("wiki-text").value = data.text;
    // Blanks in the subject cell that still need an answer (only when it is a single post).
    const blanks = wikiQuery.post ? (data.rows[0]?.blanks ?? []) : [];
    const typedNames = Object.keys(wikiTyped);
    const shown = [...new Set([...typedNames, ...blanks.map((b) => b.toLowerCase())])];
    $("wiki-blanks").replaceChildren(
      ...shown.map((key) => {
        const label = blanks.find((b) => b.toLowerCase() === key) ?? key;
        return el("label", { class: "field fill-field" },
          el("span", {}, label),
          el("input", { type: "text", "data-wiki-key": key, value: wikiTyped[key] ?? "", oninput: (e) => { wikiTyped[key] = e.target.value; clearTimeout(refreshWiki.timer); refreshWiki.timer = setTimeout(refreshWiki, 350); } }),
        );
      }),
    );
    const missing = data.rows.filter((r) => r.missingLinks.length);
    $("wiki-missing").textContent = data.rows.length === 0
      ? "Nothing has been published in that time."
      : missing.length
        ? `No link was recorded for ${[...new Set(missing.flatMap((r) => r.missingLinks))].join(", ")} (posted by hand without pasting its link), so those cells are empty. Paste the link when you mark a post as posted.`
        : "";
  } catch (e) {
    $("wiki-text").value = "";
    $("wiki-missing").textContent = e.message;
  }
}

function openWiki(query) {
  wikiQuery = query;
  wikiTyped = {};
  $("wiki-title").textContent = query.post ? "Wiki table row" : `Wiki table rows (last ${query.days} days)`;
  refreshWiki().then(() => {
    const first = $("wiki-blanks").querySelector("input");
    if (first) first.focus();
  });
  $("wiki-dialog").showModal();
}

// ------------------------------------------------------------------ templates for recurring posts

const shortName = (name) => name.split(":")[0].trim();
const dayLabel = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

async function loadTemplates() {
  const loaded = await api("/api/templates");
  state.templates = loaded.templates;
  state.skips = loaded.skips ?? {};
  renderDue();
  renderTemplateList();
}

/** The row on the Schedule tab: what is due in the next 7 days from the templates, and what has already been scheduled. */
function renderDue() {
  const items = dueList(state.templates, state.posts, new Date(), 7, state.skips);
  const skipped = items.filter((i) => i.skipped && !i.scheduled);
  const open = items.filter((i) => !i.skipped || i.scheduled);
  $("due").hidden = items.length === 0;
  $("due-list").replaceChildren(
    ...open.map((item) =>
      item.scheduled
        ? el("span", { class: "due-chip done", title: `${item.template.name}: already scheduled` }, `✓ ${shortName(item.template.name)} · ${dayLabel(item.when)}`)
        : el("span", { class: "due-group" },
            el("button", { class: "due-chip", type: "button", title: `Start the post: ${item.template.name}`, onclick: () => openFill(item.template, item) }, `${shortName(item.template.name)} · ${dayLabel(item.when)}`),
            el("button", { class: "due-skip", type: "button", title: `Not happening this week: ${item.template.name}`, "aria-label": `Skip ${item.template.name} on ${dayLabel(item.when)}`, onclick: () => setSkipped(item, true) }, "✕"),
          ),
    ),
  );
  $("due-skipped").hidden = skipped.length === 0;
  $("due-skipped-list").replaceChildren(
    ...skipped.map((item) => el("button", { class: "link", type: "button", title: "Bring it back", onclick: () => setSkipped(item, false) }, `${shortName(item.template.name)} · ${dayLabel(item.when)}`)),
  );
}

/** Says a regular post isn't happening on that day (or brings it back). */
async function setSkipped(item, skipped) {
  try {
    const result = await api(`/api/templates/${item.template.id}/skip`, { method: "POST", body: { day: isoDay(item.when), skipped } });
    state.skips = result.skips;
    renderDue();
  } catch (e) {
    toast(e.message);
  }
}

function setTemplateLink(link) {
  state.templateLink = link;
  $("from-template").hidden = !link;
  $("from-template-name").textContent = link?.name ?? "";
}

// ---- filling a template in

let fill = null; // { template, when, rule }

function fillValues() {
  const values = {};
  for (const input of document.querySelectorAll("#fill-fields input[data-key]")) values[input.dataset.key] = input.value;
  return values;
}

function renderFillFields() {
  const { template, rule } = fill;
  const ruleDefaults = Object.fromEntries(Object.entries(rule?.defaults ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const blanks = placeholdersOf(`${template.body}\n${template.title}`);
  const box = $("fill-fields");
  box.replaceChildren(
    ...blanks.map((p) =>
      el("label", { class: "field fill-field" },
        el("span", {}, p.name, p.optional && el("em", { class: "muted" }, " (optional)")),
        el("input", { type: "text", "data-key": p.key, value: ruleDefaults[p.key] ?? p.default, oninput: updateFillPreview }),
      ),
    ),
  );
  if (blanks.length === 0) box.append(el("p", { class: "muted small" }, "This template has nothing to fill in."));
  $("fill-when").textContent = fill.when
    ? `Due ${fill.when.toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${rule ? ` (${describeRule(rule)})` : ""}. The date and time are filled in for you.`
    : "This template has no regular day, so choose the date and time yourself.";
  updateFillPreview();
  box.querySelector("input")?.focus();
}

function updateFillPreview() {
  const text = fillTemplate(fill.template.body, fillValues());
  $("fill-preview").value = text;
  const missing = [...new Set([...leftoverPlaceholders(text), ...leftoverPlaceholders(fillTemplate(fill.template.title, fillValues()))])];
  $("fill-use").disabled = missing.length > 0;
  say("fill-msg", missing.length ? `Still to fill in: ${missing.map((m) => m.replace(/[{}]/g, "")).join(", ")}` : "", false);
}

/** Opens the dialog. With no template given the person picks one from a list. */
function openFill(template = null, item = null) {
  const picker = $("fill-select");
  const usable = state.templates.filter((t) => t.active || t === template);
  picker.replaceChildren(...usable.map((t) => el("option", { value: t.id }, t.name)));
  $("fill-pick-row").hidden = template !== null && item !== null;
  const start = (t, chosenItem) => {
    const next = chosenItem ?? nextDue(t, new Date());
    fill = { template: t, when: next?.when ?? null, rule: next?.rule ?? null };
    $("fill-title").textContent = t.name;
    renderFillFields();
  };
  if (usable.length === 0) {
    toast("There are no templates yet. Add one in the Templates tab.");
    return;
  }
  const first = template ?? usable[0];
  picker.value = String(first.id);
  picker.onchange = () => start(state.templates.find((t) => t.id === Number(picker.value)), null);
  start(first, item);
  $("fill-dialog").showModal();
}

function applyFill() {
  const { template, when } = fill;
  const values = fillValues();
  const text = fillTemplate(template.body, values);
  const title = fillTemplate(template.title, values);
  if (!state.selected) startTextOnly(); // no picture chosen yet: begin a text post; a picture can be added from the library after
  else { $("compose").hidden = false; showComposeMode(); }
  $("text").value = text;
  $("title").value = title;
  if (when && when.getTime() > Date.now() + 2 * 60_000) {
    $("when").value = toLocalInput(when);
  } else if (when) {
    // Today's usual time has already gone by, and a post can't be scheduled in the past.
    setQuick("60");
    toast("Its usual time today has passed, so the time is set to an hour from now. Change it if you like.");
  }
  const wanted = template.accountIds;
  if (wanted.length) {
    for (const box of document.querySelectorAll("#account-checks input[data-account]")) {
      box.checked = wanted.includes(Number(box.dataset.account)) && !box.disabled;
    }
    onAccountChange();
  }
  renderCounters();
  renderTitleField();
  setTemplateLink({ id: template.id, name: template.name, values });
  showTab("schedule");
  $("text").focus();
}

// ---- managing templates

let editingTemplate = null; // a template object, {} for a new one, or null

function renderTemplateList() {
  const list = $("tpl-list");
  list.replaceChildren(
    ...state.templates.map((t) =>
      el("button", { class: `tpl-item ${t.active ? "" : "off"}`, type: "button", "aria-pressed": String(editingTemplate?.id === t.id), onclick: () => editTemplate(t) },
        el("strong", {}, t.name),
        el("span", { class: "rules" }, t.rules.length ? t.rules.map(describeRule).join(" · ") : "No regular day"),
      ),
    ),
  );
  if (state.templates.length === 0) list.append(el("p", { class: "empty" }, "No templates yet."));
}

const parseDefaults = (text) =>
  Object.fromEntries(
    text.split(";").map((part) => part.split("=")).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join("=").trim()]),
  );
const formatDefaults = (d) => Object.entries(d ?? {}).map(([k, v]) => `${k}=${v}`).join("; ");

function addRuleRow(rule = { kind: "weekly", weekday: 1, time: "09:00" }) {
  const nth = el("select", { "aria-label": "Which week" },
    ...[[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [5, "last"]].map(([v, label]) => el("option", { value: v }, label)));
  nth.value = String(rule.nth ?? 1);
  const kind = el("select", { "aria-label": "How often" },
    el("option", { value: "weekly" }, "Every week on"), el("option", { value: "monthly" }, "Monthly, the"));
  kind.value = rule.kind;
  const weekday = el("select", { "aria-label": "Day of the week" }, ...WEEKDAYS.map((d, i) => el("option", { value: i }, d)));
  weekday.value = String(rule.weekday);
  const time = el("input", { type: "time", value: rule.time, "aria-label": "Time", required: true });
  const defaults = el("input", { type: "text", class: "defaults", value: formatDefaults(rule.defaults), placeholder: "Pre-fill the blanks for this day, e.g.  time=8pm ET; host=Ann", "aria-label": "Pre-filled answers for this day" });
  const sync = () => { nth.hidden = kind.value !== "monthly"; };
  kind.addEventListener("change", sync);
  sync();
  const row = el("div", { class: "rule-row", "data-rule": "" },
    kind, nth, weekday, time,
    el("button", { type: "button", class: "link", onclick: () => row.remove() }, "Remove"),
    defaults,
  );
  row.read = () => ({
    kind: kind.value,
    weekday: Number(weekday.value),
    time: time.value,
    ...(kind.value === "monthly" ? { nth: Number(nth.value) } : {}),
    defaults: parseDefaults(defaults.value),
  });
  $("tpl-rules").append(row);
}

function renderBlanksHint() {
  const blanks = placeholdersOf(`${$("tpl-body").value}\n${$("tpl-title").value}`);
  $("tpl-blanks").textContent = blanks.length ? `Blanks to fill each time: ${blanks.map((b) => b.name + (b.optional ? " (optional)" : "")).join(", ")}` : "No blanks yet: this text is used exactly as written.";
}

function editTemplate(template) {
  editingTemplate = template;
  const t = template ?? {};
  $("tpl-form").hidden = false;
  $("tpl-form-title").textContent = t.id ? "Edit template" : "New template";
  $("tpl-name").value = t.name ?? "";
  $("tpl-body").value = t.body ?? "";
  $("tpl-title").value = t.title ?? "";
  $("tpl-active").checked = t.active ?? true;
  $("tpl-wiki-subject").value = t.wikiSubject ?? "";
  $("tpl-wiki-bold").checked = t.wikiBold ?? false;
  $("tpl-wiki-style").value = t.wikiStyle ?? "";
  $("tpl-wiki-playlist").value = t.wikiPlaylist ?? "";
  $("tpl-rules").replaceChildren();
  for (const rule of t.rules ?? []) addRuleRow(rule);
  const chosen = new Set(t.accountIds ?? []);
  $("tpl-accounts").replaceChildren(
    ...state.accounts.map((a) =>
      el("label", { class: "check" }, el("input", { type: "checkbox", "data-tpl-account": a.id, checked: chosen.has(a.id) }), el("span", {}, `${a.label} `, el("span", { class: "muted small" }, `(${a.kindLabel})`))),
    ),
  );
  $("tpl-duplicate").hidden = !t.id;
  $("tpl-delete").hidden = !t.id;
  say("tpl-msg", "", true);
  renderBlanksHint();
  renderTemplateList();
  $("tpl-name").focus();
}

function templateFromForm() {
  return {
    name: $("tpl-name").value,
    body: $("tpl-body").value,
    title: $("tpl-title").value,
    active: $("tpl-active").checked,
    wikiSubject: $("tpl-wiki-subject").value,
    wikiBold: $("tpl-wiki-bold").checked,
    wikiStyle: $("tpl-wiki-style").value,
    wikiPlaylist: $("tpl-wiki-playlist").value,
    rules: [...document.querySelectorAll("#tpl-rules [data-rule]")].map((row) => row.read()),
    accountIds: [...document.querySelectorAll("#tpl-accounts input[data-tpl-account]:checked")].map((i) => Number(i.dataset.tplAccount)),
  };
}

async function saveTemplate(event) {
  event.preventDefault();
  try {
    const body = templateFromForm();
    const saved = editingTemplate?.id
      ? await api(`/api/templates/${editingTemplate.id}`, { method: "PATCH", body })
      : await api("/api/templates", { method: "POST", body });
    await loadTemplates();
    editTemplate(state.templates.find((t) => t.id === saved.template.id) ?? null);
    say("tpl-msg", "Saved.", true);
  } catch (e) {
    say("tpl-msg", e.message, false);
  }
}

async function copyTemplate() {
  try {
    const body = { ...templateFromForm(), name: `Copy of ${$("tpl-name").value}`.slice(0, 80) };
    const made = await api("/api/templates", { method: "POST", body });
    await loadTemplates();
    editTemplate(state.templates.find((t) => t.id === made.template.id) ?? null);
    say("tpl-msg", "Made a copy. Give it its own name and wording, then save.", true);
  } catch (e) {
    say("tpl-msg", e.message, false);
  }
}

async function deleteTemplate() {
  if (!editingTemplate?.id || !confirm(`Delete the template "${editingTemplate.name}"? Posts already made from it are not affected.`)) return;
  try {
    await api(`/api/templates/${editingTemplate.id}`, { method: "DELETE", body: {} });
    editingTemplate = null;
    $("tpl-form").hidden = true;
    await loadTemplates();
  } catch (e) {
    say("tpl-msg", e.message, false);
  }
}

// ------------------------------------------------------------------ wiring

async function init() {
  const params0 = new URLSearchParams(location.search);
  const me = await fetch("/auth/me", { cache: "no-store" });
  if (me.status === 401) {
    state.me = { mode: "google", user: null, csrf: "" };
    const why = params0.get("loginError");
    if (why) history.replaceState(null, "", location.pathname);
    showLogin(why ?? "");
    return;
  }
  state.me = await me.json();
  if (state.me.mode === "google") {
    $("who").hidden = false;
    $("who-name").textContent = state.me.user.name || state.me.user.email;
    $("signout").addEventListener("click", async () => {
      try { await api("/auth/logout", { method: "POST", body: {} }); } catch { /* signing out anyway */ }
      location.reload();
    });
  }
  // The Settings tab is for administrators.
  document.querySelector('#tabs [data-tab="settings"]').hidden = !isAdmin();
  const loginError = params0.get("loginError");
  if (loginError) { history.replaceState(null, "", location.pathname); toast(loginError); }

  $("tz").textContent = `(${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

  for (const button of document.querySelectorAll("#tabs button")) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
  $("upload-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", () => uploadFiles($("file-input").files));
  // Drop files anywhere on the page. The counter keeps the overlay steady while the pointer crosses child elements.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add("dragging"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    showTab("schedule");
    uploadFiles(e.dataTransfer.files);
  });
  $("text").addEventListener("input", renderCounters);
  $("text-only").addEventListener("click", startTextOnly);
  $("remove-image").addEventListener("click", startTextOnly);
  $("draft-btn").addEventListener("click", () => draftWithClaude("text"));
  $("alt-btn").addEventListener("click", () => draftWithClaude("alt"));
  $("schedule-btn").addEventListener("click", schedule);
  for (const button of document.querySelectorAll("[data-quick]")) {
    button.addEventListener("click", () => setQuick(button.dataset.quick));
  }
  $("acc-kind").addEventListener("change", renderProviderFields);
  // wiki table rows
  $("wiki-recent").addEventListener("click", () => openWiki({ days: 7 }));
  $("wiki-close").addEventListener("click", () => $("wiki-dialog").close());
  $("wiki-copy").addEventListener("click", () => copyToClipboard($("wiki-text").value));

  // templates
  $("use-template").addEventListener("click", () => openFill(null, null));
  $("fill-cancel").addEventListener("click", () => $("fill-dialog").close());
  $("fill-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("fill-use").disabled) { applyFill(); $("fill-dialog").close(); }
  });
  $("from-template-clear").addEventListener("click", () => setTemplateLink(null));
  $("tpl-new").addEventListener("click", () => editTemplate({}));
  $("tpl-form").addEventListener("submit", saveTemplate);
  $("tpl-add-rule").addEventListener("click", () => addRuleRow());
  $("tpl-duplicate").addEventListener("click", copyTemplate);
  $("tpl-delete").addEventListener("click", deleteTemplate);
  $("tpl-cancel").addEventListener("click", () => { editingTemplate = null; $("tpl-form").hidden = true; renderTemplateList(); });
  $("tpl-body").addEventListener("input", renderBlanksHint);
  $("tpl-title").addEventListener("input", renderBlanksHint);

  $("backup-now").addEventListener("click", async () => {
    $("backup-now").disabled = true;
    say("backup-msg", "Backing up…", true);
    try {
      await api("/api/backup/run", { method: "POST", body: {} });
      say("backup-msg", "Done.", true);
    } catch (e) {
      say("backup-msg", e.message, false);
    }
    loadBackup();
  });
  $("team-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/users", { method: "POST", body: { email: $("team-email").value, name: $("team-name").value, role: $("team-role").value } });
      $("team-email").value = "";
      $("team-name").value = "";
      say("team-msg", "Added. They can now sign in with that Google account.", true);
      loadTeam();
    } catch (err) {
      say("team-msg", err.message, false);
    }
  });
  $("account-form").addEventListener("submit", addAccount);
  $("settings-save").addEventListener("click", saveSettings);
  $("host-save").addEventListener("click", saveHost);
  $("host-test").addEventListener("click", testHost);
  $("connect-add").addEventListener("click", addSelected);
  $("connect-close").addEventListener("click", () => $("connect-dialog").close());

  $("channel-cancel").addEventListener("click", () => $("channel-dialog").close());
  $("channel-form").addEventListener("submit", saveChannel);
  $("edit-cancel").addEventListener("click", () => $("edit-dialog").close());
  $("edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/posts/${editing.id}`, {
        method: "PATCH",
        body: {
          text: $("edit-text").value,
          title: $("edit-title-field").hidden ? undefined : $("edit-title").value,
          altText: $("edit-alt").value,
          scheduledAt: new Date($("edit-when").value).toISOString(),
        },
      });
      $("edit-dialog").close();
      toast("Saved");
      loadQueue();
    } catch (e) {
      say("edit-msg", e.message, false);
    }
  });

  state.providers = await api("/api/providers");
  $("acc-kind").replaceChildren(...state.providers.map((p) => el("option", { value: p.kind }, p.label)));
  renderProviderFields();

  await Promise.all([refreshStatus(), refreshAccounts()]);
  await loadLibrary();
  await loadTemplates().catch(() => {});
  refreshQueueBadge();

  let tab = "schedule";
  try { tab = localStorage.getItem("tab") || "schedule"; } catch { /* ignore */ }

  // Coming back from a platform's sign-in page.
  const params = new URLSearchParams(location.search);
  const connected = params.get("connected");
  const connectError = params.get("connectError");
  if (connected || connectError) {
    history.replaceState(null, "", location.pathname);
    tab = "settings";
  }
  showTab(tab);
  if (connectError) toast(connectError);
  if (connected) {
    try { await showPending(connected); } catch (e) { toast(e.message); }
  }

  // Keep the queue and badge fresh while the page is open.
  setInterval(() => {
    if (document.hidden) return;
    refreshStatus();
    if (!$("tab-queue").hidden) loadQueue();
    else refreshQueueBadge();
  }, 15_000);
}

init().catch((e) => toast(e.message));
