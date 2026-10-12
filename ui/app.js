'use strict';

const $ = id => document.getElementById(id);
const desktop = window.workstation;
const host = desktop?.mode === 'host';
const icons = {
  files: '<path d="M4 5h6l2 2h8v13H4z"/><path d="M7 12h10M7 16h7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  link: '<path d="m10 13 4-4M8 15l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 1 1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  settings: '<path d="m9 3-.5 2-2 1-2-.5-2 3 1.5 1.5v3L2.5 15l2 3 2-.5 2 1L9 21h4l.5-2.5 2-1 2 .5 2-3-1.5-2v-3L19.5 8l-2-3-2 .5-2-1L13 3z"/><circle cx="11" cy="12" r="3"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-up': '<path d="m6 10 6-6 6 6m-6-6v16"/>',
  chat: '<path d="M21 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  exit: '<path d="M10 4H4v16h6m4-13 5 5-5 5M9 12h10"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'
};
function icon(name) {
  const element = document.createElement('span');
  element.className = 'icon'; element.setAttribute('aria-hidden', 'true');
  element.innerHTML = `<svg viewBox="0 0 24 24">${icons[name] || icons.files}</svg>`;
  return element;
}
document.querySelectorAll('[data-icon]').forEach(element => element.replaceChildren(icon(element.dataset.icon)));
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function actionButton(label, iconName, className, handler) {
  const button = el('button', className);
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  if (iconName) button.append(icon(iconName));
  button.addEventListener('click', handler);
  return button;
}
function initials(name) { return name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase(); }
function avatar(name, guest = false) { return el('span', 'avatar' + (guest ? ' guest' : ''), initials(name)); }
function bytes(value) {
  if (value < 1024) return value + ' B';
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return (value / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][power];
}
function shortDate(timestamp) {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
let state = null;
let currentView = 'files';
let busy = false;
let refreshing = false;
let refreshAgain = false;
let activeInvite = null;
let toastTimer;
let messagesKey = '';
let peopleKey = '';
let filesKey = '';
let ended = false;
let joining = false;
let reconnecting = false;
let transferSequence = 0;

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : '');
  $('toast').hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
async function native(action, input) {
  const response = await desktop.request(action, input);
  if (!response.ok) {
    const error = Object.assign(new Error(response.error), { status: response.status });
    if (error.status === 401 && state && !host) endVisit();
    throw error;
  }
  return response.data;
}
async function run(work) {
  try { return await work(); } catch (error) { toast(error.message, true); }
}

function endVisit(left = false) {
  ended = true; state = null;
  $('app').hidden = true; $('join-screen').hidden = false; $('loading').hidden = true;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('join-form').hidden = false; $('join-error').hidden = true; $('resume-panel').hidden = true;
  $('join-title').textContent = left ? 'You’ve left the workspace.' : 'Your visit has ended.';
  $('join-description').textContent = 'Files you shared stay with the host. Enter a new invitation code below to join again.';
  $('file-list').replaceChildren(); $('messages').replaceChildren(); $('people').replaceChildren();
  $('join-code').value = ''; messagesKey = ''; filesKey = ''; peopleKey = '';
  document.title = 'Visit ended · Workstation';
}

function showLobby(incoming = {}) {
  $('loading').hidden = true; $('app').hidden = true; $('join-screen').hidden = false;
  if (incoming.notice === 'revoked' || incoming.notice === 'left') endVisit(incoming.notice === 'left');
  else {
    $('join-title').textContent = 'Join a workstation.';
    $('join-description').textContent = 'Enter the code your host sent you. This app will connect you to their workspace.';
  }
  if (!$('guest-name').value && incoming.name) $('guest-name').value = incoming.name;
  $('join-form').hidden = Boolean(incoming.resumeAvailable);
  $('resume-panel').hidden = !incoming.resumeAvailable;
  $('join-error').hidden = !incoming.connectionError;
  $('join-error').textContent = incoming.connectionError || '';
}

