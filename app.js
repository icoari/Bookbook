/* =========================================================
   BookStudio — Ulysses/Notion-like (EN)
   - Sections: Chapters (draft), Library, Settings
   - Total wordcount under title
   - Chapter list: modified + words + chars
   - Rename chapters inline
   - Annotation + Create Card from selection
   - 4 columns: workspace / list / editor / inspector
     Inspector tabs: Annotations + Card preview
   - Conditional links appear immediately after card creation/update
   ========================================================= */

const DB = localforage.createInstance({ name: "bookstudio_simple_v3" });

const KEY = {
  meta: "meta",
  draft: "draft",
  library: "library",
  comments: "comments",
};

const $ = (id) => document.getElementById(id);
const nowISO = () => new Date().toISOString();
const fmtTime = (d) => new Date(d).toLocaleString();
const uid = (p="id") => `${p}_${Math.random().toString(16).slice(2)}_${Date.now()}`;

function escapeHtml(str){
  return (str||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function safeFilename(name){
  return (name||"export").replace(/[^a-z0-9_\-]+/gi,"_").replace(/_+/g,"_").replace(/^_+|_+$/g,"").toLowerCase() || "export";
}
function splitComma(s){
  return (s||"").split(",").map(x=>x.trim()).filter(Boolean);
}
function escapeRegExp(s){
  return (s||"").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function debounce(fn, ms){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Counting ---------- */
function plainTextFromDelta(delta){
  try{
    if (!delta || !delta.ops) return "";
    return delta.ops.map(op => typeof op.insert === "string" ? op.insert : "").join("");
  }catch{ return ""; }
}
function countWordsChars(text){
  const t = (text || "").replace(/\s+$/g, "");
  const words = t.trim() ? t.trim().split(/\s+/).filter(Boolean).length : 0;
  const chars = t.length;
  return { words, chars };
}
function projectTotals(){
  let w = 0, c = 0;
  for (const ch of state.draft){
    const t = plainTextFromDelta(ch.delta);
    const x = countWordsChars(t);
    w += x.words; c += x.chars;
  }
  return { words: w, chars: c };
}

/* ---------- State ---------- */
let state = {
  meta: {
    projectName: "My Novel",
    categories: ["Characters", "Places"],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  },
  section: "draft",
  selectedId: null,

  draft: [],
  library: [],
  comments: {},

  hasInitialized: false,
};

let quill = null;
let activeDocId = null;

/* Faster linking on create/update */
const saveSoon = debounce(saveAll, 400);
const relinkSoon = debounce(refreshCardLinks, 250);

/* ---------- UI refs ---------- */
const navItems = Array.from(document.querySelectorAll(".nav-item"));
const listEl = $("list");
const listTitle = $("listTitle");
const listFilter = $("listFilter");
const listEmpty = $("listEmpty");

const projectTitle = $("projectTitle");
const projectSub = $("projectSub");

const saveStateEl = $("saveState");
const lastSavedEl = $("lastSaved");

const btnAdd = $("btnAdd");
const btnNewItem = $("btnNewItem");
const btnDelete = $("btnDelete");
const btnAnnotate = $("btnAnnotate");
const btnMakeCard = $("btnMakeCard");

const btnExportProject = $("btnExportProject");
const importFile = $("importFile");

const btnSearch = $("btnSearch");
const globalSearch = $("globalSearch");

const projectName = $("projectName");
const libraryCategories = $("libraryCategories");
const libraryCategoryFilter = $("libraryCategoryFilter");

const btnWipeAll = $("btnWipeAll");

/* Editor header title */
const editorTitleStatic = $("editorTitleStatic");
const editorTitleInput = $("editorTitleInput");
const editorMeta = $("editorMeta");

/* Wraps */
const draftEditorWrap = $("draftEditorWrap");
const libraryEditorWrap = $("libraryEditorWrap");
const settingsWrap = $("settingsWrap");

/* Comments */
const commentsList = $("commentsList");
const commentsEmpty = $("commentsEmpty");
const btnClearComments = $("btnClearComments");

/* Annotation Modal */
const modal = $("modal");
const modalClose = $("modalClose");
const modalCancel = $("modalCancel");
const modalSave = $("modalSave");
const modalSelection = $("modalSelection");
const modalComment = $("modalComment");

/* Start Modal */
const startModal = $("startModal");
const startProjectName = $("startProjectName");
const btnCreateProject = $("btnCreateProject");
const startImportFile = $("startImportFile");

/* Library editor */
const cardCategory = $("cardCategory");
const cardTitle = $("cardTitle");
const fieldKey = $("fieldKey");
const fieldValue = $("fieldValue");
const btnAddField = $("btnAddField");
const fieldsList = $("fieldsList");
const cardBody = $("cardBody");
const btnSaveCard = $("btnSaveCard");

/* Inspector tabs & card preview */
const inspectorTabs = Array.from(document.querySelectorAll(".inspector-tab"));
const inspectorAnnotations = $("inspectorAnnotations");
const inspectorCard = $("inspectorCard");

const inspectorCardTitle = $("inspectorCardTitle");
const inspectorCardMeta = $("inspectorCardMeta");
const inspectorCardFields = $("inspectorCardFields");
const inspectorCardBody = $("inspectorCardBody");
const inspectorCardEmpty = $("inspectorCardEmpty");
const btnOpenInLibrary = $("btnOpenInLibrary");

let inspectorCardId = null;

/* ---------- Save indicator ---------- */
function setSaveState(mode){
  // user asked: replace “sauvegardé” -> “Save” and keep UI in English
  // We keep it ultra minimal.
  const map = { idle: "Save", saving: "Saving…", saved: "Save", error: "Error" };
  saveStateEl.textContent = map[mode] || "Save";
}
function setLastSaved(iso){
  lastSavedEl.textContent = iso ? fmtTime(iso) : "—";
}

/* ---------- Persistence ---------- */
async function loadAll(){
  const meta = await DB.getItem(KEY.meta);
  const draft = await DB.getItem(KEY.draft);
  const lib = await DB.getItem(KEY.library);
  const comments = await DB.getItem(KEY.comments);

  if (meta) state.meta = meta;
  state.draft = draft || [];
  state.library = lib || [];
  state.comments = comments || {};

  if (!state.draft.length && !state.library.length){
    startModal.classList.add("show");
    startModal.setAttribute("aria-hidden", "false");
    startProjectName.value = state.meta.projectName || "My Novel";
    return false;
  }

  if (!state.draft.length){
    state.draft.push(makeDefaultChapter(1));
  }

  state.selectedId = state.selectedId || state.draft[0]?.id || null;

  syncTopUI();
  syncSettingsUI();
  setLastSaved(state.meta.updatedAt || null);
  return true;
}

async function saveAll(){
  try{
    setSaveState("saving");
    state.meta.updatedAt = nowISO();

    await DB.setItem(KEY.meta, state.meta);
    await DB.setItem(KEY.draft, state.draft);
    await DB.setItem(KEY.library, state.library);
    await DB.setItem(KEY.comments, state.comments);

    setSaveState("saved");
    setLastSaved(state.meta.updatedAt);
    syncTopUI();
  } catch(e){
    console.error(e);
    setSaveState("error");
  }
}

function syncTopUI(){
  projectTitle.textContent = state.meta.projectName || "My Novel";
  const totals = projectTotals();
  projectSub.textContent = `${totals.words.toLocaleString("en-US")} words`;
}

function syncSettingsUI(){
  projectName.value = state.meta.projectName || "My Novel";
  libraryCategories.value = (state.meta.categories || []).join(", ");
  rebuildCategorySelects();
}

/* ---------- Project file export/import ---------- */
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportProjectFile(){
  const payload = {
    format: "bookstudio_project_v3",
    exportedAt: nowISO(),
    data: {
      meta: state.meta,
      draft: state.draft,
      library: state.library,
      comments: state.comments
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(state.meta.projectName)}.bookstudio.json`);
}

async function importProjectFile(file){
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); } catch { alert("Invalid file."); return; }
  const d = obj?.data || obj;
  if (!d) { alert("Import failed."); return; }

  state.meta = d.meta || state.meta;
  state.draft = d.draft || [];
  state.library = d.library || [];
  state.comments = d.comments || {};

  if (!state.draft.length) state.draft.push(makeDefaultChapter(1));
  state.selectedId = state.draft[0]?.id || null;

  startModal.classList.remove("show");
  startModal.setAttribute("aria-hidden", "true");

  syncTopUI();
  syncSettingsUI();

  initQuillOnce();
  setSection("draft");
  renderList();
  renderRight();
  await saveAll();

  // refresh links immediately on import
  refreshCardLinks();
}

/* ---------- Startup create project ---------- */
function makeDefaultChapter(n){
  return {
    id: uid("d"),
    title: `Chapter ${n}`,
    delta: { ops: [{ insert: "\n" }] },
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

async function createNewProject(name){
  state.meta.projectName = (name || "My Novel").trim() || "My Novel";
  state.meta.categories = state.meta.categories?.length ? state.meta.categories : ["Characters", "Places"];
  state.meta.createdAt = nowISO();
  state.meta.updatedAt = nowISO();

  state.draft = [makeDefaultChapter(1)];
  state.library = [];
  state.comments = {};
  state.selectedId = state.draft[0].id;

  startModal.classList.remove("show");
  startModal.setAttribute("aria-hidden", "true");

  syncTopUI();
  syncSettingsUI();

  initQuillOnce();
  setSection("draft");
  renderList();
  renderRight();

  await saveAll();

  // download project file immediately
  exportProjectFile();
}

/* ---------- Section routing ---------- */
function setSection(section){
  state.section = section;
  navItems.forEach(b => b.classList.toggle("active", b.dataset.section === section));

  if (section === "draft"){
    listTitle.textContent = "Chapters";
    libraryCategoryFilter.style.display = "none";
    showRight("draft");
    btnAnnotate.style.display = "";
    btnMakeCard.style.display = "";
    btnDelete.style.display = "";
    editorTitleStatic.style.display = "none";
    editorTitleInput.style.display = "";

    // keep inspector available + show annotations by default
    setInspectorTab("annotations");
  }

  if (section === "library"){
    listTitle.textContent = "Library";
    libraryCategoryFilter.style.display = "";
    showRight("library");
    btnAnnotate.style.display = "none";
    btnMakeCard.style.display = "none";
    btnDelete.style.display = "";
    editorTitleStatic.style.display = "";
    editorTitleInput.style.display = "none";

    // when editing cards, inspector can still show card preview if needed
    if (inspectorCardId) setInspectorTab("card");
  }

  if (section === "settings"){
    listTitle.textContent = "Settings";
    libraryCategoryFilter.style.display = "none";
    showRight("settings");
    btnAnnotate.style.display = "none";
    btnMakeCard.style.display = "none";
    btnDelete.style.display = "none";
    editorTitleStatic.style.display = "";
    editorTitleInput.style.display = "none";
  }

  ensureSelection();
  renderList();
  renderRight();
}

function showRight(kind){
  draftEditorWrap.style.display = kind === "draft" ? "" : "none";
  libraryEditorWrap.style.display = kind === "library" ? "" : "none";
  settingsWrap.style.display = kind === "settings" ? "" : "none";
}

/* ---------- Inspector tabs ---------- */
function setInspectorTab(tab){
  inspectorTabs.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  inspectorAnnotations.style.display = tab === "annotations" ? "" : "none";
  inspectorCard.style.display = tab === "card" ? "" : "none";
}

/* ---------- Selection & arrays ---------- */
function getCurrentArray(){
  if (state.section === "draft") return state.draft;
  if (state.section === "library") return state.library;
  return [];
}

function ensureSelection(){
  const arr = getCurrentArray();
  if (!arr.length){
    state.selectedId = null;
    return;
  }
  if (!arr.some(x => x.id === state.selectedId)) state.selectedId = arr[0].id;
}

function getSelectedItem(){
  return getCurrentArray().find(x => x.id === state.selectedId) || null;
}

/* ---------- List rendering ---------- */
function renderList(){
  listEl.innerHTML = "";
  const q = (listFilter.value || "").trim().toLowerCase();

  let arr = getCurrentArray().slice();

  if (state.section === "library"){
    const cat = libraryCategoryFilter.value || "ALL";
    if (cat !== "ALL") arr = arr.filter(x => x.category === cat);
    arr.sort((a,b) => (a.title||"").localeCompare(b.title||"", "en"));
  }

  const filtered = arr.filter(item => {
    const hay = state.section === "draft"
      ? `${item.title} ${plainTextFromDelta(item.delta)}`.toLowerCase()
      : `${item.category} ${item.title} ${item.body||""} ${(item.fields||[]).map(f=>`${f.k}:${f.v}`).join(" ")}`.toLowerCase();
    return !q || hay.includes(q);
  });

  listEmpty.style.display = filtered.length ? "none" : "block";

  filtered.forEach(item => {
    const el = document.createElement("div");
    el.className = "item" + (item.id === state.selectedId ? " active" : "");

    if (state.section === "draft"){
      const t = plainTextFromDelta(item.delta);
      const wc = countWordsChars(t);
      const meta = [
        `Modified: ${fmtTime(item.updatedAt || item.createdAt)}`,
        `${wc.words.toLocaleString("en-US")} words · ${wc.chars.toLocaleString("en-US")} chars`
      ].join("\n");

      el.innerHTML = `
        <div class="item-title">${escapeHtml(item.title || "(untitled)")}</div>
        <div class="item-meta">${escapeHtml(meta)}</div>
      `;
    } else {
      el.innerHTML = `
        <div class="item-title">${escapeHtml(item.title || "(untitled)")}</div>
        <div class="item-meta">${escapeHtml(item.category || "—")}</div>
      `;
    }

    el.addEventListener("click", () => {
      state.selectedId = item.id;
      renderList();
      renderRight();

      // in chapters, keep annotations updated
      if (state.section === "draft"){
        renderComments();
      }
    });

    listEl.appendChild(el);
  });
}

/* ---------- Quill init + card links ---------- */
function initQuillOnce(){
  if (state.hasInitialized) return;
  state.hasInitialized = true;

  quill = new Quill("#editor", {
    theme: "snow",
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ["bold", "italic", "underline", "strike"],
        [{ "color": [] }, { "background": [] }],
        [{ "list": "ordered" }, { "list": "bullet" }],
        [{ "align": [] }],
        ["blockquote"],
        ["link"],
        ["clean"]
      ],
      history: { delay: 800, maxStack: 200, userOnly: true }
    },
    placeholder: "Write…"
  });

  // Custom blot for clickable card links
  const Inline = Quill.import("blots/inline");
  class CardLinkBlot extends Inline {
    static blotName = "cardlink";
    static tagName = "span";
    static className = "card-link";
    static create(value){
      const node = super.create();
      node.setAttribute("data-card-id", value);
      return node;
    }
    static formats(node){
      return node.getAttribute("data-card-id");
    }
  }
  Quill.register(CardLinkBlot, true);

  quill.root.addEventListener("click", (e) => {
    const el = e.target.closest(".card-link");
    if (!el) return;
    const id = el.getAttribute("data-card-id");
    if (id) openCardInInspector(id);
  });

  quill.on("text-change", () => {
    if (state.section !== "draft") return;
    const doc = getSelectedItem();
    if (!doc) return;

    doc.delta = quill.getContents();
    doc.updatedAt = nowISO();

    setSaveState("saving");
    saveSoon();

    // update counters & list in near real-time
    syncTopUI();
    renderList();

    // links refresh (fast debounce)
    relinkSoon();
  });
}

/* ---------- Conditional linking (IMMEDIATE) ---------- */
function refreshCardLinks(){
  if (!quill) return;
  if (state.section !== "draft") return;

  const cards = state.library
    .filter(c => (c.title||"").trim().length >= 2)
    .map(c => ({ id: c.id, title: c.title.trim() }));

  const len = quill.getLength();
  try { quill.formatText(0, len, "cardlink", false, "api"); } catch {}

  if (!cards.length) return;

  cards.sort((a,b) => b.title.length - a.title.length);

  const text = quill.getText();
  for (const card of cards){
    const re = new RegExp(`\\b${escapeRegExp(card.title)}\\b`, "gi");
    let m;
    while ((m = re.exec(text)) !== null){
      if (!m[0] || m[0].length === 0) break;
      const idx = m.index;
      try { quill.formatText(idx, card.title.length, "cardlink", card.id, "api"); } catch {}
    }
  }
}

/* ---------- Right rendering ---------- */
function renderRight(){
  const item = getSelectedItem();

  if (state.section === "draft"){
    if (!item) { editorTitleInput.value = ""; return; }

    editorTitleInput.value = item.title || "";
    editorMeta.textContent = ` · ${fmtTime(item.updatedAt || item.createdAt)}`;

    if (activeDocId !== item.id){
      activeDocId = item.id;
      quill.setContents(item.delta || { ops: [] });
      renderComments();
      refreshCardLinks();
    }
    return;
  }

  if (state.section === "library"){
    editorTitleStatic.textContent = item?.title || "Card";
    editorMeta.textContent = "";
    if (item) fillCardForm(item);
    return;
  }

  if (state.section === "settings"){
    editorTitleStatic.textContent = "Settings";
    editorMeta.textContent = "";
    return;
  }
}

/* ---------- Draft CRUD + rename ---------- */
function makeDefaultChapter(n){
  return {
    id: uid("d"),
    title: `Chapter ${n}`,
    delta: { ops: [{ insert: "\n" }] },
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

function newChapter(){
  const nextNum = state.draft.length + 1;
  const doc = makeDefaultChapter(nextNum);
  state.draft.push(doc);
  state.selectedId = doc.id;
  renderList();
  renderRight();
  saveSoon();
}

function renameChapterFromInput(){
  if (state.section !== "draft") return;
  const doc = getSelectedItem();
  if (!doc) return;

  const v = editorTitleInput.value.trim();
  doc.title = v || doc.title || "Chapter";
  doc.updatedAt = nowISO();
  renderList();
  saveSoon();
}

function deleteSelected(){
  const arr = getCurrentArray();
  const item = getSelectedItem();
  if (!item) return;

  const label = state.section === "draft" ? "this chapter" : "this card";
  if (!confirm(`Delete ${label}?`)) return;

  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) arr.splice(idx, 1);

  if (state.section === "draft"){
    delete state.comments[item.id];
  }

  ensureSelection();
  renderList();
  renderRight();
  saveSoon();

  if (state.section === "draft"){
    syncTopUI();
  } else {
    // if we deleted a card that was previewed, clear inspector
    if (inspectorCardId === item.id) clearInspectorCard();
    // refresh links immediately if we're in draft
    if (state.section === "draft") refreshCardLinks();
  }

  // if card deleted but we are in chapters: refresh links
  if (state.section === "draft") refreshCardLinks();
}

/* ---------- Annotations ---------- */
function getDocComments(docId){
  return state.comments[docId] || [];
}
function setDocComments(docId, list){
  state.comments[docId] = list;
}

function renderComments(){
  const doc = state.draft.find(d => d.id === state.selectedId) || null;
  if (!doc || !quill) return;

  const list = getDocComments(doc.id);
  commentsList.innerHTML = "";
  commentsEmpty.style.display = list.length ? "none" : "block";

  list.forEach(c => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="item-title">💬 ${escapeHtml(c.text).slice(0, 80)}${c.text.length>80?"…":""}</div>
      <div class="item-meta">Range: ${c.index}–${c.index + c.length} · ${fmtTime(c.createdAt)}</div>
      <div class="row" style="margin-top:8px;">
        <button class="btn ghost" data-act="jump">Go</button>
        <button class="btn danger ghost" data-act="del">Delete</button>
      </div>
    `;

    el.querySelector('[data-act="jump"]').addEventListener("click", () => {
      quill.setSelection(c.index, c.length, "api");
      quill.scrollIntoView();
    });
    el.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (!confirm("Delete this annotation?")) return;
      const next = getDocComments(doc.id).filter(x => x.id !== c.id);
      setDocComments(doc.id, next);
      renderComments();
      saveSoon();
    });

    commentsList.appendChild(el);
  });

  applyCommentHighlights();
}

function applyCommentHighlights(){
  const doc = state.draft.find(d => d.id === state.selectedId) || null;
  if (!doc || !quill) return;
  const list = getDocComments(doc.id);
  list.forEach(c => {
    try { quill.formatText(c.index, c.length, { background: "#fef08a" }, "api"); } catch {}
  });
}

function openAnnotateModal(){
  if (state.section !== "draft") return;

  const range = quill.getSelection();
  if (!range || range.length === 0){
    alert("Select a passage to annotate.");
    return;
  }
  const text = quill.getText(range.index, range.length).trim();
  if (!text){
    alert("Empty selection.");
    return;
  }

  modalSelection.textContent = text.slice(0, 900);
  modalComment.value = "";
  modal.dataset.index = String(range.index);
  modal.dataset.length = String(range.length);
  modal.classList.add("show");
  modal.setAttribute("aria-hidden","false");
  modalComment.focus();
}

function closeModal(){
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden","true");
  modal.dataset.index = "";
  modal.dataset.length = "";
}

function saveModalComment(){
  const doc = state.draft.find(d => d.id === state.selectedId) || null;
  if (!doc) return;

  const index = Number(modal.dataset.index);
  const length = Number(modal.dataset.length);
  const text = modalComment.value.trim();
  if (!text) { alert("Write a comment."); return; }

  const list = getDocComments(doc.id);
  list.unshift({ id: uid("c"), index, length, text, createdAt: nowISO() });
  setDocComments(doc.id, list);

  try { quill.formatText(index, length, { background: "#fef08a" }, "api"); } catch {}
  closeModal();
  renderComments();
  saveSoon();
}

function clearAllComments(){
  const doc = state.draft.find(d => d.id === state.selectedId) || null;
  if (!doc) return;
  if (!confirm("Clear all annotations for this chapter?")) return;
  setDocComments(doc.id, []);
  renderComments();
  saveSoon();
}

/* ---------- Library ---------- */
function rebuildCategorySelects(){
  const cats = state.meta.categories && state.meta.categories.length
    ? state.meta.categories
    : ["Characters", "Places"];

  // mid filter
  libraryCategoryFilter.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "All";
  libraryCategoryFilter.appendChild(optAll);

  for (const c of cats){
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    libraryCategoryFilter.appendChild(o);
  }

  // editor select
  cardCategory.innerHTML = "";
  for (const c of cats){
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    cardCategory.appendChild(o);
  }
}

function newCard(prefill = {}, { stayInDraft=false } = {}){
  const cats = state.meta.categories && state.meta.categories.length ? state.meta.categories : ["Characters"];
  const item = {
    id: uid("card"),
    category: prefill.category || cats[0],
    title: prefill.title || "New card",
    fields: prefill.fields || [],
    body: prefill.body || "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };

  state.library.push(item);

  // If created from selection while writing: do NOT force view change.
  if (!stayInDraft){
    state.selectedId = item.id;
    setSection("library");
    renderList();
    renderRight();
  } else {
    // Keep chapter selection; just preview in inspector
    renderList(); // if library is not current, harmless
    openCardInInspector(item.id);
  }

  saveSoon();

  // IMPORTANT: update conditional formatting immediately
  if (state.section === "draft") refreshCardLinks();
}

function fillCardForm(card){
  cardCategory.value = card.category || (state.meta.categories?.[0] || "Characters");
  cardTitle.value = card.title || "";
  cardBody.value = card.body || "";

  fieldsList.innerHTML = "";
  (card.fields || []).forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "mini-item";
    row.innerHTML = `
      <div class="mini-kv"><b>${escapeHtml(f.k)}</b> : ${escapeHtml(f.v)}</div>
      <div class="mini-actions">
        <button class="btn ghost" data-act="edit">Edit</button>
        <button class="btn danger ghost" data-act="del">Del</button>
      </div>
    `;

    row.querySelector('[data-act="edit"]').addEventListener("click", () => {
      fieldKey.value = f.k;
      fieldValue.value = f.v;
      card.fields.splice(idx, 1);
      fillCardForm(card);
      saveSoon();
      // immediate refresh for draft links
      if (state.section === "draft") refreshCardLinks();
    });

    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      card.fields.splice(idx, 1);
      fillCardForm(card);
      saveSoon();
      if (state.section === "draft") refreshCardLinks();
    });

    fieldsList.appendChild(row);
  });
}

