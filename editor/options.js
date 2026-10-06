// "More options" on the create form and edit dialog: scan counting, turning
// off on a date (with a message), and routing rules by device and time.
// Builds its own fields inside a <details> element; no network here.
import { checkRoutes, MESSAGE_MAX, ROUTES_MAX } from './links.js';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

// "Pacific Time (America/Los Angeles)", or just the ID where browsers can't name it.
function zoneLabel(zone) {
  let name = '';
  try {
    name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { /* older browsers */ }
  const id = zone.replace(/_/g, ' ');
  return name && !/^GMT/.test(name) ? `${name} (${id})` : id;
}
let zoneLabels = null; // built once, on first use: [[id, label]]
function allZones() {
  if (!zoneLabels) {
    let ids = [];
    try { ids = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers: just the current zone */ }
    zoneLabels = new Map(ids.map((z) => [z, zoneLabel(z)]));
  }
  return zoneLabels;
}

// <input type="datetime-local"> works in the browser's local time.
const pad = (n) => String(n).padStart(2, '0');
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (text) => (text ? new Date(text).getTime() : 0);

const isDeviceRule = (r) => Object.keys(r).every((k) => k === 'to' || k === 'os') && r.os;
const isTimeRule = (r) => !r.os && Object.keys(r).every((k) => ['to', 'days', 'from', 'until', 'after', 'before'].includes(k));

let uid = 0;

export function optionsFields(details) {
  const id = (name) => `${details.id}-${name}`;
  const summary = h('summary', {}, 'More options', h('span', { class: 'muted small summary-note' }));

  // Scan counting
  const count = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', id: id('count') });
  const countBox = h('div', { class: 'opt' },
    h('label', { class: 'switch' }, count, ' Count scans'),
    h('p', { class: 'muted small' }, 'See how many times the code is scanned. Only a daily total is kept, nothing about who scanned.'));

  // Turn off on a date, with a message
  const offOn = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', id: id('off-on') });
  const offAt = h('input', { type: 'datetime-local', id: id('off-at'), 'aria-label': 'Turn off at' });
  const offAtRow = h('div', { hidden: true }, h('label', {}, 'Turn off at', offAt));
  const message = h('input', { id: id('message'), maxlength: MESSAGE_MAX, placeholder: 'This event has ended. Thanks for coming!' });
  const offBox = h('div', { class: 'opt' },
    h('label', { class: 'switch' }, offOn, ' Turn off automatically'),
    offAtRow,
    h('label', {}, 'Message when the link is off ', h('span', { class: 'muted' }, '(optional, public)'), message));

  // Device and time rules (not with password protection: rules are public)
  const ios = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', id: id('ios'), placeholder: 'https://apps.apple.com/…' });
  const android = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', id: id('android'), placeholder: 'https://play.google.com/…' });
  const timeList = h('div', { class: 'time-rules' });
  const zone = h('select', { id: id('tz') });
  const zoneBox = h('label', { class: 'zone' }, 'Time zone for these days and times', zone,
    h('span', { class: 'muted small hint' }, 'Rules follow this time zone no matter where people scan from. It defaults to your device’s current time zone.'));
  const addTime = h('button', { type: 'button', class: 'link', onclick: () => { addTimeRule({}); updateNote(); } }, 'Add a different link for certain days or times');
  const keptNote = h('p', { class: 'muted small', hidden: true });
  const lockedNote = h('p', { class: 'muted small', hidden: true }, 'Different links by device or time aren’t available with Password protect, because they would be public.');
  const routesBox = h('div', { class: 'opt routes' },
    h('p', { class: 'opt-title' }, 'Advanced routing'),
    h('p', { class: 'muted small' }, 'Point to a different destination based on device type or day and time. Everyone goes to the main destination ', h('strong', {}, 'unless'), ' one of the following is true:'),
    h('label', {}, 'iPhone and iPad users', ios),
    h('label', {}, 'Android users', android),
    timeList, zoneBox, addTime, keptNote);
  const error = h('p', { class: 'error', hidden: true });

  details.classList.add('advanced');
  details.replaceChildren(summary, h('div', { class: 'advanced-body' }, countBox, offBox, lockedNote, routesBox, error));

  let kept = []; // rules this form can't show (e.g. made with the CLI), saved unchanged

  function addTimeRule(rule) {
    const n = ++uid;
    const days = DAYS.map((d, i) => h('label', { class: 'day' },
      h('input', { type: 'checkbox', value: String(i), checked: rule.days ? rule.days.includes(String(i)) : i >= 1 && i <= 5 }), d));
    const from = h('input', { type: 'time', value: rule.from || '', 'aria-label': 'From' });
    const until = h('input', { type: 'time', value: rule.until || '', 'aria-label': 'Until' });
    const after = h('input', { type: 'datetime-local', value: toLocalInput(rule.after), 'aria-label': 'Starting' });
    const before = h('input', { type: 'datetime-local', value: toLocalInput(rule.before), 'aria-label': 'Ending' });
    const to = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: rule.to || '', placeholder: 'https://example.com/lunch-menu' });
    const box = h('fieldset', { class: 'time-rule', 'data-rule': n },
      h('legend', {}, 'Certain days or times'),
      h('div', { class: 'days' }, days),
      h('div', { class: 'pair' }, h('label', {}, 'From', from), h('label', {}, 'Until', until)),
      h('p', { class: 'muted small hint' }, 'Leave From and Until empty for the whole day.'),
      h('div', { class: 'pair dates' }, h('label', {}, 'Starting ', h('span', { class: 'muted' }, '(optional)'), after), h('label', {}, 'Ending ', h('span', { class: 'muted' }, '(optional)'), before)),
      h('label', {}, 'Send people to', to),
      h('button', { type: 'button', class: 'link', onclick: () => { box.remove(); updateNote(); } }, 'Remove'));
    box.read = () => ({
      to: to.value.trim(),
      days: days.filter((d) => d.firstChild.checked).map((d) => d.firstChild.value).join('') || 'none',
      from: from.value, until: until.value,
      after: fromLocalInput(after.value) || null, before: fromLocalInput(before.value) || null,
    });
    timeList.append(box);
  }

  function updateNote() {
    const rules = timeList.children.length;
    addTime.hidden = rules + 2 + kept.length >= ROUTES_MAX;
    zoneBox.hidden = !rules;
  }

  function updateSummary() {
    const on = [];
    if (count.checked) on.push('counting scans');
    if (offOn.checked && offAt.value) on.push('turns off on a date');
    if (ios.value.trim() || android.value.trim() || timeList.children.length || kept.length) on.push('different links');
    summary.querySelector('.summary-note').textContent = on.length ? ` · ${on.join(', ')}` : '';
  }
  details.addEventListener('input', updateSummary);
  details.addEventListener('change', updateSummary);
  details.addEventListener('click', () => setTimeout(updateSummary));
  offOn.addEventListener('change', () => {
    offAtRow.hidden = !offOn.checked;
    if (offOn.checked && !offAt.value) offAt.value = toLocalInput(Date.now() + 7 * 864e5).slice(0, 11) + '00:00';
  });

  return {
    // Throws a readable error if something can't be saved.
    read({ locked = false } = {}) {
      error.hidden = true;
      try {
        const routes = locked ? [] : [
          ...(ios.value.trim() ? [{ os: 'ios', to: ios.value }] : []),
          ...(android.value.trim() ? [{ os: 'android', to: android.value }] : []),
          ...[...timeList.children].map((box) => {
            const r = box.read();
            if (r.days === 'none') throw new Error('Pick at least one day for each time-based link.');
            return r;
          }),
          ...kept,
        ];
        const off = offOn.checked ? fromLocalInput(offAt.value) : 0;
        if (offOn.checked && !off) throw new Error('Choose when the link turns off.');
        const checked = checkRoutes(routes);
        return {
          count: count.checked,
          offAt: off,
          message: message.value.trim(),
          routes: checked,
          tz: checked.some((r) => r.days || r.from || r.until) ? (zone.value || browserZone()) : '',
        };
      } catch (err) {
        details.open = true;
        throw err;
      }
    },
    set(state = {}, { locked = false } = {}) {
      count.checked = !!state.count;
      offOn.checked = !!state.offAt;
      offAtRow.hidden = !state.offAt;
      offAt.value = toLocalInput(state.offAt);
      message.value = state.message || '';
      const current = state.tz || browserZone();
      const labels = allZones();
      const zones = [...new Set([current, ...labels.keys()])].filter(Boolean).sort();
      zone.replaceChildren(...zones.map((z) => h('option', { value: z, selected: z === current }, labels.get(z) || zoneLabel(z))));
      const routes = state.routes || [];
      const iosRule = routes.find((r) => isDeviceRule(r) && r.os === 'ios');
      const androidRule = routes.find((r) => isDeviceRule(r) && r.os === 'android');
      ios.value = iosRule?.to || '';
      android.value = androidRule?.to || '';
      timeList.replaceChildren();
      for (const r of routes.filter(isTimeRule)) addTimeRule(r);
      kept = routes.filter((r) => r !== iosRule && r !== androidRule && !isTimeRule(r));
      keptNote.hidden = !kept.length;
      keptNote.textContent = `${kept.length} more rule${kept.length === 1 ? '' : 's'} set up elsewhere (like the command line) will be kept as they are.`;
      this.setLocked(locked);
      updateNote();
      updateSummary();
      details.open = false;
    },
    setLocked(locked) {
      routesBox.hidden = locked;
      lockedNote.hidden = !locked;
    },
  };
}