async function refresh() {
  if (ended) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const incoming = await native('state');
    if (incoming.role === 'lobby') { state = null; showLobby(incoming); return; }
    state = incoming; reconnecting = Boolean(incoming.connectionError); render();
    if (incoming.transfer) renderTransfer(incoming.transfer);
  } catch (error) {
    if (error.status === 401 && state && !host) endVisit();
    else if (state) { reconnecting = true; renderConnection(); }
    else if (host) { $('loading').textContent = 'Could not open the workspace: ' + error.message; }
    else showLobby({ connectionError: error.message });
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; setTimeout(refresh, 100); }
  }
}

function render() {
  if (!state || ended) return;
  $('loading').hidden = true; $('join-screen').hidden = true; $('app').hidden = false;
  document.title = state.name + ' · Workstation';
  $('workspace-name').textContent = state.name;
  $('nav-file-count').textContent = state.files.length;
  $('file-count').textContent = state.files.length;
  $('people-count').textContent = state.participants.length + 1;
  if (host) {
    $('storage-text').textContent = bytes(state.usedBytes) + ' stored · ' + bytes(state.storageAvailable ?? Math.max(0, state.storageLimit - state.usedBytes)) + ' free';
    $('storage-bar').style.width = (state.storageLimit ? Math.min(100, state.usedBytes / state.storageLimit * 100) : 0) + '%';
    $('nav-invite-count').textContent = state.invites.filter(i => i.status === 'pending').length;
  } else {
    $('guest-identity').textContent = state.self.name;
    $('sidebar-footer-text').textContent = 'Shared with you by ' + state.hostName;
  }
  $('upload-limit').textContent = 'Up to ' + bytes(state.maxFileSize) + ' each · disk space permitting';
  renderConnection(); renderPeople(); renderFiles(); renderMessages();
  if (currentView === 'activity') renderActivity();
  if (currentView === 'invites') renderInvites();
}

function renderConnection() {
  if (!state) return;
  const status = reconnecting ? 'error' : host ? state.sharing.status : 'online';
  const online = status === 'online';
  $('connection-badge').className = 'status-badge ' + status;
  $('connection-label').textContent = { online: host ? 'Sharing is on' : 'Connected', connecting: 'Connecting…', offline: 'Sharing off', error: 'Connection interrupted' }[status] || 'Sharing off';
  $('stop-sharing').hidden = !host || !['online', 'connecting'].includes(status);
  $('invite-button').disabled = host && status === 'connecting';
  const error = reconnecting ? 'Connection interrupted. Trying to reconnect with the host’s app…' : host && state.sharing.error;
  $('connection-notice').hidden = !error;
  $('connection-notice').textContent = error || '';
  if (host && !online) {
    $('tip-title').textContent = 'Your space, at your pace.';
    $('tip-text').textContent = 'Add a few files, then invite someone when you’re ready to work together.';
  } else {
    $('tip-title').textContent = 'Come and go. Files stay.';
    $('tip-text').textContent = 'Everything you add is saved in this workspace, ready whenever you need it.';
  }
}

function renderPeople() {
  const key = JSON.stringify([state.hostName, state.self.id, state.participants]);
  if (key === peopleKey) return; peopleKey = key;
  const list = document.createDocumentFragment();
  const all = [{ id: 'host', name: state.hostName, online: true }, ...state.participants];
  for (const person of all) {
    const item = el('div', 'person');
    const av = avatar(person.name, person.id !== 'host');
    av.append(el('span', 'presence' + (person.online ? '' : ' away')));
    const details = el('div', 'person-details');
    details.append(el('div', 'person-name', person.name + (person.id === state.self.id ? ' (you)' : '')));
    details.append(el('div', 'person-role', person.id === 'host' ? 'Workspace owner' : person.online ? 'Here with you' : 'Away · still has access'));
    item.append(av, details);
    if (person.id === 'host') item.append(el('span', 'host-label', 'HOST'));
    else if (host) {
      const button = actionButton('Remove ' + person.name, null, 'remove-guest', () => run(async () => {
        await native('removeGuest', { id: person.id });
        toast(person.name + ' removed. Their files are still here.'); await refresh();
      }));
      button.textContent = 'Remove'; item.append(button);
    }
    list.append(item);
  }
  $('people').replaceChildren(list);
}