function saveCard(){
  const card = state.library.find(x => x.id === state.selectedId) || null;
  if (!card) return;

  card.category = cardCategory.value;
  card.title = cardTitle.value.trim() || card.title || "Card";
  card.body = cardBody.value;
  card.updatedAt = nowISO();

  renderList();
  saveSoon();

  // IMPORTANT: update conditional formatting immediately
  if (quill && state.section === "draft") refreshCardLinks();
  // If we're not in draft, we still want next time to be immediate:
  // We'll keep a short debounce too.
  relinkSoon();

  // keep inspector in sync if previewing this card
  if (inspectorCardId === card.id) renderInspectorCard(card);
}

function addFieldToCard(){
  const card = state.library.find(x => x.id === state.selectedId) || null;
  if (!card) return;

  const k = fieldKey.value.trim();
  const v = fieldValue.value.trim();
  if (!k || !v){
    alert("Fill key and value.");
    return;
  }

  card.fields = card.fields || [];
  card.fields.push({ k, v });
  card.updatedAt = nowISO();

  fieldKey.value = "";
  fieldValue.value = "";

  fillCardForm(card);
  saveSoon();

  // immediate
  if (state.section === "draft") refreshCardLinks();
  relinkSoon();

  if (inspectorCardId === card.id) renderInspectorCard(card);
}