function fileKind(name) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase().slice(0, 5) : 'file';
  const category = /^(png|jpg|jpeg|gif|webp|heic|svg|bmp|avif)$/.test(extension) ? 'image' : /^(js|ts|py|json|html|css|c|cpp|go|rs|sh|md)$/.test(extension) ? 'code' : extension === 'pdf' ? 'pdf' : /^(zip|rar|7z|gz|tar)$/.test(extension) ? 'archive' : '';
  return el('span', 'file-kind ' + category, extension.toUpperCase());
}

function renderFiles(force = false) {
  const query = $('file-search').value.trim().toLowerCase();
  const key = JSON.stringify([state.files, query]);
  if (!force && key === filesKey) return; filesKey = key;
  const files = [...state.files].reverse().filter(f => f.name.toLowerCase().includes(query));
  $('empty-files').hidden = state.files.length !== 0;
  $('no-results').hidden = files.length !== 0 || state.files.length === 0;
  $('file-table').hidden = files.length === 0;
  const rows = document.createDocumentFragment();
  for (const file of files) {
    const row = el('tr');
    const first = el('td'); const cell = el('div', 'file-name-cell'); const details = el('div', 'file-details');
    const name = el('span', 'file-name', file.name); name.title = file.name;
    details.append(name, el('div', 'file-author', 'Added by ' + (file.authorId === state.self.id ? 'you' : file.addedBy)));
    cell.append(fileKind(file.name), details); first.append(cell);
    const size = el('td', '', bytes(file.size));
    const date = el('td', '', shortDate(file.addedAt)); date.title = new Date(file.addedAt).toLocaleString();
    const actions = el('td'); const buttons = el('div', 'file-actions');
    buttons.append(actionButton('Save a copy of ' + file.name, 'download', 'icon-button', () => run(async () => {
      if (busy) return;
      clearTransferError(); uploadStatus(true, 'Choose where to save ' + file.name + '…');
      try { if (await native('saveFile', { id: file.id })) toast('Copy saved to your computer.'); }
      catch (error) { transferError(error); }
      finally { uploadStatus(false); }
    })));
    if (host) {
      buttons.append(actionButton('Remove ' + file.name + ' from workspace', 'trash', 'icon-button remove-file', () => run(async () => {
        if (await confirmAction('Remove this file?', '“' + file.name + '” will leave the shared workspace. A recoverable copy stays in the host’s .trash folder.', 'Remove file')) {
          await native('removeFile', { id: file.id }); await refresh(); toast('File removed from the workspace.');
        }
      })));
    }
    actions.append(buttons); row.append(first, size, date, actions); rows.append(row);
  }
  $('file-list').replaceChildren(rows);
}

function renderMessages() {
  const key = state.messages.map(m => m.id).join(',');
  if (key === messagesKey && $('messages').children.length) return;
  messagesKey = key;
  const log = $('messages'); const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const oldScroll = log.scrollTop;
  const list = document.createDocumentFragment();
  if (!state.messages.length) {
    const empty = el('div', 'chat-empty');
    empty.append(el('span', '', '“'), el('strong', '', 'Good things start with a hello.'), el('p', '', 'Leave a note for your guest or pick up the conversation here.'));
    list.append(empty);
  }
  for (const message of state.messages) {
    const item = el('div', 'message' + (message.authorId === state.self.id ? ' mine' : ''));
    const body = el('div', 'message-body'); const meta = el('div', 'message-meta');
    const time = el('time', '', shortDate(message.at)); time.dateTime = new Date(message.at).toISOString();
    meta.append(el('strong', '', message.authorId === state.self.id ? 'You' : message.author), time);
    body.append(meta, el('div', 'message-text', message.text));
    item.append(avatar(message.author, message.authorId !== 'host'), body); list.append(item);
  }
  log.replaceChildren(list);
  if (atEnd || !oldScroll) log.scrollTop = log.scrollHeight; else log.scrollTop = oldScroll;
}