/* ---------- Create card from selection ---------- */
function makeCardFromSelection(){
  if (state.section !== "draft") return;
  const range = quill.getSelection();
  if (!range || range.length === 0){
    alert("Select text to create a card.");
    return;
  }
  const sel = quill.getText(range.index, range.length).trim();
  if (!sel) { alert("Empty selection."); return; }

  const cats = state.meta.categories && state.meta.categories.length ? state.meta.categories : ["Characters"];
  const pick = prompt(`Category?\n\nExamples: ${cats.join(", ")}\n\nEmpty = ${cats[0]}`, "");
  const category = (pick && pick.trim()) ? pick.trim() : cats[0];

  if (!state.meta.categories.includes(category)){
    state.meta.categories.push(category);
    rebuildCategorySelects();
    syncSettingsUI();
  }

  // Create card but stay in draft, and show it in inspector
  const title = sel.slice(0, 80);
  newCard({ category, title, body: sel }, { stayInDraft: true });

  // immediate conditional formatting
  refreshCardLinks();
}

/* ---------- Inspector Card Preview ---------- */
function clearInspectorCard(){
  inspectorCardId = null;
  inspectorCardTitle.textContent = "No card selected";
  inspectorCardMeta.textContent = "";
  inspectorCardFields.innerHTML = "";
  inspectorCardBody.textContent = "";
  inspectorCardEmpty.style.display = "";
  btnOpenInLibrary.style.display = "none";
}

function renderInspectorCard(card){
  inspectorCardEmpty.style.display = "none";
  inspectorCardTitle.textContent = card.title || "(untitled)";
  inspectorCardMeta.textContent = `${card.category || "—"} · Updated: ${fmtTime(card.updatedAt || card.createdAt)}`;

  inspectorCardFields.innerHTML = "";
  (card.fields || []).forEach(f => {
    const row = document.createElement("div");
    row.className = "mini-item";
    row.innerHTML = `<div class="mini-kv"><b>${escapeHtml(f.k)}</b> : ${escapeHtml(f.v)}</div>`;
    inspectorCardFields.appendChild(row);
  });

  inspectorCardBody.textContent = card.body || "";
  btnOpenInLibrary.style.display = "";
}

function openCardInInspector(cardId){
  const card = state.library.find(x => x.id === cardId);
  if (!card) return;

  inspectorCardId = cardId;
  renderInspectorCard(card);
  setInspectorTab("card");

  // button behavior
  btnOpenInLibrary.onclick = () => {
    state.selectedId = cardId;
    setSection("library");
    renderList();
    renderRight();
  };
}

/* ---------- Search ---------- */
function globalSearchRun(q){
  const query = (q||"").trim().toLowerCase();
  if (!query) return;

  const hits = [];

  state.draft.forEach(d => {
    const hay = `${d.title} ${plainTextFromDelta(d.delta)}`.toLowerCase();
    if (hay.includes(query)){
      hits.push({ where:"Chapters", label:d.title, action: () => { state.selectedId = d.id; setSection("draft"); } });
    }
  });

  state.library.forEach(c => {
    const hay = `${c.category} ${c.title} ${c.body||""} ${(c.fields||[]).map(f=>`${f.k}:${f.v}`).join(" ")}`.toLowerCase();
    if (hay.includes(query)){
      hits.push({ where:"Library", label:`${c.category} — ${c.title}`, action: () => {
        // stay in draft if you want; but simplest: open library item
        state.selectedId = c.id; setSection("library");
      }});
    }
  });

  if (!hits.length){
    alert("No results.");
    return;
  }

  const msg = hits.slice(0,25).map((h,i)=>`${i+1}. [${h.where}] ${h.label}`).join("\n");
  const pick = prompt(`Results (${hits.length}) — number?\n\n${msg}`);
  if (!pick) return;
  const idx = Number(pick) - 1;
  if (!hits[idx]) return;
  hits[idx].action();
}