function renderActivity() {
  const list = document.createDocumentFragment();
  if (!state.activity.length) list.append(el('div', 'list-empty', 'A fresh workspace. Add a file or invite someone to get started.'));
  for (const entry of state.activity) {
    const item = el('div', 'activity-item'); const copy = el('div');
    copy.append(el('p', '', entry.text), el('time', '', new Date(entry.at).toLocaleString()));
    item.append(el('span', 'activity-dot'), copy); list.append(item);
  }
  $('activity-list').replaceChildren(list);
}

function renderInvites() {
  if (!host) return;
  const list = document.createDocumentFragment();
  if (!state.invites.length) list.append(el('div', 'list-empty', 'Bring someone into your workspace. Create a single-use invitation to get started.'));
  for (const invite of state.invites) {
    const item = el('div', 'invite-item'); const symbol = el('span', 'invite-item-icon'); symbol.append(icon('link'));
    const copy = el('div', 'invite-item-copy');
    copy.append(el('strong', '', invite.status === 'used' ? 'Claimed by ' + invite.usedBy : invite.status === 'pending' ? 'Ready for one guest' : invite.status === 'revoked' ? 'Invitation canceled' : 'Invitation expired'));
    copy.append(el('p', '', invite.status === 'pending' ? 'Expires ' + shortDate(invite.expiresAt) : 'A new invitation is needed to join again.'));
    const actions = el('div', 'invite-actions');
    if (invite.status === 'pending') {
      const copyButton = actionButton('Copy invitation', 'copy', 'button secondary', () => run(async () => { await native('copyInvite', { id: invite.id }); toast('Invitation copied. Send it to your guest.'); }));
      copyButton.append(document.createTextNode('Copy'));
      actions.append(copyButton, actionButton('Cancel invitation', 'x', 'icon-button', () => run(async () => { await native('cancelInvite', { id: invite.id }); await refresh(); toast('Invitation canceled.'); })));
    } else actions.append(el('span', 'invite-status ' + invite.status, invite.status));
    item.append(symbol, copy, actions); list.append(item);
  }
  $('invite-list').replaceChildren(list);
}

function setView(view) {
  if (!['files', 'activity', 'invites'].includes(view) || (view === 'invites' && !host)) return;
  currentView = view;
  for (const name of ['files', 'activity', 'invites']) $(name + '-view').hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('current-view').textContent = { files: 'Shared files', activity: 'Activity', invites: 'Invitations' }[view];
  const titles = { files: ['GOOD WORK STARTS HERE', 'A little space. A lot of possibility.', 'Bring your files and your people. Make something together.'], activity: ['THE WORK, AS IT HAPPENS', 'A little momentum.', 'See what’s been shared and who’s stopped by.'], invites: ['BETTER WITH GOOD COMPANY', 'Your people. Your invitation.', 'A small welcome, with you in control.'] };
  const [eyebrow, title, description] = titles[view];
  $('page-eyebrow').textContent = eyebrow; $('page-title').textContent = title; $('page-description').textContent = description;
  if (state) render();
}

async function inviteGuest() {
  if (!host) return;
  if (!$('invite-dialog').open) $('invite-dialog').showModal();
  $('invite-connecting').hidden = false; $('invite-ready').hidden = true; $('invite-error').hidden = true; $('retry-invite').hidden = true;
  try {
    if (!state || state.sharing.status !== 'online') await native('startSharing');
    activeInvite = await native('createInvite');
    $('invite-code').value = activeInvite.code;
    $('invite-ready').hidden = false;
    $('invite-code').focus(); $('invite-code').select();
    await refresh();
  } catch (error) {
    $('invite-error').textContent = error.message; $('invite-error').hidden = false; $('retry-invite').hidden = false;
  } finally { $('invite-connecting').hidden = true; }
}