/* ---------- Wipe ---------- */
async function wipeAll(){
  if (!confirm("Wipe local data?")) return;
  await DB.clear();
  location.reload();
}

/* ---------- UI wiring ---------- */
function bindUI(){
  navItems.forEach(b => b.addEventListener("click", () => setSection(b.dataset.section)));

  btnAdd.addEventListener("click", createNewForSection);
  btnNewItem.addEventListener("click", createNewForSection);
  btnDelete.addEventListener("click", deleteSelected);

  listFilter.addEventListener("input", renderList);
  libraryCategoryFilter.addEventListener("change", renderList);

  btnAnnotate.addEventListener("click", openAnnotateModal);
  btnMakeCard.addEventListener("click", makeCardFromSelection);
  btnClearComments.addEventListener("click", clearAllComments);

  modalClose.addEventListener("click", closeModal);
  modalCancel.addEventListener("click", closeModal);
  modalSave.addEventListener("click", saveModalComment);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  editorTitleInput.addEventListener("input", renameChapterFromInput);

  btnExportProject.addEventListener("click", exportProjectFile);
  importFile.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (f) await importProjectFile(f);
    e.target.value = "";
  });

  btnSearch.addEventListener("click", () => globalSearchRun(globalSearch.value));
  globalSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") globalSearchRun(globalSearch.value); });

  projectName.addEventListener("input", () => {
    state.meta.projectName = projectName.value.trim() || "My Novel";
    syncTopUI();
    saveSoon();
  });

  libraryCategories.addEventListener("change", () => {
    const cats = splitComma(libraryCategories.value);
    state.meta.categories = cats.length ? cats : ["Characters", "Places"];
    rebuildCategorySelects();
    saveSoon();
  });

  btnWipeAll.addEventListener("click", wipeAll);

  // Library editor
  btnAddField.addEventListener("click", addFieldToCard);
  btnSaveCard.addEventListener("click", saveCard);

  // Start modal actions
  btnCreateProject.addEventListener("click", () => createNewProject(startProjectName.value));
  startImportFile.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (f) await importProjectFile(f);
    e.target.value = "";
  });

  // Inspector tabs
  inspectorTabs.forEach(b => b.addEventListener("click", () => setInspectorTab(b.dataset.tab)));

  // Shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "s"){
      e.preventDefault(); saveAll();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "k"){
      e.preventDefault(); globalSearch.focus(); globalSearch.select();
    }
  });
}