function confirmAction(title, description, label) {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-yes').textContent = label;
  const dialog = $('confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
  $('confirm-cancel').focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}

function uploadStatus(active, text = '', percent = null) {
  busy = active; $('upload-progress').hidden = !active; $('upload-button').disabled = active; $('folder-button').disabled = active; $('empty-upload').disabled = active;
  $('upload-label').textContent = text;
  $('upload-detail').textContent = ''; $('cancel-transfer').hidden = true;
  if (percent === null) $('upload-meter').removeAttribute('value'); else $('upload-meter').value = percent;
}

function clearTransferError() { $('transfer-error').hidden = true; $('transfer-error').textContent = ''; }
function transferError(error) {
  if (error.status === 499) { toast('Transfer canceled.'); return; }
  $('transfer-error').textContent = error.message; $('transfer-error').hidden = false;
  toast(error.message, true);
}
function renderTransfer(value) {
  // A state poll can arrive after the transfer's completion event.
  if (Number.isInteger(value.sequence)) {
    if (value.sequence <= transferSequence) return;
    transferSequence = value.sequence;
  }
  if (value.phase === 'idle') { uploadStatus(false); return; }
  const verb = { scanning: 'Scanning', copying: 'Copying', uploading: 'Uploading', downloading: 'Downloading', checking: 'Checking saved progress for', finishing: 'Finishing', complete: 'Finished', retrying: 'Reconnecting to resume' }[value.phase] || '';
  uploadStatus(true, (verb ? verb + ' ' : '') + value.name, value.percent ?? null);
  $('cancel-transfer').hidden = false; $('cancel-transfer').disabled = false;
  if (value.phase === 'scanning') $('upload-detail').textContent = (value.files || 0).toLocaleString() + ' items found · ' + bytes(value.bytes || 0);
  else if (Number.isFinite(value.total)) {
    const detail = [bytes(value.bytes || 0) + ' of ' + bytes(value.total), (value.percent || 0) + '%'];
    if (value.phase === 'retrying') detail.push('Retry ' + value.attempt + ' of 5');
    else if (value.phase === 'finishing') detail.push('Saving and verifying…');
    else if (value.bytesPerSecond > 0 && !['checking', 'complete'].includes(value.phase)) {
      detail.push(bytes(value.bytesPerSecond) + '/s');
      const seconds = value.secondsRemaining;
      if (seconds > 0) detail.push(seconds >= 3600 ? Math.ceil(seconds / 3600) + ' hr left' : seconds >= 60 ? Math.ceil(seconds / 60) + ' min left' : Math.ceil(seconds) + ' sec left');
    }
    $('upload-detail').textContent = detail.join(' · ');
  }
}
function importedMessage(imported) {
  const skipped = imported.reduce((count, file) => count + (file.skipped || 0), 0);
  if (skipped) {
    $('transfer-error').textContent = 'Files added. Skipped ' + skipped + ' symbolic links, special files, or workspace storage folders.';
    $('transfer-error').hidden = false;
  }
  if (imported.length) toast(imported.length === 1 ? 'File added to the workspace.' : imported.length + ' files added to the workspace.');
}

async function chooseFiles(folder = false) {
  if (busy) return;
  clearTransferError(); uploadStatus(true, folder === true ? 'Choose a folder…' : 'Choose files…');
  try {
    const imported = await native(folder === true ? 'importFolder' : 'importFiles');
    await refresh(); importedMessage(imported);
  } catch (error) { transferError(error); }
  finally { uploadStatus(false); }
}

async function uploadFiles(fileList) {
  if (busy || !fileList.length) return;
  const files = Array.from(fileList);
  clearTransferError(); uploadStatus(true, 'Adding files…', 0);
  try {
    const result = await desktop.droppedFiles(files);
    if (!result.ok) { if (result.status === 401) endVisit(); throw Object.assign(new Error(result.error), { status: result.status }); }
    await refresh(); importedMessage(result.data);
  } catch (error) { if (!ended) transferError(error); }
  finally { uploadStatus(false); }
}

document.querySelectorAll('.host-only').forEach(element => { element.hidden = !host; });
document.querySelectorAll('.guest-only').forEach(element => { element.hidden = host; });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); setView('files'); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
for (const id of ['invite-button', 'sidebar-invite', 'new-invite', 'retry-invite']) $(id).addEventListener('click', inviteGuest);
$('copy-invite').addEventListener('click', () => run(async () => {
  if (!activeInvite) return;
  await native('copyInvite', { id: activeInvite.id }); toast('Invitation copied. Send it to your guest.');
}));
$('invite-code').addEventListener('click', () => $('invite-code').select());
$('save-guest-app').addEventListener('click', () => run(async () => {
  if (await native('saveGuestApp')) toast('Windows app saved. Send that download to your guest.');
}));
$('stop-sharing').addEventListener('click', () => run(async () => { await native('stopSharing'); await refresh(); toast('Session ended. Guests are disconnected; your files are saved.'); }));
$('open-folder').addEventListener('click', () => run(() => native('openFolder')));
$('settings-button').addEventListener('click', () => {
  $('setting-name').value = state.name; $('setting-host').value = state.hostName; $('setting-storage').textContent = state.storagePath; $('settings-dialog').showModal();
});
$('settings-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  await native('settings', { name: $('setting-name').value, hostName: $('setting-host').value });
  $('settings-dialog').close(); await refresh(); toast('Workspace details saved.');
}); });
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('no'));
$('confirm-yes').addEventListener('click', () => $('confirm-dialog').close('yes'));
$('file-search').addEventListener('input', () => { if (state) renderFiles(); });
for (const id of ['upload-button', 'empty-upload', 'drop-zone']) $(id).addEventListener('click', chooseFiles);
$('folder-button').addEventListener('click', () => chooseFiles(true));
$('cancel-transfer').addEventListener('click', () => run(async () => {
  $('cancel-transfer').disabled = true; $('upload-label').textContent = 'Canceling transfer…';
  await native('cancelTransfer');
}));
$('drop-zone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseFiles(); } });
for (const eventName of ['dragenter', 'dragover']) document.addEventListener(eventName, event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); if (state && !busy) $('drop-zone').classList.add('dragging');
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('drop-zone').classList.remove('dragging'); });
document.addEventListener('drop', event => {
  event.preventDefault(); $('drop-zone').classList.remove('dragging');
  if (state && !busy) { setView('files'); uploadFiles(event.dataTransfer.files, true); }
});
$('chat-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const text = $('message-input').value.trim(); if (!text || $('send-message').disabled) return;
  $('send-message').disabled = true;
  try {
    await native('sendMessage', { text });
    if ($('message-input').value.trim() === text) $('message-input').value = '';
    await refresh(); $('messages').scrollTop = $('messages').scrollHeight; $('message-input').focus();
  } finally { $('send-message').disabled = false; }
}); });
$('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('leave-button').addEventListener('click', () => run(async () => { await native('leave'); endVisit(true); }));
$('join-form').addEventListener('submit', event => { event.preventDefault(); if (joining) return; joining = true; run(async () => {
  $('join-error').hidden = true; $('join-button').disabled = true;
  try {
    state = await native('join', { code: $('join-code').value, name: $('guest-name').value });
    $('join-code').value = ''; ended = false; messagesKey = ''; peopleKey = ''; filesKey = ''; setView('files');
  } catch (error) { $('join-error').textContent = error.message; $('join-error').hidden = false; }
  finally { $('join-button').disabled = false; joining = false; }
}); });

async function boot() {
  if (!desktop) { $('loading').textContent = 'Open the Workstation desktop app to join.'; return; }
  desktop.onChange(() => { if (!refreshing) refresh(); else refreshAgain = true; });
  desktop.onProgress(renderTransfer);
  await refresh();
  if (!host && !state) $('join-code').focus();
  setInterval(() => { if (state && !ended) refresh(); }, host ? 2500 : 1500);
}
$('resume-session').addEventListener('click', () => run(async () => { ended = false; await refresh(); }));
$('forget-session').addEventListener('click', () => run(async () => { await native('forgetSession'); ended = false; await refresh(); }));
boot();