function createNewForSection(){
  if (state.section === "draft") return newChapter();
  if (state.section === "library") return newCard();
  alert("Create items from Chapters or Library.");
}

/* ---------- Delete selected (chapter/card) ---------- */
function deleteSelected(){
  const arr = getCurrentArray();
  const item = getSelectedItem();
  if (!item) return;

  const label = state.section === "draft" ? "this chapter" : "this card";
  if (!confirm(`Delete ${label}?`)) return;

  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) arr.splice(idx, 1);

  if (state.section === "draft"){
    delete state.comments[item.id];
  } else {
    if (inspectorCardId === item.id) clearInspectorCard();
  }

  ensureSelection();
  renderList();
  renderRight();
  saveSoon();

  // keep links accurate
  if (state.section === "draft") refreshCardLinks();
}

/* ---------- Get arrays + selection helpers ---------- */
function getCurrentArray(){
  if (state.section === "draft") return state.draft;
  if (state.section === "library") return state.library;
  return [];
}
function ensureSelection(){
  const arr = getCurrentArray();
  if (!arr.length){
    state.selectedId = null;
    return;
  }
  if (!arr.some(x => x.id === state.selectedId)) state.selectedId = arr[0].id;
}
function getSelectedItem(){
  return getCurrentArray().find(x => x.id === state.selectedId) || null;
}

/* ---------- Boot ---------- */
async function init(){
  bindUI();
  const ok = await loadAll();
  if (!ok) return; // waiting for start modal

  initQuillOnce();
  setSection("draft");
  renderList();
  renderRight();

  // inspector default state
  setInspectorTab("annotations");
  clearInspectorCard();

  setSaveState("idle");
}
init();
